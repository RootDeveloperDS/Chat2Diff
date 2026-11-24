import { useEffect, useMemo, useState } from 'react';
import { diffLines, diffWordsWithSpace } from 'diff';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Columns2,
  Copy,
  FileDiff,
  Maximize2,
  Minimize2,
  RotateCcw,
  Rows2,
  ShieldAlert,
  Sparkles,
  WrapText,
} from 'lucide-react';
import type { ParsedFileDiff } from '../../shared/types.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

interface UnifiedRow {
  type: 'ctx' | 'add' | 'del';
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

interface SplitRow {
  leftType: 'ctx' | 'del' | 'empty';
  rightType: 'ctx' | 'add' | 'empty';
  oldNum: number | null;
  newNum: number | null;
  leftText: string;
  rightText: string;
  isModifiedPair: boolean;
}

interface ContextSegment {
  kind: 'context';
  id: number;
  raw: string;
  rows: UnifiedRow[];
}

interface HunkSegment {
  kind: 'hunk';
  id: number;
  oldRaw: string;
  newRaw: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  additions: number;
  deletions: number;
  unifiedRows: UnifiedRow[];
  splitRows: SplitRow[];
}

type DiffSegment = ContextSegment | HunkSegment;

const VIEW_MODE_KEY = 'chat2diff_diff_view_mode';
const WRAP_LINES_KEY = 'chat2diff_diff_wrap_lines';
const FULL_FILE_KEY = 'chat2diff_diff_full_file';
const CONTEXT_RADIUS = 3;
const MAX_WORD_DIFF_LINE_LEN = 500;

function splitLinesSafe(value: string): string[] {
  if (!value) return [];
  const trimmed = value.endsWith('\n') ? value.slice(0, -1) : value;
  return trimmed.split('\n');
}

function buildDiffSegments(originalContent: string, proposedContent: string): DiffSegment[] {
  const parts = diffLines(originalContent, proposedContent);
  const rawSegments: Array<
    | { kind: 'context'; raw: string; rows: UnifiedRow[] }
    | { kind: 'hunk'; oldRaw: string; newRaw: string; rows: UnifiedRow[] }
  > = [];

  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    const lines = splitLinesSafe(part.value);
    if (!part.added && !part.removed) {
      const rows: UnifiedRow[] = lines.map((text) => ({
        type: 'ctx',
        oldNum: oldLine++,
        newNum: newLine++,
        text,
      }));
      rawSegments.push({ kind: 'context', raw: part.value, rows });
    } else {
      const rows: UnifiedRow[] = lines.map((text) =>
        part.added
          ? { type: 'add', oldNum: null, newNum: newLine++, text }
          : { type: 'del', oldNum: oldLine++, newNum: null, text }
      );
      const prev = rawSegments[rawSegments.length - 1];
      if (prev && prev.kind === 'hunk') {
        if (part.removed) prev.oldRaw += part.value;
        if (part.added) prev.newRaw += part.value;
        prev.rows.push(...rows);
      } else {
        rawSegments.push({
          kind: 'hunk',
          oldRaw: part.removed ? part.value : '',
          newRaw: part.added ? part.value : '',
          rows,
        });
      }
    }
  }

  // Merge very close change blocks separated by <= 2 unchanged lines for cleaner review
  const merged: typeof rawSegments = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const prev = merged[merged.length - 1];
    const next = rawSegments[i + 1];
    if (
      seg.kind === 'context' &&
      seg.rows.length <= 2 &&
      prev &&
      prev.kind === 'hunk' &&
      next &&
      next.kind === 'hunk'
    ) {
      prev.oldRaw += seg.raw + next.oldRaw;
      prev.newRaw += seg.raw + next.newRaw;
      prev.rows.push(...seg.rows, ...next.rows);
      i++;
      continue;
    }
    merged.push(seg);
  }

  let nextHunkId = 0;
  let nextCtxId = 0;

  return merged.map((seg): DiffSegment => {
    if (seg.kind === 'context') {
      return { kind: 'context', id: nextCtxId++, raw: seg.raw, rows: seg.rows };
    }
    const firstOld = seg.rows.find((r) => r.oldNum !== null)?.oldNum ?? 1;
    const firstNew = seg.rows.find((r) => r.newNum !== null)?.newNum ?? 1;
    let additions = 0;
    let deletions = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const r of seg.rows) {
      if (r.type === 'add') {
        additions++;
        newCount++;
      } else if (r.type === 'del') {
        deletions++;
        oldCount++;
      } else {
        oldCount++;
        newCount++;
      }
    }
    return {
      kind: 'hunk',
      id: nextHunkId++,
      oldRaw: seg.oldRaw,
      newRaw: seg.newRaw,
      oldStart: firstOld,
      oldCount,
      newStart: firstNew,
      newCount,
      additions,
      deletions,
      unifiedRows: seg.rows,
      splitRows: buildSplitRows(seg.rows),
    };
  });
}

