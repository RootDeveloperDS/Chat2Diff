import fs from 'node:fs';
import path from 'node:path';
import { evaluateModelFit, TASK_PRESETS } from '../../shared/constants.js';
import type { PackRequest, PackResponse, PackWarning } from '../../shared/types.js';
import { normalizeRepoRelPath, resolveSafeRepoPath } from './pathGuard.js';
import { scanAndRedactSecrets } from './secretGuard.js';

const FENCE = '```';

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
    'You MUST format all code modifications using exact Search/Replace blocks.',
    '',
    '### MANDATORY SYNTAX STRUCTURE:',
    '',
    'FILE: path/to/file.ext',
    '<<<<<<< SEARCH',
    '[exact existing lines to replace, with 2-3 surrounding context lines]',
    '=======',
    '[new replacement lines to put in their place]',
    '>>>>>>> REPLACE',
    '',
    '### FOR BRAND-NEW FILES:',
    'CREATE FILE: path/to/new-file.ext',
    `${FENCE}`,
    '[full file content]',
    `${FENCE}`,
    '',
    '### FOR DELETED FILES:',
    'DELETE FILE: path/to/file-to-delete.ext',
    '',
    '### 7 STRICT RULES FOR 100% ACCURACY (ZERO-TOLERANCE):',
    '1. ZERO MARKDOWN CODE FENCES AROUND SEARCH/REPLACE BLOCKS:',
    '   - Do NOT wrap `FILE:`, `<<<<<<< SEARCH`, `=======`, or `>>>>>>> REPLACE` inside triple backtick fences (```).',
    '   - Output the `FILE:` lines and delimiter blocks as raw plain text.',
    '',
    '2. EXACT VERBATIM SEARCH BLOCKS:',
    '   - The code inside `<<<<<<< SEARCH` MUST match the source file byte-for-byte.',
    '   - Copy exact indentation, quotes, brackets, and ALL HTML/JSX tags (e.g. `<div>`, `<button>`).',
    '   - Never strip, summarize, or alter tags in the SEARCH block.',
    '',
    '3. NO PLACEHOLDERS OR ELLIPSES:',
    '   - NEVER write comments like `// ... existing code ...`, `// ... rest of file ...`, or `/* unchanged */`.',
    '   - Every line in SEARCH and REPLACE must be real, valid code.',
    '',
    '4. NO LINE NUMBERS OR ANNOTATIONS:',
    '   - Do NOT write line numbers (e.g. do NOT write `12: const x = 1` or `Line 42:`).',
    '   - Output only the clean source lines.',
    '',
    '5. EXACT 7-CHARACTER DELIMITERS:',
    '   - Write `<<<<<<< SEARCH` on its own line (exactly 7 "<", a space, and "SEARCH").',
    '   - Write `=======` on its own line (exactly 7 "="). NEVER omit this separator.',
    '   - Write `>>>>>>> REPLACE` on its own line (exactly 7 ">", a space, and "REPLACE").',
    '   - Do NOT put spaces between brackets (e.g., `> > > > > > >` is invalid).',
    '',
    '6. NO MARKDOWN BLOCKQUOTES:',
    '   - Do NOT prefix lines with `>` or blockquote characters.',
    '',
    '7. CONTEXT FOR UNIQUENESS:',
    '   - Always include 2-3 unchanged lines immediately above and below the change inside the SEARCH block so it matches a single unique location.',
    '',
    '### CONCRETE EXAMPLE:',
    '',
    'FILE: src/components/Header.tsx',
    '<<<<<<< SEARCH',
    '    <header className="site-header">',
    '      <h1>My Application</h1>',
    '      <nav>',
    '=======',
    '    <header className="site-header sticky top-0 z-50">',
    '      <h1>Chat2Diff Pro</h1>',
    '      <nav className="flex items-center gap-4">',
    '>>>>>>> REPLACE',
    '================================================================================',
  ].join('\n');
}

export function buildPackResponse(repoPath: string, req: PackRequest): PackResponse {
  const repoName = path.basename(path.resolve(repoPath));
  const safeSlug = repoName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'project';
  const contextFileName = `chat2diff-context-${safeSlug}.txt`;

  const fileBlocks: string[] = [];
  const includedPaths: string[] = [];
  const warnings: PackWarning[] = [];
  let totalRedacted = 0;

  const uniquePaths = Array.from(new Set(req.selectedPaths.map(normalizeRepoRelPath))).sort();

  for (const relPath of uniquePaths) {
    const absPath = resolveSafeRepoPath(repoPath, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      continue;
    }

    const raw = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
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

  const contextBody = [
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
  ].join('\n');

  const presetMeta = TASK_PRESETS[req.preset];
  const errorSection = req.errorLog?.trim()
    ? `\nERROR / TERMINAL OUTPUT:\n${FENCE}\n${req.errorLog.trim()}\n${FENCE}\n`
    : '';

  const instructionsBlock = [
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
    req.mode === 'file_attachment'
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

  let promptText: string;
  let contextFileContent: string | null = null;

  if (req.mode === 'file_attachment') {
    contextFileContent = contextBody + '\n';
    promptText = [
      `I have attached my project files in \`${contextFileName}\`. Read the relevant files first before answering.`,
      '',
      instructionsBlock,
    ].join('\n');
  } else {
    promptText = `${instructionsBlock}\n\nPROJECT FILES:\n\n${contextBody}\n`;
  }

  const totalChars = promptText.length + (contextFileContent ? contextFileContent.length : 0);
  const estimatedTokens = Math.max(1, Math.ceil(totalChars / 4));

  return {
    promptText,
    contextFileContent,
    contextFileName,
    stats: {
      fileCount: includedPaths.length,
      estimatedTokens,
      redactedSecretsCount: totalRedacted,
      modelFit: evaluateModelFit(estimatedTokens),
    },
    warnings,
  };
}
