import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import {
  MAX_FILE_SIZE_BYTES,
  SKIP_DIRECTORIES,
  SKIP_EXTENSIONS,
  SKIP_FILENAMES,
} from '../../shared/constants.js';
import type {
  DirectoryEntry,
  DirectoryListResponse,
  FileTreeNode,
  FileTreeResponse,
} from '../../shared/types.js';
import { isSecretFilename } from './secretGuard.js';

export function detectGitInfo(repoPath: string): { isGitRepo: boolean; gitBranch: string | null } {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') return { isGitRepo: false, gitBranch: null };

    let branch: string | null = null;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      branch = 'main';
    }
    return { isGitRepo: true, gitBranch: branch || null };
  } catch {
    return { isGitRepo: false, gitBranch: null };
  }
}

function isBinaryBuffer(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function collectFilesViaGit(repoPath: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    return output
      .split('\0')
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, '/'));
  } catch {
    return null;
  }
}

function collectFilesViaFs(repoPath: string): string[] {
  const ig = ignore();
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch {
      // ignore unreadable .gitignore
    }
  }

  const found: string[] = [];

  function walk(currentDir: string, relPrefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || ig.ignores(`${relPosix}/`)) continue;
        walk(path.join(currentDir, entry.name), relPosix);
      } else if (entry.isFile()) {
        if (ig.ignores(relPosix)) continue;
        found.push(relPosix);
      }
    }
  }

  walk(repoPath, '');
  return found;
}

function collectChangedFilesViaGit(repoPath: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tokens = output.split('\0');
    const changed: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3).replace(/\\/g, '/');
      if (filePath) changed.push(filePath);
      if (status.includes('R') || status.includes('C')) {
        i += 1; // skip original path entry in porcelain -z
      }
    }
    return changed;
  } catch {
    return [];
  }
}

export function collectRepoFilePaths(repoPath: string): string[] {
  const resolvedRoot = path.resolve(repoPath);
  const rawPaths = collectFilesViaGit(resolvedRoot) ?? collectFilesViaFs(resolvedRoot);
  return rawPaths
    .filter((relPosix) => !relPosix.split('/').some((p) => SKIP_DIRECTORIES.has(p)))
    .sort();
}

export function scanRepositoryTree(repoPath: string): FileTreeResponse {
  const resolvedRoot = path.resolve(repoPath);
  const rawPaths = collectFilesViaGit(resolvedRoot) ?? collectFilesViaFs(resolvedRoot);
  const validFileSet = new Set<string>();

  let skippedSecretsCount = 0;
  let skippedBinaryCount = 0;
  let totalFiles = 0;

  const rootChildren: FileTreeNode[] = [];
  const dirMap = new Map<string, FileTreeNode>();

  function getOrCreateDir(dirRelPath: string): FileTreeNode {
    const existing = dirMap.get(dirRelPath);
    if (existing) return existing;

    const parts = dirRelPath.split('/');
    const name = parts[parts.length - 1];
    const node: FileTreeNode = {
      path: dirRelPath,
      name,
      type: 'directory',
      estimatedTokens: 0,
      fileCount: 0,
      children: [],
    };
    dirMap.set(dirRelPath, node);

    if (parts.length === 1) {
      rootChildren.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = getOrCreateDir(parentPath);
      parent.children!.push(node);
    }
    return node;
  }

  for (const relPosix of rawPaths.sort()) {
    const parts = relPosix.split('/');
    if (parts.some((p) => SKIP_DIRECTORIES.has(p))) continue;

    const fullPath = path.join(resolvedRoot, ...parts);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const baseLower = parts[parts.length - 1].toLowerCase();
    const extLower = path.extname(baseLower);

    if (isSecretFilename(relPosix)) {
      skippedSecretsCount += 1;
      continue;
    }
    if (
      SKIP_FILENAMES.has(baseLower) ||
      SKIP_EXTENSIONS.has(extLower) ||
      stat.size > MAX_FILE_SIZE_BYTES ||
      isBinaryBuffer(fullPath)
    ) {
      skippedBinaryCount += 1;
      continue;
    }

    const estimatedTokens = Math.max(1, Math.ceil(stat.size / 4));
    const fileNode: FileTreeNode = {
      path: relPosix,
      name: parts[parts.length - 1],
      type: 'file',
      sizeBytes: stat.size,
      estimatedTokens,
      fileCount: 1,
    };

    totalFiles += 1;
    validFileSet.add(relPosix);
    if (parts.length === 1) {
      rootChildren.push(fileNode);
    } else {
      const parentDir = getOrCreateDir(parts.slice(0, -1).join('/'));
      parentDir.children!.push(fileNode);
    }
  }

  function finalizeNode(nodes: FileTreeNode[]): { tokens: number; files: number } {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    let totalT = 0;
    let totalF = 0;
    for (const node of nodes) {
      if (node.type === 'directory' && node.children) {
        const sub = finalizeNode(node.children);
        node.estimatedTokens = sub.tokens;
        node.fileCount = sub.files;
      }
      totalT += node.estimatedTokens;
      totalF += node.fileCount;
    }
    return { tokens: totalT, files: totalF };
  }

  finalizeNode(rootChildren);

  const changedPaths = collectChangedFilesViaGit(resolvedRoot).filter((p) =>
    validFileSet.has(p)
  );

  return {
    rootName: path.basename(resolvedRoot),
    totalFiles,
    skippedSecretsCount,
    skippedBinaryCount,
    changedPaths,
    tree: rootChildren,
  };
}

export function listLocalDirectories(dirInput?: string): DirectoryListResponse {
  let target: string;
  try {
    target = dirInput ? path.resolve(dirInput) : os.homedir();
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      target = process.cwd();
    }
  } catch {
    target = process.cwd();
  }

  const parent = path.dirname(target);
  const parentPath = parent !== target ? parent : null;

  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    // Inaccessible folder or junction on Windows
  }

  const entries: DirectoryEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const full = path.join(target, d.name);
    let hasGit = false;
    try {
      hasGit = fs.existsSync(path.join(full, '.git'));
    } catch {
      hasGit = false;
    }
    entries.push({ name: d.name, path: full, isGitRepo: hasGit });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { currentPath: target, parentPath, entries };
}