function buildMergedContent(segments: DiffSegment[], includedHunks: Set<number>): string {
  return segments
    .map((seg) => {
      if (seg.kind === 'context') return seg.raw;
      return includedHunks.has(seg.id) ? seg.newRaw : seg.oldRaw;
    })
    .join('');
}

function buildSplitRows(unified: UnifiedRow[]): SplitRow[] {
  const result: SplitRow[] = [];
  let i = 0;
  while (i < unified.length) {
    const row = unified[i];
    if (row.type === 'ctx') {
      result.push({
        leftType: 'ctx',
        rightType: 'ctx',
        oldNum: row.oldNum,
        newNum: row.newNum,
        leftText: row.text,
        rightText: row.text,
        isModifiedPair: false,
      });
      i++;
    } else if (row.type === 'del') {
      const delRows: UnifiedRow[] = [];
      while (i < unified.length && unified[i].type === 'del') {
        delRows.push(unified[i]);
        i++;
      }
      const addRows: UnifiedRow[] = [];
      while (i < unified.length && unified[i].type === 'add') {
        addRows.push(unified[i]);
        i++;
      }
      const maxLen = Math.max(delRows.length, addRows.length);
      for (let k = 0; k < maxLen; k++) {
        const d = delRows[k];
        const a = addRows[k];
        result.push({
          leftType: d ? 'del' : 'empty',
          rightType: a ? 'add' : 'empty',
          oldNum: d ? d.oldNum : null,
          newNum: a ? a.newNum : null,
          leftText: d ? d.text : '',
          rightText: a ? a.text : '',
          isModifiedPair: Boolean(d && a),
        });
      }
    } else {
      result.push({
        leftType: 'empty',
        rightType: 'add',
        oldNum: null,
        newNum: row.newNum,
        leftText: '',
        rightText: row.text,
        isModifiedPair: false,
      });
      i++;
    }
  }
  return result;
}

function InlineWordHighlight({
  oldText,
  newText,
  side,
}: {
  oldText: string;
  newText: string;
  side: 'left' | 'right';
}) {
  const tooLong =
    oldText.length > MAX_WORD_DIFF_LINE_LEN || newText.length > MAX_WORD_DIFF_LINE_LEN;
  const parts = useMemo(() => {
    if (tooLong) return null;
    return diffWordsWithSpace(oldText, newText);
  }, [oldText, newText, tooLong]);

  if (!parts) {
    return <>{side === 'left' ? oldText : newText}</>;
  }

  return (
    <>
      {parts.map((part, idx) => {
        if (!part.added && !part.removed) {
          return <span key={idx}>{part.value}</span>;
        }
        if (side === 'left' && part.removed) {
          return (
            <span
              key={idx}
              className="bg-red-500/35 dark:bg-red-500/40 rounded-[2px] px-0.5 font-semibold text-red-950 dark:text-red-100"
            >
              {part.value}
            </span>
          );
        }
        if (side === 'right' && part.added) {
          return (
            <span
              key={idx}
              className="bg-emerald-500/35 dark:bg-emerald-500/40 rounded-[2px] px-0.5 font-semibold text-emerald-950 dark:text-emerald-100"
            >
              {part.value}
            </span>
          );
        }
        return null;
      })}
    </>
  );
}

