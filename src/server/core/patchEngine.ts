import crypto from 'node:crypto';
import fs from 'node:fs';
import { applyPatch, diffLines } from 'diff';
import { SENSITIVE_PATCH_PATTERNS } from '../../shared/constants.js';
import type { ParsedFileDiff, ParsePatchResponse } from '../../shared/types.js';
import { normalizeRepoRelPath, PathSecurityError, resolveSafeRepoPath } from './pathGuard.js';

export interface StoredFilePlan {
  filePath: string;
  action: 'modify' | 'create' | 'delete';
  status: 'ready' | 'failed' | 'blocked';
  proposedContent: string;
  expectedDiskSha256: string | null;
  existedBefore: boolean;
}

export interface StoredParseSession {
  parseId: string;
  repoPath: string;
  createdAt: number;
  plans: Map<string, StoredFilePlan>;
}

const parseCache = new Map<string, StoredParseSession>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of parseCache.entries()) {
    if (now - session.createdAt > CACHE_TTL_MS) {
      parseCache.delete(id);
    }
  }
}

export function getStoredParseSession(parseId: string): StoredParseSession | null {
  pruneExpiredSessions();
  return parseCache.get(parseId) ?? null;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectSecurityWarning(relPath: string): string | null {
  const lower = relPath.toLowerCase();
  if (SENSITIVE_PATCH_PATTERNS.some((pat) => lower.includes(pat))) {
    return 'Touches a configuration, dependency, or sensitive file. Review carefully.';
  }
  return null;
}

function countDiffStats(original: string, proposed: string): { additions: number; deletions: number } {
  const parts = diffLines(original, proposed);
  let additions = 0;
  let deletions = 0;
  for (const p of parts) {
    const count = p.count ?? 0;
    if (p.added) additions += count;
    if (p.removed) deletions += count;
  }
  return { additions, deletions };
}

function readDiskFile(repoPath: string, relPath: string): {
  exists: boolean;
  contentLf: string;
  hadCrlf: boolean;
  rawSha256: string | null;
} {
  const abs = resolveSafeRepoPath(repoPath, relPath);
  if (!fs.existsSync(abs)) {
    return { exists: false, contentLf: '', hadCrlf: false, rawSha256: null };
  }
  const raw = fs.readFileSync(abs, 'utf8');
  return {
    exists: true,
    contentLf: normalizeEol(raw),
    hadCrlf: raw.includes('\r\n'),
    rawSha256: sha256(raw),
  };
}

// -----------------------------------------------------------------------------
// FORMAT A: SEARCH / REPLACE PARSER + SELF-HEALER
// -----------------------------------------------------------------------------

interface SearchReplaceOp {
  filePath: string;
  kind: 'replace' | 'create' | 'delete';
  search?: string;
  replace?: string;
  content?: string;
}

function cleanHeaderPath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/\s*\([^)]*\)$/, '');
  p = p.replace(/[:`*#]+$/, '').replace(/^[:`*#]+/, '').trim();
  return normalizeRepoRelPath(p);
}

function stripSurroundingCodeFence(s: string): string {
  const trimmed = s.trim();
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/m.exec(trimmed);
  if (match) return match[1];
  const lines = trimmed.split('\n');
  if (lines.length >= 2 && /^```[a-zA-Z0-9_-]*$/.test(lines[0].trim()) && lines[lines.length - 1].trim() === '```') {
    return lines.slice(1, -1).join('\n');
  }
  return s;
}

function normalizeSearchReplaceText(rawText: string): string {
  let text = normalizeEol(rawText);
  // Normalize variations of REPLACE with > and spaces
  text = text.replace(/^[ \t]*(?:>[ \t]*){5,9}[ \t]*REPLACE[^\n]*/gim, '>>>>>>> REPLACE');
  // Normalize variations of SEARCH with < and spaces
  text = text.replace(/^[ \t]*(?:<[ \t]*){5,9}[ \t]*SEARCH[^\n]*/gim, '<<<<<<< SEARCH');
  // Normalize =======
  text = text.replace(/^[ \t]*(?:=[ \t]*){5,9}[ \t]*$/gm, '=======');
  // Strip trailing blockquote lines like "> > > > > " or "> > "
  text = text.replace(/^[ \t]*(?:>[ \t]*){1,9}[ \t]*$/gm, '');
  return text;
}

function normalizePunctuation(str: string): string {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/[—–―\u2013\u2014\u2015]|â€”|â€“/g, '-')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u00A0\u2000-\u200B]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizePunctuationRelaxed(str: string): string {
  return normalizePunctuation(str)
    .replace(/[`'"]/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function lineMatches(searchLine: string, contentLine: string): boolean {
  if (searchLine === contentLine) return true;
  const sNorm = normalizePunctuation(searchLine);
  const cNorm = normalizePunctuation(contentLine);
  if (sNorm === cNorm) return true;
  if (cNorm.includes(sNorm) && sNorm.length >= 4) return true;
  const sRel = normalizePunctuationRelaxed(searchLine);
  const cRel = normalizePunctuationRelaxed(contentLine);
  if (sRel === cRel) return true;
  if (cRel.includes(sRel) && sRel.length >= 4) return true;
  return false;
}

function parseSearchReplaceOps(rawText: string): SearchReplaceOp[] {
  const text = normalizeSearchReplaceText(rawText);
  const ops: SearchReplaceOp[] = [];

  // 1. Match DELETE FILE directives (tolerant of leading Markdown #, *, >, etc.)
  const deleteRegex = /^[ \t]*(?:[#*>\s\-]*)(?:DELETE FILE|REMOVE FILE):\s*`?([^\n`*]+?)`?\s*$/gm;
  for (const match of text.matchAll(deleteRegex)) {
    ops.push({ filePath: cleanHeaderPath(match[1]), kind: 'delete' });
  }

  // 2. Match CREATE FILE directives followed by a fenced code block
  const createRegex =
    /^[ \t]*(?:[#*>\s\-]*)(?:CREATE FILE|NEW FILE):\s*`?([^\n`*]+?)`?\s*\n+[ \t]*```[^\n]*\n([\s\S]*?)\n[ \t]*```/gm;
  for (const match of text.matchAll(createRegex)) {
    ops.push({
      filePath: cleanHeaderPath(match[1]),
      kind: 'create',
      content: match[2],
    });
  }

  // 3. Match FILE: header + one or more <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks
  const fileHeaderRegex =
    /^[ \t]*(?:[#*>\s\-]*)(?:FILE|PATH|File|Filename):\s*`?\*{0,2}([^\n`*]+?)\*{0,2}`?\s*$/gm;
  const headers: Array<{ filePath: string; index: number; end: number }> = [];
  for (const m of text.matchAll(fileHeaderRegex)) {
    if (m.index !== undefined) {
      headers.push({
        filePath: cleanHeaderPath(m[1]),
        index: m.index,
        end: m.index + m[0].length,
      });
    }
  }

  const blockRegex =
    /^[ \t]*<{5,9}[ \t]*SEARCH[^\n]*\n([\s\S]*?)\n?[ \t]*>{5,9}[ \t]*REPLACE/gm;

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].end;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const slice = text.slice(start, end);

    for (const bm of slice.matchAll(blockRegex)) {
      const inner = bm[1];
      let search = '';
      let replace = '';

      const sepMatch = /\n[ \t]*={5,9}[ \t]*(?:\n|$)/.exec(inner);
      if (sepMatch) {
        search = inner.slice(0, sepMatch.index);
        replace = inner.slice(sepMatch.index + sepMatch[0].length);
      } else {
        // Fallback: If AI omitted ======= and instead put replacement in a fenced code block
        const fenceMatch = /\n[ \t]*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?:\n|$)/.exec(inner);
        if (fenceMatch) {
          search = inner.slice(0, fenceMatch.index);
          replace = fenceMatch[1];
        } else {
          continue;
        }
      }

      ops.push({
        filePath: headers[i].filePath,
        kind: 'replace',
        search: stripSurroundingCodeFence(search).trim(),
        replace: stripSurroundingCodeFence(replace).trim(),
      });
    }
  }

  return ops;
}

function applySingleSearchReplace(
  content: string,
  search: string,
  replace: string
): { ok: true; next: string; note: string | null } | { ok: false; error: string } {
  // Tier 1: Exact substring match
  const exactIdx = content.indexOf(search);
  if (exactIdx !== -1) {
    const secondIdx = content.indexOf(search, exactIdx + 1);
    if (secondIdx !== -1) {
      return {
        ok: false,
        error: 'The SEARCH block matched multiple places in this file. Include 2-3 extra surrounding lines.',
      };
    }
    return {
      ok: true,
      next: content.slice(0, exactIdx) + replace + content.slice(exactIdx + search.length),
      note: null,
    };
  }

  // Tier 2: Line-by-line trimmed whitespace match (handles indentation drift)
  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  const trimmedSearch = searchLines.map((l) => l.trim());

  if (trimmedSearch.length === 0 || trimmedSearch.every((l) => l === '')) {
    return { ok: false, error: 'Empty SEARCH block.' };
  }

  const matches: number[] = [];
  for (let i = 0; i <= contentLines.length - trimmedSearch.length; i++) {
    let allMatch = true;
    for (let j = 0; j < trimmedSearch.length; j++) {
      if (contentLines[i + j].trim() !== trimmedSearch[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) matches.push(i);
  }

  if (matches.length === 1) {
    const startLine = matches[0];
    const nextLines = [
      ...contentLines.slice(0, startLine),
      ...replace.split('\n'),
      ...contentLines.slice(startLine + trimmedSearch.length),
    ];
    return {
      ok: true,
      next: nextLines.join('\n'),
      note: 'Auto-matched with flexible spacing',
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: 'Flexible match found multiple locations. Ask the AI to include more surrounding lines.',
    };
  }

  // Tier 3: Punctuation and Mojibake normalized line match
  const normContentLines = contentLines.map(normalizePunctuation);
  const normSearchLines = searchLines.map(normalizePunctuation);
  const t3Matches: number[] = [];

  for (let i = 0; i <= normContentLines.length - normSearchLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < normSearchLines.length; j++) {
      if (normSearchLines[j] === '') {
        if (normContentLines[i + j] !== '') {
          allMatch = false;
          break;
        }
      } else if (normContentLines[i + j] !== normSearchLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) t3Matches.push(i);
  }

  if (t3Matches.length === 1) {
    const startLine = t3Matches[0];
    const nextLines = [
      ...contentLines.slice(0, startLine),
      ...replace.split('\n'),
      ...contentLines.slice(startLine + normSearchLines.length),
    ];
    return {
      ok: true,
      next: nextLines.join('\n'),
      note: 'Auto-matched with punctuation normalization',
    };
  }

  if (t3Matches.length > 1) {
    return {
      ok: false,
      error: 'Punctuation-relaxed match found multiple locations. Ask the AI to include more surrounding lines.',
    };
  }

  // Tier 4: Flexible token & tag-tolerant window match
  const nonBlankSearchLines = searchLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (nonBlankSearchLines.length > 0) {
    const candidateWindows: Array<{ startLine: number; endLine: number }> = [];

    for (let c = 0; c < contentLines.length; c++) {
      if (!lineMatches(nonBlankSearchLines[0], contentLines[c])) continue;

      const firstMatch = c;
      let curr = c + 1;
      let matchedCount = 1;
      let lastMatch = c;

      for (let s = 1; s < nonBlankSearchLines.length; s++) {
        let found = false;
        while (curr < contentLines.length && curr <= lastMatch + 6) {
          if (lineMatches(nonBlankSearchLines[s], contentLines[curr])) {
            found = true;
            lastMatch = curr;
            curr++;
            break;
          }
          curr++;
        }
        if (found) {
          matchedCount++;
        } else {
          break;
        }
      }

      if (matchedCount === nonBlankSearchLines.length) {
        let start = firstMatch;
        let end = lastMatch;

        // Tag expansion: if replace starts with an opening tag (e.g. <div>) that matches previous line, expand start
        const replaceTrimmed = replace.trim();
        const firstReplaceTag = /^<([a-zA-Z0-9_-]+)[^>]*>/.exec(replaceTrimmed);
        if (firstReplaceTag && start > 0) {
          const tag = firstReplaceTag[1];
          if (new RegExp(`^<${tag}[\\s>]`).test(contentLines[start - 1].trim())) {
            start--;
          }
        }

        // If replace ends with a closing tag (e.g. </div> or </button>) that matches next lines, expand end
        const lastReplaceTag = /<\/([a-zA-Z0-9_-]+)>\s*$/.exec(replaceTrimmed);
        if (lastReplaceTag) {
          const tag = lastReplaceTag[1];
          while (end + 1 < contentLines.length) {
            const nextTrim = contentLines[end + 1].trim();
            if (new RegExp(`^<\\/${tag}>`).test(nextTrim)) {
              end++;
              break;
            } else if (/^<\/([a-zA-Z0-9_-]+)>/.test(nextTrim)) {
              end++;
            } else {
              break;
            }
          }
        }

        candidateWindows.push({ startLine: start, endLine: end });
      }
    }

    const uniqueWindows: Array<{ startLine: number; endLine: number }> = [];
    for (const win of candidateWindows) {
      if (!uniqueWindows.some((u) => u.startLine === win.startLine && u.endLine === win.endLine)) {
        uniqueWindows.push(win);
      }
    }

    if (uniqueWindows.length === 1) {
      const { startLine, endLine } = uniqueWindows[0];
      const nextLines = [
        ...contentLines.slice(0, startLine),
        ...replace.split('\n'),
        ...contentLines.slice(endLine + 1),
      ];
      return {
        ok: true,
        next: nextLines.join('\n'),
        note: 'Auto-matched with tag-tolerant alignment',
      };
    }

    if (uniqueWindows.length > 1) {
      return {
        ok: false,
        error: 'Flexible match found multiple locations. Ask the AI to include more surrounding lines.',
      };
    }
  }

  return {
    ok: false,
    error: 'Could not find the exact SEARCH lines in your current file.',
  };
}

// -----------------------------------------------------------------------------
// FORMAT B: UNIFIED GIT DIFF PARSER + SELF-HEALER
// -----------------------------------------------------------------------------

function looksLikeUnifiedDiff(block: string): boolean {
  return (
    /^--- .+\n\+\+\+ .+/m.test(block) &&
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block)
  );
}

function stripTrailingFences(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && /^\s*`{3,}\s*$/.test(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

function extractUnifiedDiffText(rawText: string): string | null {
  let text = normalizeEol(rawText).trim();
  if (!text.includes('@@')) return null;

  // Repair merged opening fence: ```diff --git a/... -> ```diff\ndiff --git a/...
  text = text.replace(/^(`{3,})[ \t]*diff[ \t]+--git /gm, '$1diff\ndiff --git ');
  text = text.replace(/^(`{3,})(?:diff|patch)?[ \t]+(diff --git )/gm, '$1diff\n$2');

  const fencedMatches = Array.from(
    text.matchAll(/`{3,}(?:diff|patch)?[ \t]*\n([\s\S]*?)\n`{3,}/gi)
  )
    .map((m) => stripTrailingFences(m[1]))
    .filter(looksLikeUnifiedDiff);

  if (fencedMatches.length > 0) {
    return fencedMatches.join('\n') + '\n';
  }

  if (looksLikeUnifiedDiff(text)) {
    const startMatch = /^(?:diff --git |--- )/m.exec(text);
    if (startMatch && startMatch.index !== undefined) {
      return stripTrailingFences(text.slice(startMatch.index)) + '\n';
    }
  }

  return null;
}

function splitUnifiedDiffByFile(diffText: string): Array<{ filePath: string; chunk: string }> {
  const hasDiffGit = /^diff --git /m.test(diffText);
  const rawChunks = hasDiffGit
    ? diffText.split(/(?=^diff --git )/m)
    : diffText.split(/(?=^--- )/m);

  const out: Array<{ filePath: string; chunk: string }> = [];
  for (const raw of rawChunks) {
    const chunk = stripTrailingFences(raw);
    if (!looksLikeUnifiedDiff(chunk)) continue;

    let filePath = '';
    const mGit = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(chunk);
    if (mGit) {
      filePath = mGit[2].replace(/^"|"$/g, '');
    } else {
      const mPlus = /^\+\+\+ (?:b\/)?([^\t\n]+)/m.exec(chunk);
      const mMinus = /^--- (?:a\/)?([^\t\n]+)/m.exec(chunk);
      if (mPlus && mPlus[1].trim() !== '/dev/null') {
        filePath = mPlus[1].trim().replace(/^"|"$/g, '');
      } else if (mMinus) {
        filePath = mMinus[1].trim().replace(/^"|"$/g, '');
      }
    }

    if (filePath) {
      out.push({ filePath: normalizeRepoRelPath(filePath), chunk: chunk + '\n' });
    }
  }
  return out;
}

function repairUnifiedHunkLines(diskContentLf: string, chunk: string): string {
  const diskSet = new Set(diskContentLf.split('\n'));
  const lines = chunk.split('\n');
  const out: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (/^(?:diff --git |index |--- |\+\+\+ |new file |deleted file |old mode |new mode |rename )/.test(line)) {
      inHunk = false;
      out.push(line);
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      out.push(line);
      continue;
    }
    if (!inHunk) {
      out.push(line);
      continue;
    }

    if (line === '') {
      out.push(' ');
    } else if (line.startsWith(' ') || line.startsWith('\\')) {
      out.push(line);
    } else if (line.startsWith('-') && !line.startsWith('--')) {
      // Unchanged Markdown bullet `- **Item**` missing leading space
      if (diskSet.has(line) && !diskSet.has(line.slice(1))) {
        out.push(' ' + line);
      } else {
        out.push(line);
      }
    } else if (line.startsWith('+') && !line.startsWith('++')) {
      if (diskSet.has(line) && !diskSet.has(line.slice(1))) {
        out.push(' ' + line);
      } else {
        out.push(line);
      }
    } else if (line.startsWith('--') || line.startsWith('++')) {
      out.push(line);
    } else if (diskSet.has(line)) {
      out.push(' ' + line);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

function recountHunkHeaders(chunk: string): string {
  const lines = chunk.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }

    const oldStart = m[1];
    const newStart = m[2];
    const suffix = m[3] ?? '';
    const hunkBody: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    i++;

    while (
      i < lines.length &&
      !lines[i].startsWith('@@ ') &&
      !lines[i].startsWith('diff --git ')
    ) {
      const b = lines[i];
      hunkBody.push(b);
      if (b.startsWith(' ')) {
        oldCount++;
        newCount++;
      } else if (b.startsWith('-')) {
        oldCount++;
      } else if (b.startsWith('+')) {
        newCount++;
      }
      i++;
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`);
    out.push(...hunkBody);
  }

  return out.join('\n');
}

// -----------------------------------------------------------------------------
// PUBLIC ENTRYPOINT: PARSE, HEAL & BUILD PREVIEW
// -----------------------------------------------------------------------------

export function hasDetectablePatch(rawText: string): boolean {
  if (!rawText || rawText.length < 15) return false;
  const text = normalizeEol(rawText);
  if (/(?:<[ \t]*){5,9}[ \t]*SEARCH/i.test(text) && /(?:>[ \t]*){5,9}[ \t]*REPLACE/i.test(text)) return true;
  if (/^[ \t]*(?:[#*>\s\-]*)(?:CREATE FILE|NEW FILE|DELETE FILE|REMOVE FILE):/mi.test(text)) return true;
  if (text.includes('@@') && looksLikeUnifiedDiff(text)) return true;
  return false;
}

export function parseAndPreviewPatch(repoPath: string, rawText: string): ParsePatchResponse | null {
  pruneExpiredSessions();

  const srOps = parseSearchReplaceOps(rawText);
  const unifiedText = extractUnifiedDiffText(rawText);
  const unifiedChunks = unifiedText ? splitUnifiedDiffByFile(unifiedText) : [];

  if (srOps.length === 0 && unifiedChunks.length === 0) {
    return null;
  }

  const detectedFormat: ParsePatchResponse['detectedFormat'] =
    srOps.length > 0 && unifiedChunks.length > 0
      ? 'mixed'
      : srOps.length > 0
        ? 'search_replace'
        : 'unified_diff';

  const parseId = `prs_${crypto.randomBytes(8).toString('hex')}`;
  const files: ParsedFileDiff[] = [];
  const plans = new Map<string, StoredFilePlan>();
  const handledPaths = new Set<string>();

  // 1. Process SEARCH/REPLACE, CREATE FILE, DELETE FILE operations (grouped by file)
  const srGrouped = new Map<string, SearchReplaceOp[]>();
  for (const op of srOps) {
    const list = srGrouped.get(op.filePath) ?? [];
    list.push(op);
    srGrouped.set(op.filePath, list);
  }

  for (const [filePath, ops] of srGrouped.entries()) {
    handledPaths.add(filePath);
    const securityWarning = detectSecurityWarning(filePath);

    try {
      resolveSafeRepoPath(repoPath, filePath);
    } catch (err) {
      const msg = err instanceof PathSecurityError ? err.message : 'Unsafe file path blocked.';
      files.push({
        filePath,
        action: 'modify',
        status: 'blocked',
        repairNote: null,
        securityWarning: msg,
        errorReason: msg,
        originalContent: '',
        proposedContent: '',
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const disk = readDiskFile(repoPath, filePath);

    // Handle DELETE
    if (ops.some((o) => o.kind === 'delete')) {
      if (!disk.exists) {
        files.push({
          filePath,
          action: 'delete',
          status: 'failed',
          repairNote: null,
          securityWarning,
          errorReason: 'File does not exist on disk.',
          originalContent: '',
          proposedContent: '',
          additions: 0,
          deletions: 0,
        });
        continue;
      }
      const stats = countDiffStats(disk.contentLf, '');
      files.push({
        filePath,
        action: 'delete',
        status: 'ready',
        repairNote: null,
        securityWarning,
        errorReason: null,
        originalContent: disk.contentLf,
        proposedContent: '',
        ...stats,
      });
      plans.set(filePath, {
        filePath,
        action: 'delete',
        status: 'ready',
        proposedContent: '',
        expectedDiskSha256: disk.rawSha256,
        existedBefore: true,
      });
      continue;
    }

    // Handle CREATE
    const createOp = ops.find((o) => o.kind === 'create');
    if (createOp) {
      const nextLf = normalizeEol(createOp.content ?? '');
      const stats = countDiffStats(disk.contentLf, nextLf);
      const action = disk.exists ? 'modify' : 'create';
      files.push({
        filePath,
        action,
        status: 'ready',
        repairNote: null,
        securityWarning,
        errorReason: null,
        originalContent: disk.contentLf,
        proposedContent: nextLf,
        ...stats,
      });
      plans.set(filePath, {
        filePath,
        action,
        status: 'ready',
        proposedContent: disk.hadCrlf ? nextLf.replace(/\n/g, '\r\n') : nextLf,
        expectedDiskSha256: disk.rawSha256,
        existedBefore: disk.exists,
      });
      continue;
    }

    // Handle sequential SEARCH/REPLACE blocks on existing file
    if (!disk.exists) {
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: 'File not found in your project. Use CREATE FILE for brand-new files.',
        originalContent: '',
        proposedContent: '',
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    let working = disk.contentLf;
    const repairNotes = new Set<string>();
    let failedReason: string | null = null;

    for (const op of ops) {
      const applied = applySingleSearchReplace(working, op.search ?? '', op.replace ?? '');
      if (!applied.ok) {
        failedReason = applied.error;
        break;
      }
      working = applied.next;
      if (applied.note) repairNotes.add(applied.note);
    }

    if (failedReason) {
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: failedReason,
        originalContent: disk.contentLf,
        proposedContent: disk.contentLf,
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const stats = countDiffStats(disk.contentLf, working);
    files.push({
      filePath,
      action: 'modify',
      status: 'ready',
      repairNote: repairNotes.size > 0 ? Array.from(repairNotes).join('; ') : null,
      securityWarning,
      errorReason: null,
      originalContent: disk.contentLf,
      proposedContent: working,
      ...stats,
    });
    plans.set(filePath, {
      filePath,
      action: 'modify',
      status: 'ready',
      proposedContent: disk.hadCrlf ? working.replace(/\n/g, '\r\n') : working,
      expectedDiskSha256: disk.rawSha256,
      existedBefore: true,
    });
  }

  // 2. Process Unified Diff chunks
  for (const { filePath, chunk } of unifiedChunks) {
    if (handledPaths.has(filePath)) continue;
    const securityWarning = detectSecurityWarning(filePath);

    try {
      resolveSafeRepoPath(repoPath, filePath);
    } catch (err) {
      const msg = err instanceof PathSecurityError ? err.message : 'Unsafe file path blocked.';
      files.push({
        filePath,
        action: 'modify',
        status: 'blocked',
        repairNote: null,
        securityWarning: msg,
        errorReason: msg,
        originalContent: '',
        proposedContent: '',
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const isNewFile = /^--- \/dev\/null/m.test(chunk);
    const isDeleteFile = /^\+\+\+ \/dev\/null/m.test(chunk);
    const disk = readDiskFile(repoPath, filePath);

    if (isDeleteFile) {
      if (!disk.exists) {
        files.push({
          filePath,
          action: 'delete',
          status: 'failed',
          repairNote: null,
          securityWarning,
          errorReason: 'File to delete does not exist on disk.',
          originalContent: '',
          proposedContent: '',
          additions: 0,
          deletions: 0,
        });
        continue;
      }
      const stats = countDiffStats(disk.contentLf, '');
      files.push({
        filePath,
        action: 'delete',
        status: 'ready',
        repairNote: null,
        securityWarning,
        errorReason: null,
        originalContent: disk.contentLf,
        proposedContent: '',
        ...stats,
      });
      plans.set(filePath, {
        filePath,
        action: 'delete',
        status: 'ready',
        proposedContent: '',
        expectedDiskSha256: disk.rawSha256,
        existedBefore: true,
      });
      continue;
    }

    const baseContent = isNewFile ? '' : disk.contentLf;
    if (!isNewFile && !disk.exists) {
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: 'File not found in your active project folder.',
        originalContent: '',
        proposedContent: '',
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    let repairedChunk = recountHunkHeaders(chunk);
    let patched = applyPatch(baseContent, repairedChunk, { fuzzFactor: 2 });
    let repairNote: string | null = null;

    if (patched === false) {
      const mdFixed = recountHunkHeaders(repairUnifiedHunkLines(baseContent, chunk));
      patched = applyPatch(baseContent, mdFixed, { fuzzFactor: 2 });
      if (patched !== false) {
        repairNote = 'Auto-fixed minor AI diff formatting';
      }
    }

    if (patched === false) {
      files.push({
        filePath,
        action: isNewFile ? 'create' : 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: 'Diff context lines did not match your current file on disk.',
        originalContent: disk.contentLf,
        proposedContent: disk.contentLf,
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const action = isNewFile && !disk.exists ? 'create' : 'modify';
    const stats = countDiffStats(disk.contentLf, patched);
    files.push({
      filePath,
      action,
      status: 'ready',
      repairNote,
      securityWarning,
      errorReason: null,
      originalContent: disk.contentLf,
      proposedContent: patched,
      ...stats,
    });
    plans.set(filePath, {
      filePath,
      action,
      status: 'ready',
      proposedContent: disk.hadCrlf ? patched.replace(/\n/g, '\r\n') : patched,
      expectedDiskSha256: disk.rawSha256,
      existedBefore: disk.exists,
    });
  }

  parseCache.set(parseId, {
    parseId,
    repoPath,
    createdAt: Date.now(),
    plans,
  });

  const readyCount = files.filter((f) => f.status === 'ready').length;
  const failedFiles = files.filter((f) => f.status === 'failed');
  const blockedCount = files.filter((f) => f.status === 'blocked').length;

  let retryPrompt: string | null = null;
  if (failedFiles.length > 0) {
    const lines = [
      '================================================================================',
      'CORRECTION REQUIRED: PATCH ENGINE COULD NOT APPLY EDITS TO THE FOLLOWING FILE(S)',
      '================================================================================',
      'Most of your changes parsed cleanly, but the following file(s) failed during application:',
      '',
    ];
    for (const ff of failedFiles) {
      lines.push(`- File: \`${ff.filePath}\``);
      lines.push(`  Failure Reason: ${ff.errorReason}`);
    }
    lines.push('');
    lines.push('Please REGENERATE code modifications ONLY for these failed files using strict SEARCH/REPLACE blocks:');
    lines.push('');
    lines.push('FILE: path/to/file.ext');
    lines.push('<<<<<<< SEARCH');
    lines.push('[exact lines from the file to replace, with 3-4 lines of surrounding context]');
    lines.push('=======');
    lines.push('[new replacement lines]');
    lines.push('>>>>>>> REPLACE');
    lines.push('');
    lines.push('RULES FOR 100% SUCCESS:');
    lines.push('1. In `<<<<<<< SEARCH`, copy the lines VERBATIM from the source file (exact indentation, quotes, and all HTML/JSX tags).');
    lines.push('2. Include 3-4 lines of unchanged context above and below the edit so the match is unique.');
    lines.push('3. Do NOT wrap blocks in markdown code fences (```).');
    lines.push('4. Do NOT omit `=======`.');
    lines.push('5. Do NOT use placeholder comments like `// ... rest of file ...`.');
    lines.push('6. Write exactly 7 angle brackets: `<<<<<<< SEARCH` and `>>>>>>> REPLACE`.');
    lines.push('================================================================================');
    retryPrompt = lines.join('\n');
  }

  return {
    parseId,
    detectedFormat,
    summary: {
      totalFiles: files.length,
      readyCount,
      failedCount: failedFiles.length,
      blockedCount,
    },
    files,
    retryPrompt,
  };
}
