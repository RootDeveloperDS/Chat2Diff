import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateModelFit, TASK_PRESETS } from '../../shared/constants.js';
import type { PackRequest, PackResponse, PackWarning, TurnSyncStatus } from '../../shared/types.js';
import { normalizeRepoRelPath, resolveSafeRepoPath } from './pathGuard.js';
import { scanAndRedactSecrets } from './secretGuard.js';

const FENCE = '```';
const OUTER_FENCE = '`'.repeat(4);
const lastSentHashesByRepo = new Map<string, Map<string, string>>();
let diskHashesLoaded = false;

interface PersistedSentHashes {
  version: number;
  repos: Record<string, { updatedAt: string; hashes: Record<string, string> }>;
}

function getSentHashesPath(): string {
  const baseDir = process.env.CHAT2DIFF_CONFIG_DIR || path.join(os.homedir(), '.chat2diff');
  return path.join(baseDir, 'sent-hashes.json');
}

function hydrateSentHashesFromDisk(): void {
  if (diskHashesLoaded) return;
  diskHashesLoaded = true;
  const filePath = getSentHashesPath();
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PersistedSentHashes>;
    if (!parsed.repos || typeof parsed.repos !== 'object') return;
    for (const [repoKey, entry] of Object.entries(parsed.repos)) {
      if (entry && entry.hashes && typeof entry.hashes === 'object') {
        lastSentHashesByRepo.set(repoKey, new Map(Object.entries(entry.hashes)));
      }
    }
  } catch {
    // Non-fatal if cache is unreadable
  }
}

function saveRepoSentHashes(repoKey: string, hashes: Map<string, string>): void {
  lastSentHashesByRepo.set(repoKey, hashes);
  const filePath = getSentHashesPath();
  const dir = path.dirname(filePath);
  try {
    let existingRepos: PersistedSentHashes['repos'] = {};
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PersistedSentHashes>;
        if (parsed.repos && typeof parsed.repos === 'object') {
          existingRepos = { ...parsed.repos };
        }
      } catch {
        existingRepos = {};
      }
    }
    existingRepos[repoKey] = {
      updatedAt: new Date().toISOString(),
      hashes: Object.fromEntries(hashes.entries()),
    };
    const recentEntries = Object.entries(existingRepos)
      .sort((a, b) => (b[1]?.updatedAt ?? '').localeCompare(a[1]?.updatedAt ?? ''))
      .slice(0, 15);
    const payload: PersistedSentHashes = {
      version: 1,
      repos: Object.fromEntries(recentEntries),
    };
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Non-fatal if home directory is read-only
  }
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function getFormatInstructions(format: PackRequest['patchFormatPreference']): string {
  if (format === 'unified_diff') {
    return [
      '================================================================================',
      'OUTPUT SPECIFICATION: UNIFIED GIT DIFF FORMAT (STRICT AUTOMATED PARSER)',
      '================================================================================',
      'Your output will be parsed directly by an automated local patch engine.',
      'You MUST adhere strictly to the following syntax rules:',
      '',
      '1. Start with a concise 2-4 bullet summary of what you are changing and why.',
      `2. Put ALL code changes inside a SINGLE ${FENCE}diff ... ${FENCE} code block.`,
      '3. For each modified file:',
      '   diff --git a/path/to/file.ext b/path/to/file.ext',
      '   --- a/path/to/file.ext',
      '   +++ b/path/to/file.ext',
      '   @@ -<start_line>,<count> +<start_line>,<count> @@',
      '4. For brand-new files:',
      '   --- /dev/null',
      '   +++ b/path/to/newfile.ext',
      '5. For deleted files:',
      '   --- a/path/to/oldfile.ext',
      '   +++ /dev/null',
      '6. STRICT LINE RULES:',
      '   - Unchanged context lines MUST start with a literal single space: " "',
      '   - Deleted lines MUST start with a minus sign: "-"',
      '   - Added lines MUST start with a plus sign: "+"',
      '   - Include 3 unchanged context lines above and below each change.',
      '   - NEVER use placeholder comments like `// ... existing code ...` or `// ... rest of file ...`.',
      '================================================================================',
    ].join('\n');
  }

  return [
    '================================================================================',
    'OUTPUT SPECIFICATION: SEARCH/REPLACE BLOCKS (STRICT AUTOMATED PARSER)',
    '================================================================================',
    'Your output is parsed directly by an automated local patch engine.',
    `You MUST put ALL code modifications inside ONE single ${OUTER_FENCE}patch ... ${OUTER_FENCE} code block.`,
    '(Using a 4-backtick outer code block prevents Markdown from eating ======= or mangling JSX/types.)',
    '',
    '### MANDATORY SYNTAX STRUCTURE:',
    '',
    `${OUTER_FENCE}patch`,
    'FILE: path/to/file.ext',
    '<<<<<<< SEARCH',
    '[exact existing lines to replace, with 2-3 surrounding context lines]',
    '=======',
    '[new replacement lines to put in their place]',
    '>>>>>>> REPLACE',
    '',
    'CREATE FILE: path/to/new-file.ext',
    '<<<<<<< SEARCH',
    '=======',
    '[full file content]',
    '>>>>>>> REPLACE',
    '',
    'DELETE FILE: path/to/file-to-delete.ext',
    `${OUTER_FENCE}`,
    '',
    '### 6 STRICT RULES FOR 100% ACCURACY:',
    `1. WRAP EVERYTHING IN ONE ${OUTER_FENCE}patch CODE BLOCK:`,
    `   - Start with ${OUTER_FENCE}patch on its own line and end with ${OUTER_FENCE} on its own line.`,
    '   - Never output raw unfenced SEARCH/REPLACE blocks outside the code block.',
    '',
    '2. EXACT VERBATIM SEARCH BLOCKS:',
    '   - Copy exact indentation, quotes, brackets, and ALL HTML/JSX/type syntax byte-for-byte.',
    '',
    '3. NO PLACEHOLDERS OR ELLIPSES:',
    '   - NEVER write comments like `// ... existing code ...` or `// ... rest of file ...`.',
    '',
    '4. NO LINE NUMBERS OR ANNOTATIONS:',
    '   - Output only clean source lines (never prefix with line numbers).',
    '',
    '5. EXACT 7-CHARACTER DELIMITERS:',
    '   - `<<<<<<< SEARCH`, `=======`, and `>>>>>>> REPLACE` each on their own line.',
    '   - NEVER omit `=======`.',
    '',
    '6. CONTEXT FOR UNIQUENESS:',
    '   - Include 2-3 unchanged lines immediately above and below every change so the match is unique.',
    '================================================================================',
  ].join('\n');
}