function DiffViewer({
  file,
  segments,
  isApplied,
  viewMode,
  wrapLines,
  showFullFile,
  skippedHunks,
  isApplying,
  onToggleHunk,
  onApplySingleHunk,
}: {
  file: ParsedFileDiff;
  segments: DiffSegment[];
  isApplied: boolean;
  viewMode: 'split' | 'unified';
  wrapLines: boolean;
  showFullFile: boolean;
  skippedHunks: Set<number>;
  isApplying: boolean;
  onToggleHunk: (hunkId: number) => void;
  onApplySingleHunk: (hunkId: number) => void;
}) {
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(new Set());

  useEffect(() => {
    setExpandedGaps(new Set());
  }, [file.filePath, file.originalContent, showFullFile, viewMode]);

  const expandGap = (id: number) => {
    setExpandedGaps((prev) => new Set(prev).add(id));
  };

  const totalHunks = segments.filter((s) => s.kind === 'hunk').length;
  const canApplyIndividualHunk = !isApplied && file.action === 'modify' && totalHunks > 0;

  if (file.status === 'failed' || file.status === 'blocked') {
    return (
      <div className="p-8 text-center space-y-2">
        <div className="inline-flex p-3 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h3 className="font-semibold text-sm">Cannot apply this file</h3>
        <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">
          {file.errorReason ?? 'An error occurred while validating this diff.'}
        </p>
      </div>
    );
  }

  const codeWrapClass = wrapLines
    ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
    : 'whitespace-pre';

  const renderUnifiedRow = (r: UnifiedRow, key: string | number, dimmed = false) => (
    <div
      key={key}
      className={`flex leading-5 ${dimmed ? 'opacity-45' : ''} ${
        r.type === 'add'
          ? 'bg-emerald-500/15 text-emerald-950 dark:text-emerald-200'
          : r.type === 'del'
            ? 'bg-red-500/15 text-red-950 dark:text-red-200'
            : 'text-[var(--text-secondary)]'
      }`}
    >
      <span className="w-11 text-right pr-2 py-0.5 text-[11px] text-[var(--text-muted)] bg-[var(--bg-subtle)]/40 border-r border-[var(--border-default)]/50 select-none shrink-0">
        {r.oldNum ?? ''}
      </span>
      <span className="w-11 text-right pr-2 py-0.5 text-[11px] text-[var(--text-muted)] bg-[var(--bg-subtle)]/40 border-r border-[var(--border-default)]/50 select-none shrink-0">
        {r.newNum ?? ''}
      </span>
      <span className="w-5 text-center py-0.5 select-none shrink-0 font-bold">
        {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
      </span>
      <span className={`flex-1 min-w-0 pr-3 py-0.5 ${codeWrapClass}`}>{r.text}</span>
    </div>
  );

  const renderSplitRow = (r: SplitRow, key: string | number, dimmed = false) => (
    <div
      key={key}
      className={`grid grid-cols-2 divide-x divide-[var(--border-default)] leading-5 ${
        dimmed ? 'opacity-45' : ''
      }`}
    >
      <div
        className={`flex min-w-0 ${
          r.leftType === 'del'
            ? 'bg-red-500/15 text-red-950 dark:text-red-200'
            : r.leftType === 'empty'
              ? 'bg-[var(--bg-subtle)]/50'
              : 'text-[var(--text-secondary)]'
        }`}
      >
        <span className="w-11 text-right pr-2 py-0.5 text-[11px] text-[var(--text-muted)] bg-[var(--bg-subtle)]/40 border-r border-[var(--border-default)]/50 select-none shrink-0">
          {r.oldNum ?? ''}
        </span>
        <span className="w-5 text-center py-0.5 select-none shrink-0 font-bold">
          {r.leftType === 'del' ? '-' : ' '}
        </span>
        <span className={`flex-1 min-w-0 pr-3 py-0.5 ${codeWrapClass}`}>
          {r.isModifiedPair ? (
            <InlineWordHighlight oldText={r.leftText} newText={r.rightText} side="left" />
          ) : (
            r.leftText
          )}
        </span>
      </div>
      <div
        className={`flex min-w-0 ${
          r.rightType === 'add'
            ? 'bg-emerald-500/15 text-emerald-950 dark:text-emerald-200'
            : r.rightType === 'empty'
              ? 'bg-[var(--bg-subtle)]/50'
              : 'text-[var(--text-secondary)]'
        }`}
      >
        <span className="w-11 text-right pr-2 py-0.5 text-[11px] text-[var(--text-muted)] bg-[var(--bg-subtle)]/40 border-r border-[var(--border-default)]/50 select-none shrink-0">
          {r.newNum ?? ''}
        </span>
        <span className="w-5 text-center py-0.5 select-none shrink-0 font-bold">
          {r.rightType === 'add' ? '+' : ' '}
        </span>
        <span className={`flex-1 min-w-0 pr-3 py-0.5 ${codeWrapClass}`}>
          {r.isModifiedPair ? (
            <InlineWordHighlight oldText={r.leftText} newText={r.rightText} side="right" />
          ) : (
            r.rightText
          )}
        </span>
      </div>
    </div>
  );

  const renderContextSegment = (seg: ContextSegment, segIdx: number) => {
    const isFirst = segIdx === 0;
    const isLast = segIdx === segments.length - 1;
    const showAll = showFullFile || totalHunks === 0 || expandedGaps.has(seg.id);

    const renderRows = (rows: UnifiedRow[], prefix: string) =>
      rows.map((r, idx) =>
        viewMode === 'unified'
          ? renderUnifiedRow(r, `${prefix}-${idx}`)
          : renderSplitRow(
              {
                leftType: 'ctx',
                rightType: 'ctx',
                oldNum: r.oldNum,
                newNum: r.newNum,
                leftText: r.text,
                rightText: r.text,
                isModifiedPair: false,
              },
              `${prefix}-${idx}`
            )
      );

    if (showAll) {
      return <div key={`ctx-${seg.id}`}>{renderRows(seg.rows, `ctx-${seg.id}`)}</div>;
    }

    const topRows = isFirst ? [] : seg.rows.slice(0, CONTEXT_RADIUS);
    const bottomRows = isLast ? [] : seg.rows.slice(Math.max(topRows.length, seg.rows.length - CONTEXT_RADIUS));
    const hiddenCount = seg.rows.length - topRows.length - bottomRows.length;

    if (hiddenCount <= 2) {
      return <div key={`ctx-${seg.id}`}>{renderRows(seg.rows, `ctx-${seg.id}`)}</div>;
    }

    return (
      <div key={`ctx-${seg.id}`}>
        {topRows.length > 0 && renderRows(topRows, `ctx-top-${seg.id}`)}
        <button
          type="button"
          onClick={() => expandGap(seg.id)}
          className="w-full py-1 px-4 text-left text-[11px] font-sans text-blue-600 dark:text-blue-400 bg-blue-500/5 hover:bg-blue-500/10 border-y border-[var(--border-default)]/60 cursor-pointer"
        >
          ⋯ Show {hiddenCount} unchanged {hiddenCount === 1 ? 'line' : 'lines'}
        </button>
        {bottomRows.length > 0 && renderRows(bottomRows, `ctx-bot-${seg.id}`)}
      </div>
    );
  };

  const renderHunkSegment = (hunk: HunkSegment) => {
    const isSkipped = skippedHunks.has(hunk.id);
    return (
      <div key={`hunk-${hunk.id}`} className="border-y border-[var(--border-default)]/80">
        <div className="px-3 py-1 bg-blue-500/8 dark:bg-blue-500/10 border-b border-[var(--border-default)]/60 flex flex-wrap items-center justify-between gap-2 font-sans">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-semibold text-blue-700 dark:text-blue-300">
              Change {hunk.id + 1} of {totalHunks}
            </span>
            <span className="font-mono text-[var(--text-muted)]">
              @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
            </span>
            <span className="font-mono">
              <span className="text-emerald-600 dark:text-emerald-400">+{hunk.additions}</span>{' '}
              <span className="text-red-600 dark:text-red-400">-{hunk.deletions}</span>
            </span>
          </div>

          {canApplyIndividualHunk && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onToggleHunk(hunk.id)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer ${
                  isSkipped
                    ? 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
                }`}
                title="Include or skip this change block when applying the file"
              >
                {isSkipped ? 'Skipped' : 'Included'}
              </button>
              <button
                type="button"
                disabled={isApplying}
                onClick={() => onApplySingleHunk(hunk.id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white transition cursor-pointer"
                title="Apply only this change block to disk right now"
              >
                <Check className="h-3 w-3" />
                <span>Apply Change</span>
              </button>
            </div>
          )}
        </div>

        {viewMode === 'unified'
          ? hunk.unifiedRows.map((r, idx) => renderUnifiedRow(r, `hu-${hunk.id}-${idx}`, isSkipped))
          : hunk.splitRows.map((r, idx) => renderSplitRow(r, `hs-${hunk.id}-${idx}`, isSkipped))}
      </div>
    );
  };

  if (totalHunks === 0 && isApplied) {
    return (
      <div className="p-10 text-center space-y-2">
        <div className="inline-flex p-3 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h3 className="font-semibold text-sm">All changes applied to this file</h3>
        <p className="text-xs text-[var(--text-muted)]">
          You can continue reviewing the remaining files on the left or undo from the header.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`font-mono text-xs ${
        wrapLines ? 'w-full' : viewMode === 'split' ? 'min-w-[960px] w-max' : 'min-w-full w-max'
      }`}
    >
      {segments.map((seg, idx) =>
        seg.kind === 'context' ? renderContextSegment(seg, idx) : renderHunkSegment(seg)
      )}
    </div>
  );
}

export function Step3ReviewApply() {
  const {
    rawPasteInput,
    activeParse,
    checkedApplyPaths,
    appliedFilePaths,
    appliedFileSnapshots,
    selectedPreviewFile,
    clipboardWatchEnabled,
    isParsing,
    isApplying,
    setRawPasteInput,
    parseManualPaste,
    toggleApplyFile,
    setAllReadyApply,
    setSelectedPreviewFile,
    clearActiveParse,
    applyCheckedFiles,
    applySingleFile,
    applyPartialFileContent,
    undoSnapshotById,
    pushToast,
  } = useWorkbenchStore();

  const [viewMode, setViewMode] = useState<'split' | 'unified'>(() => {
    if (typeof window === 'undefined') return 'split';
    return localStorage.getItem(VIEW_MODE_KEY) === 'unified' ? 'unified' : 'split';
  });
  const [wrapLines, setWrapLines] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem(WRAP_LINES_KEY);
    return saved === null ? true : saved === 'true';
  });
  const [showFullFile, setShowFullFile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(FULL_FILE_KEY) === 'true';
  });
  const [skippedHunksByFile, setSkippedHunksByFile] = useState<Record<string, number[]>>({});

  useEffect(() => {
    setSkippedHunksByFile({});
  }, [activeParse?.parseId]);

  const updateViewMode = (mode: 'split' | 'unified') => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  };

  const toggleWrapLines = () => {
    setWrapLines((v) => {
      const next = !v;
      localStorage.setItem(WRAP_LINES_KEY, String(next));
      return next;
    });
  };

  const toggleShowFullFile = () => {
    setShowFullFile((v) => {
      const next = !v;
      localStorage.setItem(FULL_FILE_KEY, String(next));
      return next;
    });
  };

  const activeFile =
    activeParse?.files.find((f) => f.filePath === selectedPreviewFile) ??
    activeParse?.files[0] ??
    null;

  const activeFileIndex = activeParse && activeFile
    ? activeParse.files.findIndex((f) => f.filePath === activeFile.filePath)
    : -1;

  const activeSegments = useMemo(() => {
    if (!activeFile || activeFile.status !== 'ready') return [];
    return buildDiffSegments(activeFile.originalContent, activeFile.proposedContent);
  }, [activeFile]);

  const activeSkippedSet = useMemo(
    () => new Set(activeFile ? skippedHunksByFile[activeFile.filePath] ?? [] : []),
    [activeFile, skippedHunksByFile]
  );

  const activeHunkIds = useMemo(
    () => activeSegments.filter((s): s is HunkSegment => s.kind === 'hunk').map((h) => h.id),
    [activeSegments]
  );

  const toggleHunkIncluded = (filePath: string, hunkId: number) => {
    setSkippedHunksByFile((prev) => {
      const current = new Set(prev[filePath] ?? []);
      if (current.has(hunkId)) current.delete(hunkId);
      else current.add(hunkId);
      return { ...prev, [filePath]: Array.from(current) };
    });
  };

  const handleApplySingleHunk = async (hunkId: number) => {
    if (!activeFile) return;
    const merged = buildMergedContent(activeSegments, new Set([hunkId]));
    await applyPartialFileContent(activeFile.filePath, merged);
    setSkippedHunksByFile((prev) => ({ ...prev, [activeFile.filePath]: [] }));
  };

  const handleApplyActiveFile = async () => {
    if (!activeFile) return;
    if (activeFile.action !== 'modify' || activeHunkIds.length === 0) {
      await applySingleFile(activeFile.filePath);
      return;
    }
    const included = new Set(activeHunkIds.filter((id) => !activeSkippedSet.has(id)));
    if (included.size === 0) {
      pushToast('error', 'Include at least one change block before applying.');
      return;
    }
    if (included.size === activeHunkIds.length) {
      await applySingleFile(activeFile.filePath);
    } else {
      const merged = buildMergedContent(activeSegments, included);
      await applyPartialFileContent(activeFile.filePath, merged);
      setSkippedHunksByFile((prev) => ({ ...prev, [activeFile.filePath]: [] }));
    }
  };

  const handleApplyCheckedBatch = async () => {
    if (!activeParse) return;
    const customContents: Record<string, string> = {};
    for (const filePath of checkedApplyPaths) {
      const skipped = skippedHunksByFile[filePath];
      if (!skipped || skipped.length === 0) continue;
      const file = activeParse.files.find((f) => f.filePath === filePath);
      if (!file || file.action !== 'modify') continue;
      const segs = buildDiffSegments(file.originalContent, file.proposedContent);
      const skippedSet = new Set(skipped);
      const included = new Set(
        segs
          .filter((s): s is HunkSegment => s.kind === 'hunk')
          .map((h) => h.id)
          .filter((id) => !skippedSet.has(id))
      );
      if (included.size > 0) {
        customContents[filePath] = buildMergedContent(segs, included);
      }
    }
    await applyCheckedFiles(Object.keys(customContents).length > 0 ? customContents : undefined);
  };

  const copyRetryPrompt = async () => {
    if (!activeParse?.retryPrompt) return;
    await navigator.clipboard.writeText(activeParse.retryPrompt);
    pushToast('success', 'Copied fix prompt for failed file(s). Paste it into your AI chat!');
  };

  if (!activeParse) {
    return (
      <div className="p-6 max-w-3xl mx-auto w-full flex-1 flex flex-col justify-center items-center">
        <div className="w-full rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 space-y-4 shadow-sm text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <ClipboardPaste className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Waiting for AI Changes</h2>
            <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md mx-auto">
              {clipboardWatchEnabled
                ? 'Copy the reply from ChatGPT, Gemini, or Claude — Chat2Diff will open the preview automatically. Or paste it below.'
                : 'Paste the reply from your AI chat to inspect changes before writing to disk.'}
            </p>
          </div>

          <textarea
            rows={8}
            value={rawPasteInput}
            onChange={(e) => setRawPasteInput(e.target.value)}
            placeholder="Paste code blocks here (SEARCH/REPLACE blocks or Unified Git Diff)..."
            className="w-full p-3 font-mono text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <button
            type="button"
            disabled={isParsing || !rawPasteInput.trim()}
            onClick={() => void parseManualPaste()}
            className="w-full py-2.5 px-4 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition cursor-pointer flex items-center justify-center gap-2"
          >
            <FileDiff className="h-4 w-4" />
            <span>{isParsing ? 'Checking changes...' : 'Preview Changes'}</span>
          </button>
        </div>
      </div>
    );
  }

  const pendingReadyFiles = activeParse.files.filter(
    (f) => f.status === 'ready' && !appliedFilePaths.has(f.filePath)
  );
  const appliedCount = activeParse.files.filter((f) => appliedFilePaths.has(f.filePath)).length;
  const allReadyChecked =
    pendingReadyFiles.length > 0 &&
    pendingReadyFiles.every((f) => checkedApplyPaths.has(f.filePath));
  const activeIsApplied = Boolean(activeFile && appliedFilePaths.has(activeFile.filePath));
  const activeIncludedCount = activeHunkIds.filter((id) => !activeSkippedSet.has(id)).length;
  const activeSnapshotId = activeFile ? appliedFileSnapshots[activeFile.filePath] : undefined;

  return (
    <div className="p-6 max-w-7xl mx-auto w-full flex-1 flex flex-col gap-4">
      {/* Top Action Bar */}
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-sm">Review Changes</span>
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium">
            {pendingReadyFiles.length} pending
          </span>
          {appliedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-700 dark:text-blue-300 font-medium">
              {appliedCount} applied
            </span>
          )}
          {activeParse.summary.failedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium">
              {activeParse.summary.failedCount} needs retry
            </span>
          )}
          {activeParse.summary.blockedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 font-medium">
              {activeParse.summary.blockedCount} blocked
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={clearActiveParse}
            className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            Paste Another Reply
          </button>

          {activeParse.retryPrompt && (
            <button
              type="button"
              onClick={() => void copyRetryPrompt()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>Copy Fix Prompt ({activeParse.summary.failedCount})</span>
            </button>
          )}

          <button
            type="button"
            disabled={isApplying || checkedApplyPaths.size === 0}
            onClick={() => void handleApplyCheckedBatch()}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white transition cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" />
            <span>
              {isApplying
                ? 'Applying...'
                : `Apply Selected (${checkedApplyPaths.size}/${pendingReadyFiles.length})`}
            </span>
          </button>
        </div>
      </div>

      {/* Main Split Review Body */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1">
        {/* Left: File List */}
        <div className="lg:col-span-4 xl:col-span-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-subtle)] flex items-center justify-between text-xs">
            <label className="flex items-center gap-2 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={allReadyChecked}
                onChange={(e) => setAllReadyApply(e.target.checked)}
                disabled={pendingReadyFiles.length === 0}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              <span>Select all pending</span>
            </label>
            <span className="text-[var(--text-muted)]">{activeParse.files.length} files</span>
          </div>

          <div className="overflow-y-auto flex-1 divide-y divide-[var(--border-default)]">
            {activeParse.files.map((f) => {
              const isSelected = activeFile?.filePath === f.filePath;
              const isChecked = checkedApplyPaths.has(f.filePath);
              const isApplied = appliedFilePaths.has(f.filePath);
              return (
                <div
                  key={f.filePath}
                  onClick={() => setSelectedPreviewFile(f.filePath)}
                  className={`px-3 py-2.5 flex items-start gap-2.5 cursor-pointer transition ${
                    isSelected ? 'bg-blue-500/10' : 'hover:bg-[var(--bg-subtle)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={f.status !== 'ready' || isApplied}
                    checked={isChecked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleApplyFile(f.filePath)}
                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-mono truncate font-medium">{f.filePath}</div>
                    <div className="flex items-center gap-2 mt-1 text-[11px]">
                      <span
                        className={`px-1.5 py-0.2 rounded capitalize inline-flex items-center gap-1 ${
                          isApplied
                            ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 font-medium'
                            : f.status === 'ready'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'bg-red-500/15 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {isApplied ? (
                          <>
                            <Check className="h-3 w-3" />
                            applied
                          </>
                        ) : f.status === 'ready' ? (
                          f.action
                        ) : (
                          f.status
                        )}
                      </span>
                      {f.status === 'ready' && !isApplied && (
                        <span className="font-mono text-[var(--text-muted)]">
                          <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>{' '}
                          <span className="text-red-600 dark:text-red-400">-{f.deletions}</span>
                        </span>
                      )}
                      {f.securityWarning && (
                        <span title={f.securityWarning} className="inline-flex shrink-0">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Code Diff Viewer */}
        <div className="lg:col-span-8 xl:col-span-9 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col overflow-hidden min-h-[420px]">
          {activeFile && (
            <>
              <div className="px-3.5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {activeParse.files.length > 1 && (
                    <div className="inline-flex items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden shrink-0">
                      <button
                        type="button"
                        disabled={activeFileIndex <= 0}
                        onClick={() =>
                          activeFileIndex > 0 &&
                          setSelectedPreviewFile(activeParse.files[activeFileIndex - 1].filePath)
                        }
                        className="p-1 hover:bg-[var(--bg-subtle)] disabled:opacity-35 cursor-pointer"
                        title="Previous file"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <span className="px-1.5 text-[11px] font-mono text-[var(--text-muted)]">
                        {activeFileIndex + 1}/{activeParse.files.length}
                      </span>
                      <button
                        type="button"
                        disabled={activeFileIndex >= activeParse.files.length - 1}
                        onClick={() =>
                          activeFileIndex < activeParse.files.length - 1 &&
                          setSelectedPreviewFile(activeParse.files[activeFileIndex + 1].filePath)
                        }
                        className="p-1 hover:bg-[var(--bg-subtle)] disabled:opacity-35 cursor-pointer"
                        title="Next file"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <span className="text-xs font-mono font-medium truncate">
                    {activeFile.filePath}
                  </span>
                  {activeFile.repairNote && (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-700 dark:text-blue-300">
                      <Sparkles className="h-3 w-3" />
                      {activeFile.repairNote}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {activeFile.status === 'ready' && !activeIsApplied && (
                    <button
                      type="button"
                      disabled={isApplying || (activeHunkIds.length > 0 && activeIncludedCount === 0)}
                      onClick={() => void handleApplyActiveFile()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white transition cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>
                        {activeHunkIds.length > 0 && activeIncludedCount < activeHunkIds.length
                          ? `Apply ${activeIncludedCount}/${activeHunkIds.length} Changes`
                          : 'Apply This File'}
                      </span>
                    </button>
                  )}

                  {activeIsApplied && (
                    <div className="inline-flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-blue-500/15 text-blue-700 dark:text-blue-300">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Applied
                      </span>
                      {activeSnapshotId && (
                        <button
                          type="button"
                          onClick={() => void undoSnapshotById(activeSnapshotId)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Undo</span>
                        </button>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={toggleWrapLines}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs border cursor-pointer ${
                      wrapLines
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
                    }`}
                    title="Wrap long lines so code never overflows horizontally"
                  >
                    <WrapText className="h-3.5 w-3.5" />
                    <span>Wrap</span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleShowFullFile}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-canvas)] text-[var(--text-secondary)] cursor-pointer"
                    title="Toggle between focused changes only and full file"
                  >
                    {showFullFile ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    <span>{showFullFile ? 'Changes Only' : 'Full File'}</span>
                  </button>

                  <div className="flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-0.5">
                    <button
                      type="button"
                      onClick={() => updateViewMode('split')}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${
                        viewMode === 'split'
                          ? 'bg-blue-600 text-white'
                          : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      <Columns2 className="h-3.5 w-3.5" />
                      <span>Side-by-Side</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => updateViewMode('unified')}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${
                        viewMode === 'unified'
                          ? 'bg-blue-600 text-white'
                          : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      <Rows2 className="h-3.5 w-3.5" />
                      <span>Unified</span>
                    </button>
                  </div>
                </div>
              </div>

              {activeFile.securityWarning && (
                <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{activeFile.securityWarning}</span>
                </div>
              )}

              <div className="flex-1 overflow-auto">
                <DiffViewer
                  file={activeFile}
                  segments={activeSegments}
                  isApplied={activeIsApplied}
                  viewMode={viewMode}
                  wrapLines={wrapLines}
                  showFullFile={showFullFile}
                  skippedHunks={activeSkippedSet}
                  isApplying={isApplying}
                  onToggleHunk={(hunkId) => toggleHunkIncluded(activeFile.filePath, hunkId)}
                  onApplySingleHunk={(hunkId) => void handleApplySingleHunk(hunkId)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
