import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ClipboardPaste,
  Columns2,
  Copy,
  FileDiff,
  Rows2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { ParsedFileDiff } from '../../shared/types.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

function DiffViewer({
  file,
  viewMode,
}: {
  file: ParsedFileDiff;
  viewMode: 'split' | 'unified';
}) {
  const hunks = useMemo(
    () => diffLines(file.originalContent, file.proposedContent),
    [file.originalContent, file.proposedContent]
  );

  const rows = useMemo(() => {
    const unified: Array<{
      type: 'ctx' | 'add' | 'del';
      oldNum: number | null;
      newNum: number | null;
      text: string;
    }> = [];
    let oldLine = 1;
    let newLine = 1;

    for (const part of hunks) {
      const lines = part.value.replace(/\n$/, '').split('\n');
      for (const text of lines) {
        if (part.added) {
          unified.push({ type: 'add', oldNum: null, newNum: newLine++, text });
        } else if (part.removed) {
          unified.push({ type: 'del', oldNum: oldLine++, newNum: null, text });
        } else {
          unified.push({ type: 'ctx', oldNum: oldLine++, newNum: newLine++, text });
        }
      }
    }
    return unified;
  }, [hunks]);

  if (file.status === 'failed' || file.status === 'blocked') {
    return (
      <div className="p-8 text-center space-y-2">
        <div className="inline-flex p-3 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 mb-2">
          {file.status === 'blocked' ? <ShieldAlert className="h-6 w-6" /> : <AlertCircle className="h-6 w-6" />}
        </div>
        <h3 className="font-semibold text-sm">
          {file.status === 'blocked' ? 'Blocked for Safety' : 'Could Not Match File'}
        </h3>
        <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">{file.errorReason}</p>
      </div>
    );
  }

  if (viewMode === 'unified') {
    return (
      <div className="font-mono text-xs divide-y divide-[var(--border-default)]">
        {rows.map((r, idx) => (
          <div
            key={idx}
            className={`flex px-2 whitespace-pre ${
              r.type === 'add'
                ? 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-200'
                : r.type === 'del'
                  ? 'bg-red-500/15 text-red-900 dark:text-red-200'
                  : 'text-[var(--text-secondary)]'
            }`}
          >
            <span className="w-10 text-right pr-2 text-[var(--text-muted)] select-none shrink-0">
              {r.oldNum ?? ''}
            </span>
            <span className="w-10 text-right pr-2 text-[var(--text-muted)] select-none shrink-0">
              {r.newNum ?? ''}
            </span>
            <span className="w-4 text-center select-none shrink-0 font-bold">
              {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
            </span>
            <span className="flex-1 overflow-x-auto">{r.text}</span>
          </div>
        ))}
      </div>
    );
  }

  // Side-by-Side view
  return (
    <div className="font-mono text-xs divide-y divide-[var(--border-default)]">
      {rows.map((r, idx) => (
        <div key={idx} className="grid grid-cols-2 divide-x divide-[var(--border-default)]">
          <div
            className={`flex px-2 whitespace-pre overflow-x-hidden ${
              r.type === 'del'
                ? 'bg-red-500/15 text-red-900 dark:text-red-200'
                : r.type === 'add'
                  ? 'bg-[var(--bg-subtle)]/50'
                  : 'text-[var(--text-secondary)]'
            }`}
          >
            <span className="w-10 text-right pr-2 text-[var(--text-muted)] select-none shrink-0">
              {r.type !== 'add' ? r.oldNum : ''}
            </span>
            <span className="flex-1 truncate">{r.type !== 'add' ? r.text : ''}</span>
          </div>
          <div
            className={`flex px-2 whitespace-pre overflow-x-hidden ${
              r.type === 'add'
                ? 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-200'
                : r.type === 'del'
                  ? 'bg-[var(--bg-subtle)]/50'
                  : 'text-[var(--text-secondary)]'
            }`}
          >
            <span className="w-10 text-right pr-2 text-[var(--text-muted)] select-none shrink-0">
              {r.type !== 'del' ? r.newNum : ''}
            </span>
            <span className="flex-1 truncate">{r.type !== 'del' ? r.text : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Step3ReviewApply() {
  const {
    rawPasteInput,
    activeParse,
    checkedApplyPaths,
    selectedPreviewFile,
    clipboardWatchEnabled,
    isParsing,
    isApplying,
    setRawPasteInput,
    parseManualPaste,
    toggleApplyFile,
    setAllReadyApply,
    setSelectedPreviewFile,
    applyCheckedFiles,
    pushToast,
  } = useWorkbenchStore();

  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');

  const activeFile =
    activeParse?.files.find((f) => f.filePath === selectedPreviewFile) ??
    activeParse?.files[0] ??
    null;

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
                : 'Paste the full response from your AI chatbot below to preview changes safely.'}
            </p>
          </div>

          <textarea
            rows={10}
            value={rawPasteInput}
            onChange={(e) => setRawPasteInput(e.target.value)}
            placeholder="Paste the AI chatbot's response here (supports SEARCH/REPLACE blocks and unified git diffs)..."
            className="w-full p-3 text-xs font-mono rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <button
            type="button"
            disabled={isParsing || !rawPasteInput.trim()}
            onClick={() => void parseManualPaste()}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <FileDiff className="h-4 w-4" />
            <span>{isParsing ? 'Checking changes...' : 'Preview Changes'}</span>
          </button>
        </div>
      </div>
    );
  }

  const readyFiles = activeParse.files.filter((f) => f.status === 'ready');
  const allReadyChecked =
    readyFiles.length > 0 && readyFiles.every((f) => checkedApplyPaths.has(f.filePath));

  return (
    <div className="p-6 max-w-7xl mx-auto w-full flex-1 flex flex-col gap-4">
      {/* Top Action Bar */}
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-sm">Review Changes</span>
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium">
            {activeParse.summary.readyCount} ready
          </span>
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
            onClick={() => useWorkbenchStore.setState({ activeParse: null })}
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
            onClick={() => void applyCheckedFiles()}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white transition cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" />
            <span>
              {isApplying
                ? 'Applying...'
                : `Apply Selected (${checkedApplyPaths.size}/${readyFiles.length})`}
            </span>
          </button>
        </div>
      </div>

      {/* Main Split: File List + Diff Viewer */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4 xl:col-span-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[var(--border-default)] flex items-center justify-between text-xs">
            <label className="flex items-center gap-2 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={allReadyChecked}
                onChange={(e) => setAllReadyApply(e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              <span>Select all ready</span>
            </label>
            <span className="text-[var(--text-muted)]">{activeParse.files.length} files</span>
          </div>

          <div className="overflow-y-auto flex-1 divide-y divide-[var(--border-default)]">
            {activeParse.files.map((f) => {
              const isSelected = activeFile?.filePath === f.filePath;
              const isChecked = checkedApplyPaths.has(f.filePath);
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
                    disabled={f.status !== 'ready'}
                    checked={isChecked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleApplyFile(f.filePath)}
                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-mono truncate font-medium">{f.filePath}</div>
                    <div className="flex items-center gap-2 mt-1 text-[11px]">
                      <span
                        className={`px-1.5 py-0.2 rounded capitalize ${
                          f.status === 'ready'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-red-500/15 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {f.status === 'ready' ? f.action : f.status}
                      </span>
                      {f.status === 'ready' && (
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

        <div className="lg:col-span-8 xl:col-span-9 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col overflow-hidden min-h-[420px]">
          {activeFile && (
            <>
              <div className="px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
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

                <div className="flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('split')}
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
                    onClick={() => setViewMode('unified')}
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

              {activeFile.securityWarning && (
                <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{activeFile.securityWarning}</span>
                </div>
              )}

              <div className="flex-1 overflow-auto">
                <DiffViewer file={activeFile} viewMode={viewMode} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
