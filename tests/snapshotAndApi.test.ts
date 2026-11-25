import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { ClipboardWatcher } from '../src/server/core/clipboardWatcher.js';

const SR_START = '<'.repeat(7) + ' SEARCH';
const SR_MID = '='.repeat(7);
const SR_END = '>'.repeat(7) + ' REPLACE';

describe('Hono API & snapshot lifecycle', () => {
  let repoDir: string;
  let configDir: string;
  let prevConfigDir: string | undefined;
  const sessionToken = 'test-session-token-123456';

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2diff-api-repo-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2diff-api-cfg-'));
    prevConfigDir = process.env.CHAT2DIFF_CONFIG_DIR;
    process.env.CHAT2DIFF_CONFIG_DIR = configDir;

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'app.ts'),
      'export const version = 1;\nexport const label = "alpha";\n',
      'utf8'
    );
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CHAT2DIFF_CONFIG_DIR;
    else process.env.CHAT2DIFF_CONFIG_DIR = prevConfigDir;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function makeTestApp() {
    const ignored: string[] = [];
    const mockWatcher = {
      ignoreText: (t: string) => ignored.push(t),
      getStatus: () => ({ enabled: true, available: true }),
      setEnabled: (enabled: boolean) => ({ enabled, available: true }),
    } as unknown as ClipboardWatcher;

    const app = createApp({
      repoPath: repoDir,
      sessionToken,
      watcher: mockWatcher,
      broadcastWatcherStatus: () => {},
    });

    const headers = {
      host: '127.0.0.1:4310',
      'content-type': 'application/json',
      'x-chat2diff-token': sessionToken,
    };

    return { app, headers, ignored };
  }

  it('enforces localhost Host allowlist and session token auth', async () => {
    const { app } = makeTestApp();

    const badHost = await app.request('/api/v1/workspace', {
      headers: { host: 'evil.example.com', 'x-chat2diff-token': sessionToken },
    });
    expect(badHost.status).toBe(403);

    const noToken = await app.request('/api/v1/workspace', {
      headers: { host: '127.0.0.1:4310' },
    });
    expect(noToken.status).toBe(401);

    const valid = await app.request('/api/v1/workspace', {
      headers: { host: '127.0.0.1:4310', 'x-chat2diff-token': sessionToken },
    });
    expect(valid.status).toBe(200);
  });

  it('completes pack -> parse -> apply -> conflict check -> 1-click undo cleanly', async () => {
    const { app, headers, ignored } = makeTestApp();

    // 1. Pack (file attachment all-in-one)
    const packRes = await app.request('/api/v1/pack', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        selectedPaths: ['src/app.ts'],
        preset: 'add_feature',
        taskDescription: 'Bump version to 2',
        patchFormatPreference: 'search_replace',
        redactSecrets: true,
        mode: 'file_attachment',
        chatMode: 'new_chat',
        fileBundleStyle: 'all_in_one',
        copyFileToClipboard: false,
      }),
    });
    expect(packRes.status).toBe(200);
    const packJson = (await packRes.json()) as {
      data: { cachedFilePath?: string; contextFileContent?: string };
    };
    expect(packJson.data.cachedFilePath).toBeTruthy();
    expect(fs.existsSync(packJson.data.cachedFilePath!)).toBe(true);
    expect(ignored.length).toBeGreaterThan(0);

    // 2. Parse
    const rawPatch = [
      'FILE: src/app.ts',
      SR_START,
      'export const version = 1;',
      'export const label = "alpha";',
      SR_MID,
      'export const version = 2;',
      'export const label = "beta";',
      SR_END,
    ].join('\n');

    const parseRes = await app.request('/api/v1/patch/parse', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawText: rawPatch }),
    });
    expect(parseRes.status).toBe(200);
    const parseJson = (await parseRes.json()) as { data: { parseId: string } };
    const parseId = parseJson.data.parseId;

    // 3. Apply
    const applyRes = await app.request('/api/v1/patch/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify({ parseId, selectedFilePaths: ['src/app.ts'] }),
    });
    expect(applyRes.status).toBe(200);
    const applyJson = (await applyRes.json()) as { data: { snapshotId: string } };
    const snapshotId = applyJson.data.snapshotId;

    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain(
      'export const version = 2;'
    );

    // 4. External disk edit triggers 409 conflict on stale re-apply
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const version = 99;\n', 'utf8');
    const conflictRes = await app.request('/api/v1/patch/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify({ parseId, selectedFilePaths: ['src/app.ts'] }),
    });
    expect(conflictRes.status).toBe(409);

    // 5. Undo restores exact original pre-apply bytes
    const undoRes = await app.request(`/api/v1/history/${snapshotId}/undo`, {
      method: 'POST',
      headers,
    });
    expect(undoRes.status).toBe(200);
    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toBe(
      'export const version = 1;\nexport const label = "alpha";\n'
    );
  });
});