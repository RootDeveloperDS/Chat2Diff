import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  FolderOpen,
  MessageSquarePlus,
  PanelLeftOpen,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { TASK_PRESETS } from '../../shared/constants.js';
import type { FileTreeNode, TaskPreset } from '../../shared/types.js';
import { downloadTextFile } from '../lib/api.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

export function Step2DescribeTask() {
  const {
    fileTree,
    selectedPaths,
    filePanelCollapsed,
    chatMode,
    followUpAttachMode,
    turnSync,
    preset,
    taskDescription,
    errorLog,
    patchFormatPreference,
    fileBundleStyle,
    redactSecrets,
    lastPackResult,
    isPacking,
    setFilePanelCollapsed,
    setChatMode,
    setFollowUpAttachMode,
    startNewChat,
    clearTurnSync,
    setPreset,
    setTaskDescription,
    setErrorLog,
    setPatchFormat,
    setFileBundleStyle,
    setRedactSecrets,
    packContext,
    setStep,
    pushToast,
  } = useWorkbenchStore();

  const [copiedMode, setCopiedMode] = useState<
    'inline' | 'file' | 'separate_prompt' | 'path' | 'download' | null
  >(null);
  const [separateStep1Done, setSeparateStep1Done] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    setSeparateStep1Done(false);
  }, [taskDescription, errorLog, preset, chatMode, followUpAttachMode, patchFormatPreference, selectedPaths]);

  const selectedTokens = useMemo(() => {
    let total = 0;
    const visit = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') {
          if (selectedPaths.has(n.path)) total += n.estimatedTokens;
        } else if (n.children) {
          visit(n.children);
        }
      }
    };
    visit(fileTree);
    return total;
  }, [fileTree, selectedPaths]);

  const isFollowUp = chatMode === 'follow_up';
  const isSeparateMode = fileBundleStyle === 'separate_prompt';
  const fileModeDisabled = isFollowUp && followUpAttachMode === 'none';
  const recommendFileMode =
    !fileModeDisabled &&
    (isFollowUp
      ? followUpAttachMode === 'all' && (selectedTokens > 18_000 || selectedPaths.size > 15)
      : selectedTokens > 18_000 || selectedPaths.size > 15);

  const handleCopyAll = async () => {
    const res = await packContext('inline_copy');
    if (!res) return;
    await navigator.clipboard.writeText(res.promptText);
    setCopiedMode('inline');
    const attachNote = isFollowUp
      ? res.stats.attachedFiles.length > 0
        ? ` (${res.stats.attachedFiles.length} updated/failed file(s) included)`
        : ' (short follow-up, 0 files re-uploaded)'
      : '';
    pushToast('success', `Copied prompt!${attachNote} Paste into your AI chat.`);
    window.setTimeout(() => setCopiedMode(null), 3000);
  };

  const handleCopyAsFile = async () => {
    const res = await packContext('file_attachment', {
      copyFileToClipboard: true,
      fileBundleStyle,
    });
    if (!res) return;
    if (!res.contextFileContent) {
      await navigator.clipboard.writeText(res.promptText);
      setCopiedMode('inline');
      pushToast(
        'success',
        'All files already in sync (0 attached) — copied the short follow-up prompt!'
      );
      window.setTimeout(() => setCopiedMode(null), 3000);
      return;
    }

    if (res.fileCopiedToClipboard) {
      setCopiedMode('file');
      if (isSeparateMode) {
        setSeparateStep1Done(true);
        pushToast(
          'success',
          `1. Copied ${res.contextFileName} (${res.stats.attachedFiles.length} file(s))! Paste (Ctrl+V) in AI chat, then click "2. Copy Prompt Text".`
        );
      } else {
        pushToast(
          'success',
          `Copied ${res.contextFileName} (${res.stats.attachedFiles.length} file(s))! Press Ctrl+V in AI chat and send "go".`
        );
      }
      window.setTimeout(() => setCopiedMode(null), 3500);
    } else {
      if (res.cachedFilePath) {
        await navigator.clipboard.writeText(res.cachedFilePath).catch(() => {});
      }
      pushToast(
        'error',
        res.fileClipboardError ??
          'Could not copy file object to clipboard. Cached path copied — use Copy Path or Save .txt.'
      );
    }
  };

  const handleCopySeparatePrompt = async () => {
    const res =
      separateStep1Done &&
      lastPackResult &&
      lastPackResult.fileBundleStyle === 'separate_prompt'
        ? lastPackResult
        : await packContext('file_attachment', {
            copyFileToClipboard: false,
            fileBundleStyle: 'separate_prompt',
          });
    if (!res) return;
    await navigator.clipboard.writeText(res.promptText);
    setCopiedMode('separate_prompt');
    pushToast('success', '2. Copied readable prompt text! Paste it alongside your attached file.');
    window.setTimeout(() => setCopiedMode(null), 3000);
  };

  const handleCopyCachedPath = async () => {
    const res = await packContext('file_attachment', {
      copyFileToClipboard: false,
      fileBundleStyle,
    });
    if (!res) return;
    if (res.cachedFilePath) {
      await navigator.clipboard.writeText(res.cachedFilePath);
      setCopiedMode('path');
      pushToast('success', `Copied single cache file path: ${res.cachedFilePath}`);
      window.setTimeout(() => setCopiedMode(null), 3000);
    } else {
      await navigator.clipboard.writeText(res.promptText);
      setCopiedMode('inline');
      pushToast('info', 'All files already in sync (0 attached) — copied short prompt instead.');
      window.setTimeout(() => setCopiedMode(null), 3000);
    }
  };

  const handleSaveToDownloads = async () => {
    const res = await packContext('file_attachment', {
      copyFileToClipboard: false,
      fileBundleStyle,
    });
    if (!res) return;
    if (res.contextFileContent) {
      downloadTextFile(res.contextFileName, res.contextFileContent);
      setCopiedMode('download');
      if (isSeparateMode) {
        await navigator.clipboard.writeText(res.promptText);
        setSeparateStep1Done(true);
        pushToast(
          'success',
          `Saved ${res.contextFileName} & copied the prompt text to your clipboard!`
        );
      } else {
        pushToast(
          'success',
          `Saved ${res.contextFileName}! Upload it to your AI chat and send "go".`
        );
      }
    } else {
      await navigator.clipboard.writeText(res.promptText);
      setCopiedMode('inline');
      pushToast(
        'success',
        'All files already in sync (0 attached) — copied the short follow-up prompt!'
      );
    }
    window.setTimeout(() => setCopiedMode(null), 3500);
  };

  const hasSyncInfo = Boolean(
    turnSync &&
      (turnSync.appliedFiles.length > 0 ||
        turnSync.partiallyAppliedFiles.length > 0 ||
        turnSync.notAppliedFiles.length > 0 ||
        turnSync.failedFiles.length > 0 ||
        turnSync.undoneFiles.length > 0)
  );

  const canPack =
    !isPacking &&
    Boolean(taskDescription.trim()) &&
    (isFollowUp || selectedPaths.size > 0);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-4 flex-1">
      {/* Header + Chat Turn Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2 min-w-0">
          {filePanelCollapsed && (
            <button
              type="button"
              onClick={() => setFilePanelCollapsed(false)}
              title="Show project file picker"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] hover:border-blue-500/40 text-xs font-medium cursor-pointer"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
              <span>Files ({selectedPaths.size})</span>
            </button>
          )}
          <div>
            <h2 className="font-semibold text-sm sm:text-base">Describe Your Task & Send</h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              {isFollowUp
                ? 'Follow-up turn: confirms applied/skipped files so the AI stays in sync without re-uploading everything.'
                : `New chat: packages ${selectedPaths.size} selected file(s) (~${selectedTokens.toLocaleString()} tokens).`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-0.5"
            role="group"
            aria-label="Conversation mode"
          >
            <button
              type="button"
              onClick={() => startNewChat()}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                !isFollowUp
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title="Send full selected files to start a fresh AI conversation"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              <span>New Chat</span>
            </button>
            <button
              type="button"
              onClick={() => setChatMode('follow_up')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                isFollowUp
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title="Continue in the same AI chat without re-uploading unchanged files"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Same Chat (Follow-Up)</span>
            </button>
          </div>

          {(taskDescription.trim() || errorLog.trim()) && (
            <button
              type="button"
              onClick={() => {
                setTaskDescription('');
                setErrorLog('');
              }}
              className="p-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-muted)] hover:text-red-500 cursor-pointer"
              title="Clear task and error fields"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Follow-Up Ground Truth Sync Banner */}
      {isFollowUp && (
        <div className="p-3 rounded-xl border border-blue-500/30 bg-blue-500/8 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1 text-xs">
              <div className="font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Grounded Follow-Up Sync</span>
              </div>
              {hasSyncInfo && turnSync ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {turnSync.appliedFiles.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium">
                      ✓ {turnSync.appliedFiles.length} applied
                    </span>
                  )}
                  {turnSync.partiallyAppliedFiles.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-700 dark:text-blue-300 font-medium">
                      ◐ {turnSync.partiallyAppliedFiles.length} partial (source attached)
                    </span>
                  )}
                  {turnSync.notAppliedFiles.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)] font-medium">
                      ⏭ {turnSync.notAppliedFiles.length} skipped
                    </span>
                  )}
                  {turnSync.failedFiles.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium">
                      ⚠ {turnSync.failedFiles.length} failed (source attached)
                    </span>
                  )}
                  {turnSync.undoneFiles.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 font-medium">
                      ↺ {turnSync.undoneFiles.length} undone (source attached)
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-secondary)]">
                  Only newly selected or externally edited files will be attached — unchanged files already in your chat are skipped.
                </p>
              )}
            </div>
            {hasSyncInfo && (
              <button
                type="button"
                onClick={clearTurnSync}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                title="Clear previous turn status"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Files to include:
            </span>
            <div
              className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-0.5"
              role="group"
              aria-label="Follow-up file attachment mode"
            >
              <button
                type="button"
                onClick={() => setFollowUpAttachMode('smart')}
                title="Attach only changed, partial, failed, or undone files"
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${
                  followUpAttachMode === 'smart'
                    ? 'bg-blue-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Auto Delta
              </button>
              <button
                type="button"
                onClick={() => setFollowUpAttachMode('none')}
                title="Attach 0 files — send only the short follow-up prompt"
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${
                  followUpAttachMode === 'none'
                    ? 'bg-blue-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Text Only (0 files)
              </button>
              <button
                type="button"
                onClick={() => setFollowUpAttachMode('all')}
                title="Attach all currently selected files"
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${
                  followUpAttachMode === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                All Selected ({selectedPaths.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Presets */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {(Object.keys(TASK_PRESETS) as TaskPreset[]).map((key) => {
          const item = TASK_PRESETS[key];
          const active = preset === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPreset(key)}
              className={`p-2 rounded-lg border text-left transition cursor-pointer ${
                active
                  ? 'border-blue-600 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                  : 'border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'
              }`}
            >
              <div className="text-xs font-semibold">{item.label}</div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-1">
                {item.shortDesc}
              </div>
            </button>
          );
        })}
      </div>

      {/* Task Description */}
      <div>
        <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">
          {isFollowUp ? 'What should the AI do next?' : 'What do you want the AI to do?'}
        </label>
        <textarea
          rows={5}
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          placeholder={
            isFollowUp
              ? 'Example: That worked! Now add keyboard navigation and fix the error shown below...'
              : 'Example: Fix the login button alignment on mobile screens and add a loading spinner while signing in...'
          }
          className="w-full p-3 text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Optional Error / Output */}
      <div>
        <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1">
          Paste any error, log, or compiler output{' '}
          <span className="font-normal text-[var(--text-muted)]">(optional)</span>
        </label>
        <textarea
          rows={3}
          value={errorLog}
          onChange={(e) => setErrorLog(e.target.value)}
          placeholder="Paste compiler errors, stack traces, runtime logs, or build output from any language..."
          className="w-full p-2.5 text-xs font-mono rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Always-Visible Format & Safety Row */}
      <div className="pt-2 border-t border-[var(--border-default)] flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--text-secondary)]">AI Reply Format:</span>
          <div
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-0.5"
            role="group"
            aria-label="AI reply format"
          >
            <button
              type="button"
              onClick={() => setPatchFormat('search_replace')}
              title="Best accuracy across ChatGPT, Gemini, Claude, and DeepSeek"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                patchFormatPreference === 'search_replace'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Search & Replace
            </button>
            <button
              type="button"
              onClick={() => setPatchFormat('unified_diff')}
              title="Compact unified git diff format"
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                patchFormatPreference === 'unified_diff'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Unified Git Diff
            </button>
          </div>
        </div>

        <label className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] text-xs cursor-pointer select-none self-start sm:self-auto">
          <Shield className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>Hide API keys</span>
          <input
            type="checkbox"
            checked={redactSecrets}
            onChange={(e) => setRedactSecrets(e.target.checked)}
            className="h-3.5 w-3.5 accent-blue-600 cursor-pointer"
          />
        </label>
      </div>

      {/* Action Buttons: Direct Text Copy + Zero-Bloat File Attach */}
      <div className="space-y-2.5 pt-1">
        <button
          type="button"
          disabled={!canPack}
          onClick={() => void handleCopyAll()}
          className={`w-full py-2.5 px-4 rounded-lg disabled:opacity-40 font-medium text-sm flex items-center justify-center gap-2 transition cursor-pointer ${
            !recommendFileMode
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'border border-[var(--border-default)] bg-[var(--bg-subtle)] hover:border-blue-500/50'
          }`}
        >
          {copiedMode === 'inline' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span>
            {copiedMode === 'inline'
              ? 'Copied! Paste into your AI chat'
              : isFollowUp
                ? 'Copy Grounded Follow-Up Prompt'
                : 'Copy Prompt & Code (Text)'}
          </span>
          {!recommendFileMode && copiedMode !== 'inline' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/20">Best</span>
          )}
        </button>

        {/* Zero-Bloat File Attachment Panel (1 overwritten cache file — never clutters Downloads) */}
        <div
          className={`p-3 rounded-xl border space-y-2.5 ${
            recommendFileMode
              ? 'border-blue-500/40 bg-blue-500/5'
              : 'border-[var(--border-default)] bg-[var(--bg-canvas)]/70'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <FileUp className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              <span>Attach as File</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium">
                0 Downloads bloat
              </span>
              {recommendFileMode && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600 text-white font-medium">
                  Recommended
                </span>
              )}
            </div>

            <div
              className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-0.5"
              role="group"
              aria-label="File attachment style"
            >
              <button
                type="button"
                onClick={() => {
                  setFileBundleStyle('all_in_one');
                  setSeparateStep1Done(false);
                }}
                title="Fastest: puts your task prompt + code together inside 1 file. Paste with Ctrl+V and type 'go'."
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${
                  !isSeparateMode
                    ? 'bg-blue-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                1-Paste Magic
              </button>
              <button
                type="button"
                onClick={() => {
                  setFileBundleStyle('separate_prompt');
                  setSeparateStep1Done(false);
                }}
                title="Cleanest chat history: Step 1 copies the code file, Step 2 copies your readable prompt."
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${
                  isSeparateMode
                    ? 'bg-blue-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Separate File + Prompt
              </button>
            </div>
          </div>

          {!isSeparateMode ? (
            <button
              type="button"
              disabled={!canPack || fileModeDisabled}
              onClick={() => void handleCopyAsFile()}
              title={
                fileModeDisabled
                  ? '0 files attached in Text Only mode — use Copy Grounded Follow-Up Prompt above'
                  : 'Overwrites 1 cached file containing both prompt + code and copies it to your clipboard for Ctrl+V'
              }
              className={`w-full py-2 px-3.5 rounded-lg disabled:opacity-40 font-medium text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer ${
                recommendFileMode
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-blue-500/50'
              }`}
            >
              {copiedMode === 'file' ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <FileUp className="h-4 w-4" />
              )}
              <span>
                {copiedMode === 'file'
                  ? 'File Copied! Press Ctrl+V in AI chat & send "go"'
                  : 'Copy All-in-One File (Ctrl+V)'}
              </span>
            </button>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!canPack || fileModeDisabled}
                onClick={() => void handleCopyAsFile()}
                title={
                  fileModeDisabled
                    ? '0 files attached in Text Only mode'
                    : 'Step 1: Overwrites 1 cached code file and copies it to your clipboard for Ctrl+V'
                }
                className={`py-2 px-3 rounded-lg disabled:opacity-40 font-medium text-xs flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  recommendFileMode && !separateStep1Done
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-blue-500/50'
                }`}
              >
                {copiedMode === 'file' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <FileUp className="h-3.5 w-3.5" />
                )}
                <span>
                  {copiedMode === 'file' ? '1. File Copied! (Ctrl+V)' : '1. Copy Code File (Ctrl+V)'}
                </span>
              </button>

              <button
                type="button"
                disabled={!canPack}
                onClick={() => void handleCopySeparatePrompt()}
                title="Step 2: Copies your readable task prompt so you can paste it alongside the attached file"
                className={`py-2 px-3 rounded-lg disabled:opacity-40 font-medium text-xs flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  separateStep1Done
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs'
                    : 'border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-blue-500/50'
                }`}
              >
                {copiedMode === 'separate_prompt' ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                <span>
                  {copiedMode === 'separate_prompt' ? '2. Prompt Copied!' : '2. Copy Prompt Text'}
                </span>
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span>
              {!isSeparateMode
                ? 'Press Ctrl+V in your AI chat to attach, then type "go" and hit Enter.'
                : 'Step 1: Ctrl+V to attach file. Step 2: Ctrl+V to paste readable prompt.'}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={!canPack || fileModeDisabled}
                onClick={() => void handleCopyCachedPath()}
                title="Copy the path of the single overwritten cache file for any Upload dialog"
                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] disabled:opacity-40 cursor-pointer"
              >
                {copiedMode === 'path' ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <FolderOpen className="h-3 w-3" />
                )}
                <span>{copiedMode === 'path' ? 'Path Copied' : 'Copy Path'}</span>
              </button>
              <span className="opacity-40">·</span>
              <button
                type="button"
                disabled={!canPack || fileModeDisabled}
                onClick={() => void handleSaveToDownloads()}
                title="Fallback: download a .txt copy to your Downloads folder (e.g. to share to mobile)"
                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] disabled:opacity-40 cursor-pointer"
              >
                {copiedMode === 'download' ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                <span>{copiedMode === 'download' ? 'Saved' : 'Save .txt'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {lastPackResult && lastPackResult.warnings.length > 0 && (
        <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            <span>Secret Guard Notice</span>
          </div>
          {lastPackResult.warnings.map((w, idx) => (
            <p key={idx} className="text-xs text-amber-800 dark:text-amber-200">
              {w.filePath}: {w.reason}
            </p>
          ))}
        </div>
      )}

      {/* Compact Footer Row: Prompt Preview + Quick Jump to Review */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 mt-auto text-xs">
        <div className="flex items-center gap-3">
          {lastPackResult && (
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>
                {showPreview
                  ? 'Hide preview'
                  : `Preview prompt (~${lastPackResult.stats.estimatedTokens.toLocaleString()} tok)`}
              </span>
            </button>
          )}
          <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
            Copy the AI reply or press Ctrl+V anywhere to review.
          </span>
        </div>

        <button
          type="button"
          onClick={() => setStep('review')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-500/40 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 font-medium cursor-pointer"
        >
          <span>Go to Review</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {showPreview && lastPackResult && (
        <pre className="p-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] text-[11px] font-mono max-h-52 overflow-auto whitespace-pre-wrap">
          {lastPackResult.promptText}
        </pre>
      )}
    </div>
  );
}
