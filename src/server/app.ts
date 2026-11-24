import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadConfig, recordRecentRepo, saveConfig } from './core/configStore.js';
import type { ClipboardWatcher } from './core/clipboardWatcher.js';
import { parseAndPreviewPatch } from './core/patchEngine.js';
import { PathSecurityError } from './core/pathGuard.js';
import { buildPackResponse } from './core/promptBuilder.js';
import { detectGitInfo, listLocalDirectories, scanRepositoryTree } from './core/repoScanner.js';
import { applySelectedFiles, listSnapshots, undoSnapshot } from './core/snapshotManager.js';

export interface ServerState {
  repoPath: string;
  sessionToken: string;
  watcher: ClipboardWatcher;
  broadcastWatcherStatus: () => void;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const PackSchema = z.object({
  selectedPaths: z.array(z.string().min(1)).min(1),
  preset: z.enum(['bug_fix', 'add_feature', 'improve_code', 'review_code']),
  taskDescription: z.string().min(1).max(25_000),
  errorLog: z.string().max(60_000).optional(),
  patchFormatPreference: z.enum(['search_replace', 'unified_diff']),
  redactSecrets: z.boolean().default(true),
  mode: z.enum(['inline_copy', 'file_attachment']),
});

const ParseSchema = z.object({
  rawText: z.string().min(10).max(5_000_000),
});

const ApplySchema = z.object({
  parseId: z.string().min(1),
  selectedFilePaths: z.array(z.string().min(1)).min(1),
});

const OpenRepoSchema = z.object({
  repoPath: z.string().min(1),
});

const ToggleWatcherSchema = z.object({
  enabled: z.boolean(),
});

export function isValidLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return /^(localhost|127.0.0.1)(:\d+)?$/i.test(hostHeader.trim());
}

