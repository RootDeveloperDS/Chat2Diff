import fs from 'node:fs';
import path from 'node:path';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export function normalizeRepoRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function resolveSafeRepoPath(repoRoot: string, relPath: string): string {
  const normalized = normalizeRepoRelPath(relPath);

  if (!normalized) {
    throw new PathSecurityError('File path cannot be empty.');
  }
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new PathSecurityError(`Absolute path blocked: ${relPath}`);
  }

  const parts = normalized.split('/').filter(Boolean);
  if (
    parts.includes('..') ||
    parts[0] === '.git' ||
    parts[0] === '.chat2diff'
  ) {
    throw new PathSecurityError(`Protected or unsafe path blocked: ${relPath}`);
  }

  const realRoot = fs.realpathSync(repoRoot);
  const candidate = path.resolve(realRoot, normalized);

  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    throw new PathSecurityError(`Path escapes project folder: ${relPath}`);
  }

  // Ensure deepest existing parent does not escape via symlink
  let ancestor = fs.existsSync(candidate) ? candidate : path.dirname(candidate);
  while (!fs.existsSync(ancestor) && ancestor !== realRoot) {
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }

  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new PathSecurityError(`Symlink pointing outside project blocked: ${relPath}`);
  }

  return candidate;
}