function getCompactFollowUpFormatReminder(format: PackRequest['patchFormatPreference']): string {
  if (format === 'unified_diff') {
    return [
      'OUTPUT FORMAT: Return ALL code changes inside ONE ```diff ... ``` block with exact relative paths (`a/path`, `b/path`), single leading space on unchanged lines, 3 context lines, and zero placeholders.',
    ].join('\n');
  }
  return [
    `OUTPUT FORMAT: Return ALL code changes inside ONE ${OUTER_FENCE}patch ... ${OUTER_FENCE} code block using \`FILE: path/to/file.ext\`, \`<<<<<<< SEARCH\`, verbatim lines with 2-3 lines context, \`=======\`, replacement lines, \`>>>>>>> REPLACE\` (or \`CREATE FILE:\` / \`DELETE FILE:\`). Never output unfenced blocks and never use placeholders.`,
  ].join('\n');
}

function buildTurnSyncSection(
  turnSync: TurnSyncStatus | null | undefined,
  attachedPaths: Set<string>,
  attachLocationLabel: string
): string {
  if (!turnSync) return '';
  const parts: string[] = [];
  if (turnSync.appliedFiles.length > 0) {
    parts.push(
      `- APPLIED TO DISK (ground your next edits on these updated versions): ${turnSync.appliedFiles.join(', ')}`
    );
  }
  if (turnSync.partiallyAppliedFiles.length > 0) {
    const anyAttached = turnSync.partiallyAppliedFiles.some((p) =>
      attachedPaths.has(normalizeRepoRelPath(p))
    );
    parts.push(
      `- PARTIALLY APPLIED (${
        anyAttached
          ? `only some change blocks applied; ${attachLocationLabel}`
          : 'only some change blocks applied on disk'
      }): ${turnSync.partiallyAppliedFiles.join(', ')}`
    );
  }
  if (turnSync.notAppliedFiles.length > 0) {
    parts.push(
      `- NOT APPLIED / SKIPPED BY USER (still at their previous version on disk — do NOT assume these edits exist): ${turnSync.notAppliedFiles.join(', ')}`
    );
  }
  if (turnSync.failedFiles.length > 0) {
    const anyAttached = turnSync.failedFiles.some((f) =>
      attachedPaths.has(normalizeRepoRelPath(f.filePath))
    );
    const list = turnSync.failedFiles.map((f) => `${f.filePath} (${f.reason})`).join('; ');
    parts.push(
      `- FAILED TO APPLY (${
        anyAttached ? `not written to disk; ${attachLocationLabel}` : 'not written to disk'
      }): ${list}`
    );
  }
  if (turnSync.undoneFiles.length > 0) {
    const anyAttached = turnSync.undoneFiles.some((p) =>
      attachedPaths.has(normalizeRepoRelPath(p))
    );
    parts.push(
      `- REVERTED / UNDONE BY USER (${
        anyAttached
          ? `restored to pre-patch state; ${attachLocationLabel}`
          : 'restored to pre-patch state on disk'
      }): ${turnSync.undoneFiles.join(', ')}`
    );
  }
  if (parts.length === 0) return '';
  return [
    '================================================================================',
    'WORKSPACE SYNC STATUS (EXACT GROUND TRUTH FROM PREVIOUS TURN):',
    '================================================================================',
    ...parts,
    '================================================================================',
  ].join('\n');
}

