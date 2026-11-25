import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, diffLines } from 'diff';
import { SENSITIVE_PATCH_PATTERNS } from '../../shared/constants.js';
import type { ParsedFileDiff, ParsePatchResponse, PatchFormat } from '../../shared/types.js';
import { normalizeRepoRelPath, PathSecurityError, resolveSafeRepoPath } from './pathGuard.js';
import { collectRepoFilePaths } from './repoScanner.js';
import { scanAndRedactSecrets } from './secretGuard.js';

export interface StoredFilePlan {
  filePath: string;
  action: 'modify' | 'create' | 'delete';
  status: 'ready' | 'failed' | 'blocked';
  proposedContent: string;
  expectedDiskSha256: string | null;
  existedBefore: boolean;
  hadCrlf: boolean;
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

function stripDiffPathPrefixes(rawPath: string, repoName: string): string {
  let p = normalizeRepoRelPath(rawPath.replace(/^["'`]+|["'`]+$/g, ''));
  if (/^(?:a|b)\//.test(p)) {
    p = p.slice(2);
  }
  const repoPrefix = `${repoName.toLowerCase()}/`;
  if (p.toLowerCase().startsWith(repoPrefix)) {
    const stripped = p.slice(repoPrefix.length);
    if (stripped) p = stripped;
  }
  return normalizeRepoRelPath(p);
}

function resolveSmartRepoFilePath(
  repoPath: string,
  rawPath: string,
  repoFiles: string[]
): string {
  const repoName = path.basename(path.resolve(repoPath));
  const direct = normalizeRepoRelPath(rawPath);
  const cleaned = stripDiffPathPrefixes(rawPath, repoName);

  for (const candidate of [direct, cleaned]) {
    if (!candidate) continue;
    try {
      const abs = resolveSafeRepoPath(repoPath, candidate);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return candidate;
      }
    } catch {
      // let security check handle unsafe paths later
    }
  }

  const targetLower = cleaned.toLowerCase();
  const exactCi = repoFiles.find((f) => f.toLowerCase() === targetLower);
  if (exactCi) return exactCi;

  // Unique suffix match (e.g. "components/TopBar.tsx" -> "src/client/components/TopBar.tsx")
  if (targetLower.includes('/') || targetLower.includes('.')) {
    const suffixMatches = repoFiles.filter(
      (f) => f.toLowerCase().endsWith(`/${targetLower}`) || f.toLowerCase() === targetLower
    );
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
    }
  }

  return cleaned || direct;
}

function suggestClosestPaths(repoFiles: string[], missingPath: string): string[] {
  const base = path.posix.basename(missingPath).toLowerCase();
  if (!base) return [];
  const sameName = repoFiles.filter((f) => path.posix.basename(f).toLowerCase() === base);
  if (sameName.length > 0) return sameName.slice(0, 3);
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem.length < 3) return [];
  return repoFiles
    .filter((f) => path.posix.basename(f).toLowerCase().includes(stem))
    .slice(0, 3);
}

function preserveTrailingNewline(original: string, updated: string): string {
  if (!original) return updated;
  if (original.endsWith('\n') && !updated.endsWith('\n')) return `${updated}\n`;
  return updated;
}

// -----------------------------------------------------------------------------
// FORMAT A: SEARCH / REPLACE PARSER + SELF-HEALER
// -----------------------------------------------------------------------------

interface SearchReplaceOp {
  filePath: string;
  kind: 'replace' | 'create' | 'delete' | 'malformed';
  search?: string;
  replace?: string;
  content?: string;
  error?: string;
}

function cleanHeaderPath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/\s*\([^)]*\)\s*$/, '');
  p = p.replace(/^[\s*`"'#>\-:]+/, '').replace(/[\s*`"'#:]+$/, '').trim();
  return normalizeRepoRelPath(p);
}

function stripSurroundingCodeFence(s: string): string {
  const lines = normalizeEol(s).split('\n');
  if (lines.length < 2) return normalizeEol(s);

  const openMatch = /^[ \t]*(`{3,})[a-zA-Z0-9_.-]*[ \t]*$/.exec(lines[0]);
  const closeMatch = /^[ \t]*(`{3,})[ \t]*$/.exec(lines[lines.length - 1]);
  if (openMatch && closeMatch && closeMatch[1].length >= openMatch[1].length) {
    const fenceLen = openMatch[1].length;
    // Ensure there isn't a standalone closing fence inside the body (which would mean multiple blocks)
    const hasInnerFence = lines
      .slice(1, -1)
      .some((l) => new RegExp(`^[ \\t]*\`{${fenceLen},}[ \\t]*$`).test(l));
    if (!hasInnerFence) {
      return lines.slice(1, -1).join('\n');
    }
  }
  return normalizeEol(s);
}

function stripEdgeBlankLines(s: string): string {
  const lines = normalizeEol(s).split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function getMinIndent(lines: string[]): string {
  let minIndent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = /^[ \t]*/.exec(line);
    const indent = match ? match[0] : '';
    if (minIndent === null || indent.length < minIndent.length) {
      minIndent = indent;
    }
  }
  return minIndent ?? '';
}

function adjustReplacementIndent(
  replaceLines: string[],
  matchedDiskLines: string[],
  searchLines: string[]
): string[] {
  const diskIndent = getMinIndent(matchedDiskLines);
  const searchIndent = getMinIndent(searchLines);
  if (diskIndent === searchIndent) return replaceLines;

  // Detect if disk uses tabs while AI used spaces (or vice versa)
  const diskUsesTabs = diskIndent.includes('\t');
  const searchUsesTabs = searchIndent.includes('\t');
  const replaceMin = getMinIndent(replaceLines);
  const baseIndent =
    replaceMin.length < searchIndent.length && searchIndent.startsWith(replaceMin)
      ? replaceMin
      : searchIndent;

  return replaceLines.map((line) => {
    if (line.trim() === '') return '';
    let adjusted = line;
    if (baseIndent && adjusted.startsWith(baseIndent)) {
      adjusted = diskIndent + adjusted.slice(baseIndent.length);
    } else if (!baseIndent) {
      adjusted = diskIndent + adjusted;
    }
    if (diskUsesTabs && !searchUsesTabs) {
      adjusted = adjusted.replace(/^( +)/, (spaces) => '\t'.repeat(Math.round(spaces.length / 2)));
    }
    return adjusted;
  });
}

function normalizeSearchReplaceText(rawText: string): string {
  let text = normalizeEol(rawText);
  text = text.replace(/^[ \t]*(?:>[ \t]*){4,12}[ \t]*REPLACE[^\n]*/gim, '>>>>>>> REPLACE');
  text = text.replace(/^[ \t]*(?:<[ \t]*){4,12}[ \t]*SEARCH[^\n]*/gim, '<<<<<<< SEARCH');
  text = text.replace(/^[ \t]*(?:=[ \t]*){5,12}[ \t]*(?:REPLACE)?[ \t]*$/gim, '=======');
  return text;
}

function isPlausibleRepoPath(candidate: string): boolean {
  if (!candidate || candidate.length > 260) return false;
  if (/[<>|?*\r\n]/.test(candidate)) return false;
  if (/\s{2,}/.test(candidate)) return false;
  if (candidate.split(/\s+/).length > 4) return false;
  return candidate.includes('/') || candidate.includes('.');
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
  const sRel = normalizePunctuationRelaxed(searchLine);
  const cRel = normalizePunctuationRelaxed(contentLine);
  if (sRel.length >= 6 && sRel === cRel) return true;
  return false;
}

function extractFileHeaderFromLine(line: string): { kind: 'file' | 'create' | 'delete'; filePath: string } | null {
  const stripped = line.replace(/^[ \t]*(?:(?:\/\/|#|<!--|[-*+]|\d+\.)[ \t]*)*(?:>[ \t]*)*/, '').trim();
  if (!stripped) return null;

  const delMatch = /^\*{0,2}(?:DELETE FILE|REMOVE FILE)\*{0,2}\s*:\s*\*{0,2}(.+)$/i.exec(stripped);
  if (delMatch) {
    const p = cleanHeaderPath(delMatch[1]);
    if (isPlausibleRepoPath(p)) return { kind: 'delete', filePath: p };
  }

  const createMatch = /^\*{0,2}(?:CREATE FILE|NEW FILE)\*{0,2}\s*:\s*\*{0,2}(.+)$/i.exec(stripped);
  if (createMatch) {
    const p = cleanHeaderPath(createMatch[1]);
    if (isPlausibleRepoPath(p)) return { kind: 'create', filePath: p };
  }

  const fileMatch = /^\*{0,2}(?:FILE|PATH|FILENAME)\*{0,2}\s*:\s*\*{0,2}(.+)$/i.exec(stripped);
  if (fileMatch) {
    const p = cleanHeaderPath(fileMatch[1]);
    if (isPlausibleRepoPath(p)) return { kind: 'file', filePath: p };
  }

  return null;
}

function extractImplicitPathBeforeSearch(line: string): string | null {
  const cleaned = cleanHeaderPath(line.replace(/^[ \t]*(?:#+|\d+\.|[-*+])[ \t]*/, ''));
  if (!cleaned || cleaned.includes(' ')) return null;
  if (/^[a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]{1,10}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function isDirectiveOrDiffLine(line: string): boolean {
  return (
    extractFileHeaderFromLine(line) !== null ||
    /^diff --git /i.test(line.trim()) ||
    /^<<<<<<< SEARCH$/.test(line.trim())
  );
}

function parseSearchReplaceOps(rawText: string): SearchReplaceOp[] {
  const text = normalizeSearchReplaceText(rawText);
  const lines = text.split('\n');
  const ops: SearchReplaceOp[] = [];
  let currentFile: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const header = extractFileHeaderFromLine(line);

    if (header) {
      if (header.kind === 'delete') {
        ops.push({ filePath: header.filePath, kind: 'delete' });
        currentFile = null;
        i++;
        continue;
      }

      if (header.kind === 'create') {
        currentFile = header.filePath;
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;

        if (j < lines.length) {
          const openFence = /^[ \t]*(`{3,})[^\n]*$/.exec(lines[j]);
          if (openFence) {
            const fenceLen = openFence[1].length;
            const closeRegex = new RegExp(`^[ \\t]*\`{${fenceLen},}[ \\t]*$`);
            let lastClose = -1;
            for (let k = j + 1; k < lines.length; k++) {
              if (closeRegex.test(lines[k])) {
                lastClose = k;
                // Check if next non-empty line starts a new directive/file; if so, stop here
                let peek = k + 1;
                while (peek < lines.length && lines[peek].trim() === '') peek++;
                if (peek >= lines.length || isDirectiveOrDiffLine(lines[peek])) {
                  break;
                }
              } else if (lastClose !== -1 && isDirectiveOrDiffLine(lines[k])) {
                break;
              }
            }
            if (lastClose !== -1) {
              ops.push({
                filePath: header.filePath,
                kind: 'create',
                content: lines.slice(j + 1, lastClose).join('\n'),
              });
              i = lastClose + 1;
              continue;
            }
          }
        }
        i++;
        continue;
      }

      currentFile = header.filePath;
      i++;
      continue;
    }

    if (line.trim() === '<<<<<<< SEARCH') {
      // If no explicit FILE: header was seen, check the preceding 1-3 non-empty lines for an implicit path
      if (!currentFile) {
        for (let back = i - 1; back >= Math.max(0, i - 4); back--) {
          const prev = lines[back].trim();
          if (!prev || /^`{3,}/.test(prev)) continue;
          const implicit = extractImplicitPathBeforeSearch(prev);
          if (implicit) {
            currentFile = implicit;
          }
          break;
        }
      }

      let endIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '>>>>>>> REPLACE') {
          endIdx = j;
          break;
        }
        // Stop scanning if another SEARCH block starts without closing this one
        if (lines[j].trim() === '<<<<<<< SEARCH') {
          break;
        }
      }

      if (!currentFile) {
        i++;
        continue;
      }

      if (endIdx === -1) {
        ops.push({
          filePath: currentFile,
          kind: 'malformed',
          error:
            'Malformed SEARCH/REPLACE block: missing >>>>>>> REPLACE closing marker (make sure the AI wraps patches in a code block).',
        });
        i++;
        continue;
      }

      const innerLines = lines.slice(i + 1, endIdx);
      const sepIdx = innerLines.findIndex((l) => l.trim() === '=======');
      let searchText = '';
      let replaceText = '';

      if (sepIdx !== -1) {
        searchText = innerLines.slice(0, sepIdx).join('\n');
        replaceText = innerLines.slice(sepIdx + 1).join('\n');
      } else {
        const innerStr = innerLines.join('\n');
        const fenceMatch = /\n[ \t]*```[a-zA-Z0-9_.-]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?:\n|$)/.exec(innerStr);
        if (fenceMatch) {
          searchText = innerStr.slice(0, fenceMatch.index);
          replaceText = fenceMatch[1];
        } else {
          ops.push({
            filePath: currentFile,
            kind: 'malformed',
            error:
              'Malformed SEARCH/REPLACE block: missing ======= separator (likely stripped by Markdown rendering outside a code block).',
          });
          i = endIdx + 1;
          continue;
        }
      }

      const cleanSearch = stripSurroundingCodeFence(searchText);
      const cleanReplace = stripSurroundingCodeFence(replaceText);

      if (cleanSearch.trim() === '' && cleanReplace.trim() !== '') {
        ops.push({ filePath: currentFile, kind: 'create', content: cleanReplace });
      } else {
        ops.push({
          filePath: currentFile,
          kind: 'replace',
          search: cleanSearch,
          replace: cleanReplace,
        });
      }
      i = endIdx + 1;
      continue;
    }

    i++;
  }

  return ops;
}

function pickUniqueOrHintedIndex(indices: number[], hintLine?: number): number | null {
  if (indices.length === 1) return indices[0];
  if (indices.length === 0 || hintLine === undefined) return null;
  const target = Math.max(0, hintLine - 1);
  const sorted = [...indices].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  const bestDist = Math.abs(sorted[0] - target);
  const secondDist = Math.abs(sorted[1] - target);
  if (bestDist <= 35 && bestDist * 2 + 5 < secondDist) {
    return sorted[0];
  }
  return null;
}

function applySingleSearchReplace(
  content: string,
  search: string,
  replace: string,
  hintLine?: number
): { ok: true; next: string; note: string | null } | { ok: false; error: string } {
  // Tier 1: Exact substring match
  for (const [sCand, rCand] of [
    [search, replace],
    [stripEdgeBlankLines(search), stripEdgeBlankLines(replace)],
  ]) {
    if (!sCand) continue;
    const exactPositions: number[] = [];
    let pos = content.indexOf(sCand);
    while (pos !== -1) {
      exactPositions.push(pos);
      pos = content.indexOf(sCand, pos + 1);
    }
    if (exactPositions.length === 1) {
      const idx = exactPositions[0];
      return {
        ok: true,
        next: content.slice(0, idx) + rCand + content.slice(idx + sCand.length),
        note: null,
      };
    }
    if (exactPositions.length > 1) {
      const lineIndices = exactPositions.map((p) => content.slice(0, p).split('\n').length - 1);
      const chosen = pickUniqueOrHintedIndex(lineIndices, hintLine);
      if (chosen !== null) {
        const chosenPos = exactPositions[lineIndices.indexOf(chosen)];
        return {
          ok: true,
          next: content.slice(0, chosenPos) + rCand + content.slice(chosenPos + sCand.length),
          note: null,
        };
      }
      return {
        ok: false,
        error:
          'The SEARCH block matched multiple places in this file. Include 2-3 extra surrounding lines.',
      };
    }
  }

  const contentLines = content.split('\n');
  const cleanSearch = stripEdgeBlankLines(search);
  const cleanReplace = stripEdgeBlankLines(replace);
  const searchLines = cleanSearch.split('\n');
  const replaceLines = cleanReplace === '' ? [] : cleanReplace.split('\n');
  const trimmedSearch = searchLines.map((l) => l.trim());

  if (trimmedSearch.length === 0 || trimmedSearch.every((l) => l === '')) {
    return { ok: false, error: 'Empty SEARCH block.' };
  }

  // Tier 1.5: Exact leading indentation, ignoring trailing whitespace per line
  const rtrimMatches: number[] = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) rtrimMatches.push(i);
  }
  const rtrimStart = pickUniqueOrHintedIndex(rtrimMatches, hintLine);
  if (rtrimStart !== null) {
    const nextLines = [
      ...contentLines.slice(0, rtrimStart),
      ...replaceLines,
      ...contentLines.slice(rtrimStart + searchLines.length),
    ];
    return { ok: true, next: nextLines.join('\n'), note: null };
  }

  // Tier 2: Line-by-line trimmed whitespace match (handles indentation drift safely)
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

  const t2Start = pickUniqueOrHintedIndex(matches, hintLine);
  if (t2Start !== null) {
    const startLine = t2Start;
    const matchedSlice = contentLines.slice(startLine, startLine + trimmedSearch.length);
    const adjustedReplace = adjustReplacementIndent(
      replaceLines,
      matchedSlice,
      searchLines
    );
    const nextLines = [
      ...contentLines.slice(0, startLine),
      ...adjustedReplace,
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

  // Tier 3: Blank-line-tolerant trimmed match (handles added/omitted empty lines in SEARCH)
  const nonBlankSearch = trimmedSearch.filter((l) => l !== '');
  if (nonBlankSearch.length >= 2) {
    const nonBlankContent: Array<{ lineIdx: number; text: string }> = [];
    for (let i = 0; i < contentLines.length; i++) {
      const t = contentLines[i].trim();
      if (t !== '') nonBlankContent.push({ lineIdx: i, text: t });
    }

    const blankTolerantWindows: Array<{ startLine: number; endLine: number }> = [];
    for (let i = 0; i <= nonBlankContent.length - nonBlankSearch.length; i++) {
      let allOk = true;
      for (let j = 0; j < nonBlankSearch.length; j++) {
        if (nonBlankContent[i + j].text !== nonBlankSearch[j]) {
          allOk = false;
          break;
        }
      }
      if (allOk) {
        const startLine = nonBlankContent[i].lineIdx;
        const endLine = nonBlankContent[i + nonBlankSearch.length - 1].lineIdx;
        if (endLine - startLine <= searchLines.length + 5) {
          blankTolerantWindows.push({ startLine, endLine });
        }
      }
    }

    const chosenBtIdx = pickUniqueOrHintedIndex(
      blankTolerantWindows.map((w) => w.startLine),
      hintLine
    );
    if (chosenBtIdx !== null) {
      const win = blankTolerantWindows.find((w) => w.startLine === chosenBtIdx)!;
      const matchedSlice = contentLines.slice(win.startLine, win.endLine + 1);
      const adjustedReplace = adjustReplacementIndent(
        replaceLines,
        matchedSlice,
        searchLines
      );
      const nextLines = [
        ...contentLines.slice(0, win.startLine),
        ...adjustedReplace,
        ...contentLines.slice(win.endLine + 1),
      ];
      return {
        ok: true,
        next: nextLines.join('\n'),
        note: 'Auto-matched ignoring blank-line drift',
      };
    }
  }

  // Tier 3.5: Punctuation and Mojibake normalized line match
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

  const t3Start = pickUniqueOrHintedIndex(t3Matches, hintLine);
  if (t3Start !== null) {
    const startLine = t3Start;
    const matchedSlice = contentLines.slice(startLine, startLine + normSearchLines.length);
    const adjustedReplace = adjustReplacementIndent(
      replaceLines,
      matchedSlice,
      searchLines
    );
    const nextLines = [
      ...contentLines.slice(0, startLine),
      ...adjustedReplace,
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

  // Tier 4: Bounded anchor & token-tolerant window match
  const nonBlankSearchLines = searchLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (nonBlankSearchLines.length >= 2) {
    const candidateWindows: Array<{ startLine: number; endLine: number }> = [];

    for (let c = 0; c < contentLines.length; c++) {
      if (!lineMatches(nonBlankSearchLines[0], contentLines[c])) continue;

      const firstMatch = c;
      let curr = c + 1;
      let matchedCount = 1;
      let lastMatch = c;

      for (let s = 1; s < nonBlankSearchLines.length; s++) {
        let found = false;
        while (curr < contentLines.length && curr <= lastMatch + 3) {
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
        const span = lastMatch - firstMatch + 1;
        if (span <= searchLines.length + 4) {
          candidateWindows.push({ startLine: firstMatch, endLine: lastMatch });
        }
      }
    }

    const uniqueWindows: Array<{ startLine: number; endLine: number }> = [];
    for (const win of candidateWindows) {
      if (!uniqueWindows.some((u) => u.startLine === win.startLine && u.endLine === win.endLine)) {
        uniqueWindows.push(win);
      }
    }

    const chosenT4Start = pickUniqueOrHintedIndex(
      uniqueWindows.map((w) => w.startLine),
      hintLine
    );
    if (chosenT4Start !== null) {
      const { startLine, endLine } = uniqueWindows.find((w) => w.startLine === chosenT4Start)!;
      const matchedSlice = contentLines.slice(startLine, endLine + 1);
      const adjustedReplace = adjustReplacementIndent(
        replaceLines,
        matchedSlice,
        searchLines
      );
      const nextLines = [
        ...contentLines.slice(0, startLine),
        ...adjustedReplace,
        ...contentLines.slice(endLine + 1),
      ];
      return {
        ok: true,
        next: nextLines.join('\n'),
        note: 'Auto-matched with flexible line alignment',
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
    /^@@(?: -\d+(?:,\d+)? \+\d+(?:,\d+)? )?@@/m.test(block)
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
  text = text.replace(/^(`{3,})[ \t]*(?:diff|patch|git)?[ \t]+(diff --git |--- )/gm, '$1diff\n$2');

  // State-machine fenced extractor so embedded ``` inside Markdown diffs never truncate the patch
  const lines = text.split('\n');
  const extractedBlocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = /^[ \t]*(`{3,})(?:diff|patch|git|udiff)?[ \t]*$/i.exec(lines[i]);
    if (!openMatch) {
      i++;
      continue;
    }
    const fenceLen = openMatch[1].length;
    const closeRegex = new RegExp(`^[ \\t]*\`{${fenceLen},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    let closedAt = -1;

    while (j < lines.length) {
      if (closeRegex.test(lines[j])) {
        let peek = j + 1;
        while (peek < lines.length && lines[peek].trim() === '') peek++;
        const nextLine = peek < lines.length ? lines[peek] : '';
        const continuesDiff =
          /^(?:diff --git |--- |@@ )/.test(nextLine) &&
          !/^[ \t]*`{3,}/.test(nextLine);
        if (!continuesDiff) {
          closedAt = j;
          break;
        }
      }
      body.push(lines[j]);
      j++;
    }

    const candidate = stripTrailingFences(body.join('\n'));
    if (looksLikeUnifiedDiff(candidate)) {
      extractedBlocks.push(candidate);
    }
    i = closedAt !== -1 ? closedAt + 1 : j;
  }

  if (extractedBlocks.length > 0) {
    return extractedBlocks.join('\n') + '\n';
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
  const lines = diffText.split('\n');
  const rawChunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      rawChunks.push(current.join('\n'));
      current = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flush();
      current.push(line);
      continue;
    }
    if (
      line.startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ') &&
      current.some((l) => l.startsWith('@@'))
    ) {
      flush();
    }
    current.push(line);
  }
  flush();

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
  const diskLines = diskContentLf.split('\n');
  const diskSet = new Set(diskLines);
  const diskTrimEndSet = new Set(diskLines.map((l) => l.trimEnd()));
  const lines = chunk.split('\n');
  const out: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (/^(?:diff --git |index |--- |\+\+\+ |new file |deleted file |old mode |new mode |rename )/.test(line)) {
      inHunk = false;
      out.push(line);
      continue;
    }
    if (/^@@(?: -\d+(?:,\d+)? \+\d+(?:,\d+)? )?@@/.test(line)) {
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
      const inDisk = diskSet.has(line) || diskTrimEndSet.has(line.trimEnd());
      const strippedInDisk = diskSet.has(line.slice(1)) || diskTrimEndSet.has(line.slice(1).trimEnd());
      if (inDisk && !strippedInDisk) {
        out.push(' ' + line);
      } else {
        out.push(line);
      }
    } else if (line.startsWith('+') && !line.startsWith('++')) {
      const inDisk = diskSet.has(line) || diskTrimEndSet.has(line.trimEnd());
      const strippedInDisk = diskSet.has(line.slice(1)) || diskTrimEndSet.has(line.slice(1).trimEnd());
      if (inDisk && !strippedInDisk) {
        out.push(' ' + line);
      } else {
        out.push(line);
      }
    } else if (line.startsWith('--') || line.startsWith('++')) {
      out.push(line);
    } else if (diskSet.has(line) || diskTrimEndSet.has(line.trimEnd())) {
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
    const m = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?)? @@(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }

    const oldStart = m[1] ?? '1';
    const newStart = m[2] ?? '1';
    const suffix = m[3] ?? '';
    const hunkBody: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    i++;

    while (
      i < lines.length &&
      !/^@@(?: -\d+(?:,\d+)? \+\d+(?:,\d+)?)? @@/.test(lines[i]) &&
      !lines[i].startsWith('diff --git ')
    ) {
      const b = lines[i] === '' ? ' ' : lines[i];
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

function applyUnifiedHunksFallback(
  baseContent: string,
  chunk: string
): { ok: true; content: string } | { ok: false } {
  const lines = chunk.split('\n');
  const hunks: Array<{ oldStart: number; search: string[]; replace: string[] }> = [];
  let current: { oldStart: number; search: string[]; replace: string[] } | null = null;
  let lineOffset = 0;

  for (const line of lines) {
    const hm = /^@@(?: -(\d+)(?:,\d+)? \+\d+(?:,\d+)?)? @@/.exec(line);
    if (hm) {
      if (current) hunks.push(current);
      current = {
        oldStart: hm[1] ? Number(hm[1]) : 1,
        search: [],
        replace: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('\\ No newline')) continue;
    if (line.startsWith(' ')) {
      current.search.push(line.slice(1));
      current.replace.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.search.push(line.slice(1));
    } else if (line.startsWith('+')) {
      current.replace.push(line.slice(1));
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) return { ok: false };

  let working = baseContent;
  for (const hunk of hunks) {
    if (hunk.search.length === 0) {
      if (working === '') {
        working = hunk.replace.join('\n');
        continue;
      }
      return { ok: false };
    }
    const res = applySingleSearchReplace(
      working,
      hunk.search.join('\n'),
      hunk.replace.join('\n'),
      hunk.oldStart + lineOffset
    );
    if (!res.ok) return { ok: false };
    working = res.next;
    lineOffset += hunk.replace.length - hunk.search.length;
  }
  return { ok: true, content: preserveTrailingNewline(baseContent, working) };
}

// -----------------------------------------------------------------------------
// PUBLIC ENTRYPOINT: PARSE, HEAL & BUILD PREVIEW
// -----------------------------------------------------------------------------

export function hasDetectablePatch(rawText: string): boolean {
  if (!rawText || rawText.length < 15) return false;
  const text = normalizeEol(rawText);
  if (/(?:<[ \t]*){4,12}[ \t]*SEARCH/i.test(text) && /(?:>[ \t]*){4,12}[ \t]*REPLACE/i.test(text)) return true;
  if (/^[ \t]*(?:[#*>\s\-\/\d.]*)(?:CREATE FILE|NEW FILE|DELETE FILE|REMOVE FILE)\*{0,2}\s*:/mi.test(text)) return true;
  if (text.includes('@@') && looksLikeUnifiedDiff(text)) return true;
  return false;
}

export function parseAndPreviewPatch(
  repoPath: string,
  rawText: string,
  preferredFormat: PatchFormat = 'search_replace'
): ParsePatchResponse | null {
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
  const repoFiles = collectRepoFilePaths(repoPath);

  // 1. Process SEARCH/REPLACE, CREATE FILE, DELETE FILE operations (grouped by file)
  const srGrouped = new Map<string, SearchReplaceOp[]>();
  for (const op of srOps) {
    const resolvedPath = op.kind === 'create' ? normalizeRepoRelPath(op.filePath) : resolveSmartRepoFilePath(repoPath, op.filePath, repoFiles);
    const list = srGrouped.get(resolvedPath) ?? [];
    list.push({ ...op, filePath: resolvedPath });
    srGrouped.set(resolvedPath, list);
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

    // Surface malformed SEARCH/REPLACE blocks explicitly instead of silently skipping
    const malformedOp = ops.find((o) => o.kind === 'malformed');
    if (malformedOp) {
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: malformedOp.error ?? 'Malformed SEARCH/REPLACE block.',
        originalContent: disk.contentLf,
        proposedContent: disk.contentLf,
        additions: 0,
        deletions: 0,
      });
      continue;
    }

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
        hadCrlf: disk.hadCrlf,
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
        hadCrlf: disk.hadCrlf,
      });
      continue;
    }

    // Handle sequential SEARCH/REPLACE blocks on existing file
    if (!disk.exists) {
      const hints = suggestClosestPaths(repoFiles, filePath);
      const hintMsg =
        hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : '';
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: `File not found in your project.${hintMsg} Use CREATE FILE for brand-new files.`,
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

    for (let idx = 0; idx < ops.length; idx++) {
      const op = ops[idx];
      const applied = applySingleSearchReplace(working, op.search ?? '', op.replace ?? '');
      if (!applied.ok) {
        const previewLine = (op.search ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
        const snippet = previewLine ? ` Near: "${previewLine.slice(0, 70)}"` : '';
        failedReason =
          ops.length > 1
            ? `Block ${idx + 1} of ${ops.length} failed: ${applied.error}${snippet}`
            : `${applied.error}${snippet}`;
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
      hadCrlf: disk.hadCrlf,
    });
  }

  // 2. Process Unified Diff chunks (grouped by file so multiple chunks apply sequentially)
  const unifiedGrouped = new Map<string, string[]>();
  for (const { filePath, chunk } of unifiedChunks) {
    const isNew = /^--- \/dev\/null/m.test(chunk);
    const resolvedPath = isNew ? normalizeRepoRelPath(filePath) : resolveSmartRepoFilePath(repoPath, filePath, repoFiles);
    const list = unifiedGrouped.get(resolvedPath) ?? [];
    list.push(chunk);
    unifiedGrouped.set(resolvedPath, list);
  }

  for (const [filePath, chunks] of unifiedGrouped.entries()) {
    if (handledPaths.has(filePath)) continue;
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

    const firstChunk = chunks[0];
    const isDeleteFile = chunks.some((c) => /^\+\+\+ \/dev\/null/m.test(c));
    const disk = readDiskFile(repoPath, filePath);
    const isNewFile =
      /^--- \/dev\/null/m.test(firstChunk) ||
      (!disk.exists && /^@@ -0,0 \+1/m.test(firstChunk));

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
        hadCrlf: disk.hadCrlf,
      });
      continue;
    }

    const baseContent = isNewFile ? '' : disk.contentLf;
    if (!isNewFile && !disk.exists) {
      const hints = suggestClosestPaths(repoFiles, filePath);
      const hintMsg =
        hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : '';
      files.push({
        filePath,
        action: 'modify',
        status: 'failed',
        repairNote: null,
        securityWarning,
        errorReason: `File not found in your active project folder.${hintMsg}`,
        originalContent: '',
        proposedContent: '',
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    let working = baseContent;
    const repairNotes = new Set<string>();
    let chunkFailed = false;

    for (const chunk of chunks) {
      const baseNormalized = chunk.replace(/\r\n/g, '\n');
      const repairedChunk = recountHunkHeaders(baseNormalized);
      let patched = applyPatch(working, repairedChunk, { fuzzFactor: 2 });

      if (patched === false) {
        const mdFixed = recountHunkHeaders(repairUnifiedHunkLines(working, baseNormalized));
        patched = applyPatch(working, mdFixed, { fuzzFactor: 2 });
        if (patched !== false) {
          repairNotes.add('Auto-fixed minor AI diff formatting');
        } else {
          const fallback = applyUnifiedHunksFallback(working, mdFixed);
          if (fallback.ok) {
            patched = fallback.content;
            repairNotes.add('Auto-aligned drifted diff hunks');
          }
        }
      }

      if (patched === false) {
        chunkFailed = true;
        break;
      }
      working = preserveTrailingNewline(working, patched);
    }

    if (chunkFailed) {
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
    const stats = countDiffStats(disk.contentLf, working);
    files.push({
      filePath,
      action,
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
      action,
      status: 'ready',
      proposedContent: disk.hadCrlf ? working.replace(/\n/g, '\r\n') : working,
      expectedDiskSha256: disk.rawSha256,
      existedBefore: disk.exists,
      hadCrlf: disk.hadCrlf,
    });
  }

  parseCache.set(parseId, {
    parseId,
    repoPath,
    createdAt: Date.now(),
    plans,
  });

  const readyCount = files.filter((f) => f.status === 'ready').length;
  const readyFiles = files.filter((f) => f.status === 'ready');
  const failedFiles = files.filter((f) => f.status === 'failed');
  const blockedCount = files.filter((f) => f.status === 'blocked').length;

  let retryPrompt: string | null = null;
  if (failedFiles.length > 0) {
    const lines = [
      '================================================================================',
      'CORRECTION REQUIRED: PATCH ENGINE COULD NOT APPLY EDITS TO THE FOLLOWING FILE(S)',
      '================================================================================',
    ];
    if (readyFiles.length > 0) {
      lines.push(
        `ALREADY PARSED CLEANLY (DO NOT REGENERATE THESE): ${readyFiles.map((f) => f.filePath).join(', ')}`
      );
      lines.push('');
    }
    lines.push('FAILED FILES (REGENERATE EDITS ONLY FOR THESE):');
    for (const ff of failedFiles) {
      lines.push(`- File: \`${ff.filePath}\``);
      lines.push(`  Failure Reason: ${ff.errorReason}`);
    }
    lines.push('');

    // Auto-attach exact current on-disk source code of failed files for 1-shot recovery
    const attachedSources: string[] = [];
    for (const ff of failedFiles) {
      if (!ff.originalContent) continue;
      const scanned = scanAndRedactSecrets(ff.originalContent, true).redactedContent;
      const capped =
        scanned.length > 45_000
          ? `${scanned.slice(0, 45_000)}\n/* ... truncated at 45KB ... */`
          : scanned;
      attachedSources.push(`<file path="${ff.filePath}">\n${capped.trimEnd()}\n</file>`);
    }

    if (attachedSources.length > 0) {
      lines.push('CURRENT ON-DISK SOURCE OF FAILED FILE(S) (USE THESE EXACT LINES):');
      lines.push('');
      lines.push(...attachedSources);
      lines.push('');
    }

    if (preferredFormat === 'unified_diff') {
      lines.push('Regenerate a valid unified `git diff` inside ONE ```diff ... ``` code block ONLY for the failed file(s) above:');
      lines.push('- Start unchanged context lines with a single leading space " ".');
      lines.push('- Copy context and removed lines verbatim from the attached <file> block.');
      lines.push('- Include 3 unchanged lines above and below every edit. Never use placeholders.');
    } else {
      const outerFence = '`'.repeat(4);
      lines.push(`Regenerate edits ONLY for the failed file(s) above inside ONE ${outerFence}patch ... ${outerFence} code block:`);
      lines.push('');
      lines.push(`${outerFence}patch`);
      lines.push('FILE: path/to/file.ext');
      lines.push('<<<<<<< SEARCH');
      lines.push('[exact lines copied verbatim from the <file> block above, with 3 lines of context]');
      lines.push('=======');
      lines.push('[new replacement lines]');
      lines.push('>>>>>>> REPLACE');
      lines.push(outerFence);
      lines.push('');
      lines.push(`RULES: Always wrap ALL blocks inside ONE ${outerFence}patch code block (never raw Markdown so ======= and >>>>>>> are not mangled), exact indentation, never omit =======, no placeholder comments.`);
    }
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