export function verifySessionToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp(state: ServerState): Hono {
  const app = new Hono();

  // Security middleware: localhost Host allowlist + constant-time token auth on /api/*
  app.use('*', async (c, next) => {
    if (!isValidLocalHost(c.req.header('host'))) {
      return c.json({ error: 'FORBIDDEN_HOST', message: 'Localhost access only.' }, 403);
    }
    if (c.req.path.startsWith('/api/')) {
      const provided = c.req.header('x-chat2diff-token');
      if (!verifySessionToken(provided, state.sessionToken)) {
        return c.json({ error: 'UNAUTHORIZED', message: 'Missing or invalid session token.' }, 401);
      }
    }
    await next();
  });

  // 1. Workspace info
  app.get('/api/v1/workspace', (c) => {
    const git = detectGitInfo(state.repoPath);
    const config = loadConfig();
    const watch = state.watcher.getStatus();
    return c.json({
      data: {
        repoPath: state.repoPath,
        repoName: path.basename(state.repoPath),
        isGitRepo: git.isGitRepo,
        gitBranch: git.gitBranch,
        clipboardWatchEnabled: watch.enabled,
        clipboardAvailable: watch.available,
        recentRepos: config.recentRepos,
      },
    });
  });

  // 2. Visual local directory browser
  app.get('/api/v1/filesystem/list', (c) => {
    try {
      const dir = c.req.query('dir') || path.dirname(state.repoPath);
      return c.json({ data: listLocalDirectories(dir) });
    } catch (err) {
      return c.json(
        { error: 'INVALID_PATH', message: err instanceof Error ? err.message : 'Cannot read folder.' },
        400
      );
    }
  });

  // 3. Switch active project folder
  app.post('/api/v1/workspace/open', async (c) => {
    const parsed = OpenRepoSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Valid project folder path is required.' }, 400);
    }
    const target = path.resolve(parsed.data.repoPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return c.json({ error: 'INVALID_REPO', message: 'Selected path is not an accessible folder.' }, 400);
    }
    state.repoPath = target;
    recordRecentRepo(target);
    const git = detectGitInfo(target);
    return c.json({
      data: {
        repoPath: target,
        repoName: path.basename(target),
        isGitRepo: git.isGitRepo,
        gitBranch: git.gitBranch,
      },
    });
  });

  // 4. File tree scan
  app.get('/api/v1/files/tree', (c) => {
    try {
      return c.json({ data: scanRepositoryTree(state.repoPath) });
    } catch (err) {
      return c.json(
        { error: 'SCAN_FAILED', message: err instanceof Error ? err.message : 'Failed to scan folder.' },
        500
      );
    }
  });

  // 5. Pack selected files + task into prompt / downloadable .txt
  app.post('/api/v1/pack', async (c) => {
    const parsed = PackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'Select at least one file and describe your task.' },
        400
      );
    }
    try {
      const result = buildPackResponse(state.repoPath, parsed.data);
      return c.json({ data: result });
    } catch (err) {
      if (err instanceof PathSecurityError) {
        return c.json({ error: 'PATH_FORBIDDEN', message: err.message }, 403);
      }
      return c.json(
        { error: 'PACK_FAILED', message: err instanceof Error ? err.message : 'Packing failed.' },
        500
      );
    }
  });

  // 6. Parse & preview AI reply
  app.post('/api/v1/patch/parse', async (c) => {
    const parsed = ParseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Paste an AI response containing code changes.' }, 400);
    }
    const result = parseAndPreviewPatch(state.repoPath, parsed.data.rawText);
    if (!result) {
      return c.json(
        {
          error: 'NO_PATCH_FOUND',
          message: 'No recognizable code edits were found. Make sure you copied the full AI reply.',
        },
        400
      );
    }
    return c.json({ data: result });
  });

  // 7. Apply selected changes safely
  app.post('/api/v1/patch/apply', async (c) => {
    const parsed = ApplySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Select at least one file to apply.' }, 400);
    }
    try {
      const result = applySelectedFiles(
        state.repoPath,
        parsed.data.parseId,
        parsed.data.selectedFilePaths
      );
      return c.json({ data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Apply failed.';
      if (msg.startsWith('FILE_CHANGED_ON_DISK:')) {
        return c.json({ error: 'FILE_CHANGED_ON_DISK', message: msg.slice(21).trim() }, 409);
      }
      if (err instanceof PathSecurityError) {
        return c.json({ error: 'PATH_FORBIDDEN', message: msg }, 403);
      }
      return c.json({ error: 'APPLY_ERROR', message: msg.replace(/^[A-Z_]+:\s*/, '') }, 400);
    }
  });

  // 8. History & 1-click Undo
  app.get('/api/v1/history', (c) => {
    return c.json({ data: { snapshots: listSnapshots(state.repoPath) } });
  });

  app.post('/api/v1/history/:snapshotId/undo', (c) => {
    try {
      const result = undoSnapshot(state.repoPath, c.req.param('snapshotId'));
      return c.json({ data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Undo failed.';
      if (msg.startsWith('NOT_FOUND:')) {
        return c.json({ error: 'NOT_FOUND', message: msg.slice(10).trim() }, 404);
      }
      if (msg.startsWith('ALREADY_REVERTED:')) {
        return c.json({ error: 'ALREADY_REVERTED', message: msg.slice(17).trim() }, 409);
      }
      return c.json({ error: 'UNDO_ERROR', message: msg }, 400);
    }
  });

  // 9. Toggle clipboard watcher
  app.post('/api/v1/watcher/toggle', async (c) => {
    const parsed = ToggleWatcherSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Boolean enabled flag required.' }, 400);
    }
    const status = state.watcher.setEnabled(parsed.data.enabled);
    const config = loadConfig();
    config.clipboardWatchEnabled = status.enabled;
    saveConfig(config);
    state.broadcastWatcherStatus();
    return c.json({ data: status });
  });

  // 10. Static SPA serving in production (resolves relative to compiled dist/cli.js)
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(currentDir, 'public');

  app.get('*', (c) => {
    if (!fs.existsSync(publicDir)) {
      return c.text('Chat2Diff API is running. In dev mode, open http://localhost:5173', 200);
    }
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const candidate = path.resolve(publicDir, reqPath.replace(/^\/+/, ''));
    const safeFile =
      candidate.startsWith(publicDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : path.join(publicDir, 'index.html');

    const ext = path.extname(safeFile).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const body = fs.readFileSync(safeFile);
    return new Response(body, { status: 200, headers: { 'Content-Type': mime } });
  });

  return app;
}
