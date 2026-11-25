import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeRepoRelPath,
  PathSecurityError,
  resolveSafeRepoPath,
} from '../src/server/core/pathGuard.js';

describe('pathGuard', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2diff-pathguard-'));
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('normalizes Windows separators and leading ./ prefixes', () => {
    expect(normalizeRepoRelPath('.\\src\\index.ts')).toBe('src/index.ts');
    expect(normalizeRepoRelPath('./src/app.tsx')).toBe('src/app.tsx');
  });

  it('resolves valid relative paths inside repo root', () => {
    const resolved = resolveSafeRepoPath(tmpRoot, 'src/index.ts');
    expect(resolved).toBe(path.join(fs.realpathSync(tmpRoot), 'src', 'index.ts'));
  });

  it('blocks parent directory traversal, absolute paths, and internal dirs', () => {
    const attacks = [
      '',
      '../outside.txt',
      'src/../../outside.txt',
      '/etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '.git/config',
      '.chat2diff/snapshots/snap_1/manifest.json',
    ];
    for (const bad of attacks) {
      expect(() => resolveSafeRepoPath(tmpRoot, bad)).toThrow(PathSecurityError);
    }
  });
});