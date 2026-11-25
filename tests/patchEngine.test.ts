import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasDetectablePatch, parseAndPreviewPatch } from '../src/server/core/patchEngine.js';

const SR_START = '<'.repeat(7) + ' SEARCH';
const SR_MID = '='.repeat(7);
const SR_END = '>'.repeat(7) + ' REPLACE';
const FENCE4 = '`'.repeat(4);

describe('patchEngine', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2diff-engine-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'greet.ts'),
      [
        'export function greet(name: string): string {',
        '  const trimmed = name.trim();',
        '  return `Hello, ${trimmed}!`;',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      ['# Demo', '', '- **Item A:** old value', '- **Item B:** keep', ''].join('\n'),
      'utf8'
    );
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('parses 4-backtick Search/Replace modify, create, and delete blocks', () => {
    const patch = [
      `${FENCE4}patch`,
      'FILE: src/greet.ts',
      SR_START,
      '  const trimmed = name.trim();',
      '  return `Hello, ${trimmed}!`;',
      SR_MID,
      '  const trimmed = name.trim() || "world";',
      '  return `Welcome, ${trimmed}!`;',
      SR_END,
      '',
      'CREATE FILE: src/math.ts',
      SR_START,
      SR_MID,
      'export const add = (a: number, b: number) => a + b;',
      SR_END,
      `${FENCE4}`,
    ].join('\n');

    expect(hasDetectablePatch(patch)).toBe(true);
    const result = parseAndPreviewPatch(repoDir, patch, 'search_replace');
    expect(result).not.toBeNull();
    expect(result!.summary.readyCount).toBe(2);
    expect(result!.summary.failedCount).toBe(0);

    const greet = result!.files.find((f) => f.filePath === 'src/greet.ts');
    expect(greet?.proposedContent).toContain('Welcome, ${trimmed}!');

    const math = result!.files.find((f) => f.filePath === 'src/math.ts');
    expect(math?.action).toBe('create');
    expect(math?.proposedContent).toContain('export const add');
  });

  it('surfaces malformed Search/Replace blocks explicitly instead of dropping them', () => {
    const broken = [
      `${FENCE4}patch`,
      'FILE: src/greet.ts',
      SR_START,
      '  const trimmed = name.trim();',
      '  const trimmed = name.toUpperCase();',
      SR_END,
      `${FENCE4}`,
    ].join('\n');

    const result = parseAndPreviewPatch(repoDir, broken, 'search_replace');
    expect(result).not.toBeNull();
    expect(result!.summary.failedCount).toBe(1);
    expect(result!.files[0].errorReason).toContain('missing');
    expect(result!.retryPrompt).toContain('<file path="src/greet.ts">');
  });

  it('preserves disk indentation when AI Search/Replace has indentation drift', () => {
    const drifted = [
      'FILE: src/greet.ts',
      SR_START,
      'const trimmed = name.trim();',
      'return `Hello, ${trimmed}!`;',
      SR_MID,
      'const trimmed = name.trim();',
      'return `Hi, ${trimmed}!`;',
      SR_END,
    ].join('\n');

    const result = parseAndPreviewPatch(repoDir, drifted, 'search_replace');
    expect(result?.summary.readyCount).toBe(1);
    expect(result?.files[0].proposedContent).toContain('  return `Hi, ${trimmed}!`;');
  });

  it('repairs unified git diffs with merged fences and unindented Markdown bullets', () => {
    const diff = [
      '```diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,4 +1,4 @@',
      ' # Demo',
      ' ',
      '-- **Item A:** old value',
      '+- **Item A:** new value',
      '- **Item B:** keep',
      '```',
    ].join('\n');

    const result = parseAndPreviewPatch(repoDir, diff, 'unified_diff');
    expect(result).not.toBeNull();
    expect(result!.summary.readyCount).toBe(1);
    expect(result!.files[0].proposedContent).toContain('- **Item A:** new value');
    expect(result!.files[0].proposedContent).toContain('- **Item B:** keep');
  });

  it('blocks path traversal targets cleanly', () => {
    const evil = [
      'FILE: ../escape.txt',
      SR_START,
      'a',
      SR_MID,
      'b',
      SR_END,
    ].join('\n');

    const result = parseAndPreviewPatch(repoDir, evil, 'search_replace');
    expect(result?.summary.blockedCount).toBe(1);
    expect(result?.files[0].status).toBe('blocked');
  });
});