export function buildPackResponse(repoPath: string, req: PackRequest): PackResponse {
  hydrateSentHashesFromDisk();
  const resolvedRepo = path.resolve(repoPath);
  const repoKey = resolvedRepo.toLowerCase();
  const repoName = path.basename(resolvedRepo);
  const safeSlug = repoName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'project';
  const contextFileName = `chat2diff-context-${safeSlug}.txt`;
  const chatMode = req.chatMode ?? 'new_chat';
  const attachMode =
    req.followUpAttachMode ?? (req.includeSelectedInFollowUp ? 'all' : 'smart');
  const fileBundleStyle = req.fileBundleStyle ?? 'all_in_one';
  const isAllInOneFile = req.mode === 'file_attachment' && fileBundleStyle === 'all_in_one';

  const fileBlocks: string[] = [];
  const includedPaths: string[] = [];
  const warnings: PackWarning[] = [];
  let totalRedacted = 0;

  const uniqueSelected = Array.from(new Set(req.selectedPaths.map(normalizeRepoRelPath))).sort();
  const existingMap = lastSentHashesByRepo.get(repoKey);
  const hadPriorHashes = Boolean(existingMap && existingMap.size > 0);
  const prevHashes =
    chatMode === 'follow_up'
      ? new Map(existingMap ?? [])
      : new Map<string, string>();

  let pathsToRead: string[];
  if (chatMode === 'new_chat' || attachMode === 'all') {
    pathsToRead = uniqueSelected;
  } else {
    const appliedSet = new Set((req.turnSync?.appliedFiles ?? []).map(normalizeRepoRelPath));

    // Update tracked hashes for cleanly applied files so future turns detect external edits
    for (const p of appliedSet) {
      try {
        const abs = resolveSafeRepoPath(repoPath, p);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
          prevHashes.set(p, hashText(raw));
        }
      } catch {
        // ignore missing/deleted applied file
      }
    }

    if (attachMode === 'none') {
      pathsToRead = [];
    } else {
      // Smart Delta Follow-Up: only attach files needing updated ground truth
      const mustAttach = new Set<string>();

      for (const p of req.turnSync?.partiallyAppliedFiles ?? []) {
        mustAttach.add(normalizeRepoRelPath(p));
      }
      for (const ff of req.turnSync?.failedFiles ?? []) {
        mustAttach.add(normalizeRepoRelPath(ff.filePath));
      }
      for (const p of req.turnSync?.undoneFiles ?? []) {
        mustAttach.add(normalizeRepoRelPath(p));
      }

      if (hadPriorHashes) {
        for (const relPath of uniqueSelected) {
          if (appliedSet.has(relPath) || mustAttach.has(relPath)) continue;
          try {
            const abs = resolveSafeRepoPath(repoPath, relPath);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
            const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
            const currentHash = hashText(raw);
            const lastHash = prevHashes.get(relPath);
            if (!lastHash || lastHash !== currentHash) {
              mustAttach.add(relPath);
            }
          } catch {
            // skip unreadable
          }
        }
      }

      pathsToRead = Array.from(mustAttach).sort();
    }
  }

  for (const relPath of pathsToRead) {
    const absPath = resolveSafeRepoPath(repoPath, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      continue;
    }

    const raw = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
    prevHashes.set(relPath, hashText(raw));
    const secretScan = scanAndRedactSecrets(raw, req.redactSecrets);
    if (secretScan.count > 0) {
      totalRedacted += secretScan.count;
      warnings.push({
        filePath: relPath,
        reason: req.redactSecrets
          ? `Masked ${secretScan.count} possible secret(s): ${secretScan.labels.join(', ')}`
          : `Detected ${secretScan.count} possible secret(s) (unmasked): ${secretScan.labels.join(', ')}`,
      });
    }

    includedPaths.push(relPath);
    fileBlocks.push(`<file path="${relPath}">\n${secretScan.redactedContent.trimEnd()}\n</file>`);
  }

  saveRepoSentHashes(repoKey, prevHashes);

  const contextBody =
    includedPaths.length > 0
      ? [
          `# PROJECT CONTEXT: ${repoName}`,
          `# Files included: ${includedPaths.length}`,
          '',
          '<file_list>',
          ...includedPaths,
          '</file_list>',
          '',
          '',
          ...fileBlocks,
          '',
        ].join('\n')
      : '';

  const presetMeta = TASK_PRESETS[req.preset];
  const errorSection = req.errorLog?.trim()
    ? `\nERROR / TERMINAL OUTPUT:\n${FENCE}\n${req.errorLog.trim()}\n${FENCE}\n`
    : '';
  const attachLocationLabel =
    req.mode === 'file_attachment' && !isAllInOneFile
      ? `current on-disk source attached in ${contextFileName}`
      : 'current on-disk source attached below';
  const syncSection =
    chatMode === 'follow_up'
      ? buildTurnSyncSection(req.turnSync, new Set(includedPaths), attachLocationLabel)
      : '';

  let instructionsBlock: string;
  if (chatMode === 'follow_up') {
    instructionsBlock = [
      `FOLLOW-UP REQUEST (${repoName}) — continuing this existing conversation.`,
      '',
      syncSection,
      syncSection ? '' : undefined,
      `GOAL: ${presetMeta.instruction}`,
      '',
      'NEXT REQUEST:',
      req.taskDescription.trim(),
      errorSection || undefined,
      '',
      includedPaths.length > 0
        ? req.mode === 'file_attachment' && !isAllInOneFile
          ? `Updated/relevant file(s) attached in \`${contextFileName}\` (${includedPaths.length} file(s)). Read that attached file first and use those exact lines as ground truth.`
          : `Updated/relevant file(s) included below (${includedPaths.length} file(s)). Use those exact lines as ground truth.`
        : 'No full project re-upload needed — base your edits on the sync status above and our conversation history.',
      '',
      getCompactFollowUpFormatReminder(req.patchFormatPreference),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n')
      .trim();
  } else {
    instructionsBlock = [
      `You are an expert Principal software engineer generating code changes for the "${repoName}" project.`,
      'Your output will be applied automatically by a local patch engine.',
      '',
      `GOAL: ${presetMeta.instruction}`,
      '',
      getFormatInstructions(req.patchFormatPreference),
      '',
      '================================================================================',
      'USER TASK / REQUEST:',
      '================================================================================',
      req.taskDescription.trim(),
      errorSection,
      '',
      '================================================================================',
      'SOURCE FILES INSTRUCTION:',
      '================================================================================',
      req.mode === 'file_attachment' && !isAllInOneFile
        ? `Project files are attached in \`${contextFileName}\`. Read the relevant files first before generating patches.`
        : 'Project files are provided below inside `<file path="...">...</file>` tags.',
      req.patchFormatPreference === 'unified_diff'
        ? 'When targeting a file, copy its exact relative path from the `path` attribute into `diff --git a/path b/path`, `--- a/path`, and `+++ b/path`.'
        : 'When targeting a file, copy its exact relative path from the `path` attribute (e.g. `FILE: path/to/file.ext`).',
      req.patchFormatPreference === 'unified_diff'
        ? 'Copy all unchanged context and removed lines verbatim from the source file, with a single leading space on unchanged lines.'
        : 'Copy SEARCH lines verbatim from the actual file contents (including indentation, brackets, and JSX tags).',
      '================================================================================',
    ]
      .filter((line) => line !== undefined)
      .join('\n')
      .trim();
  }

  let promptText: string;
  let contextFileContent: string | null = null;

  if (req.mode === 'file_attachment' && contextBody) {
    if (isAllInOneFile) {
      contextFileContent = `${instructionsBlock}\n\nPROJECT FILES:\n\n${contextBody}\n`;
      promptText = `Follow all instructions and rules inside the attached \`${contextFileName}\` file.`;
    } else {
      contextFileContent = contextBody + '\n';
      promptText = [
        chatMode === 'follow_up'
          ? `I have attached ${includedPaths.length} updated/relevant file(s) in \`${contextFileName}\`. Read it first before answering.`
          : `I have attached my project files in \`${contextFileName}\`. Read the relevant files first before answering.`,
        '',
        instructionsBlock,
      ].join('\n');
    }
  } else if (contextBody) {
    promptText = `${instructionsBlock}\n\nPROJECT FILES:\n\n${contextBody}\n`;
  } else {
    promptText = `${instructionsBlock}\n`;
  }

  const totalChars =
    isAllInOneFile && contextFileContent
      ? contextFileContent.length
      : promptText.length + (contextFileContent ? contextFileContent.length : 0);
  const estimatedTokens = Math.max(1, Math.ceil(totalChars / 4));

  return {
    promptText,
    contextFileContent,
    contextFileName,
    fileBundleStyle,
    stats: {
      fileCount: includedPaths.length,
      estimatedTokens,
      redactedSecretsCount: totalRedacted,
      modelFit: evaluateModelFit(estimatedTokens),
      chatMode,
      attachedFiles: includedPaths,
    },
    warnings,
  };
}
