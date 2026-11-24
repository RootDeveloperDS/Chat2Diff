import { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  Shield,
} from 'lucide-react';
import { TASK_PRESETS } from '../../shared/constants.js';
import type { TaskPreset } from '../../shared/types.js';
import { downloadTextFile } from '../lib/api.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

export function Step2DescribeTask() {
  const {
    selectedPaths,
    preset,
    taskDescription,
    errorLog,
    patchFormatPreference,
    redactSecrets,
    lastPackResult,
    isPacking,
    setPreset,
    setTaskDescription,
    setErrorLog,
    setPatchFormat,
    setRedactSecrets,
    packContext,
    setStep,
    pushToast,
  } = useWorkbenchStore();

  const [copiedMode, setCopiedMode] = useState<'inline' | 'file' | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleCopyAll = async () => {
    const res = await packContext('inline_copy');
    if (!res) return;
    await navigator.clipboard.writeText(res.promptText);
    setCopiedMode('inline');
    pushToast('success', 'Copied full prompt & code! Paste it into any AI chat.');
    window.setTimeout(() => setCopiedMode(null), 3000);
  };

  const handleDownloadAndCopy = async () => {
    const res = await packContext('file_attachment');
    if (!res || !res.contextFileContent) return;
    downloadTextFile(res.contextFileName, res.contextFileContent);
    await navigator.clipboard.writeText(res.promptText);
    setCopiedMode('file');
    pushToast(
      'success',
      `Downloaded ${res.contextFileName} & copied the short prompt to your clipboard!`
    );
    window.setTimeout(() => setCopiedMode(null), 3500);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
      {/* Left: Plain-English Task Form */}
      <div className="lg:col-span-7 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
<div>
        <h2 className="font-semibold text-base">Describe what you need help with</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Working with {selectedPaths.size} selected file(s). Write normally - Chat2Diff handles
          the AI formatting instructions automatically.
        </p>
      </div>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Change files</span>
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(Object.keys(TASK_PRESETS) as TaskPreset[]).map((key) => {
            const item = TASK_PRESETS[key];
            const active = preset === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPreset(key)}
                className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                  active
                    ? 'border-blue-600 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                    : 'border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'
                }`}
              >
                <div className="text-xs font-semibold">{item.label}</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-2">
                  {item.shortDesc}
                </div>
              </button>
            );
          })}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">
            What do you want the AI to do?
          </label>
          <textarea
            rows={5}
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            placeholder="Example: Fix the login button alignment on mobile screens and add a loading spinner while signing in..."
            className="w-full p-3 text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">
            Paste any error message or terminal output{' '}
            <span className="text-xs font-normal text-[var(--text-muted)]">(optional)</span>
          </label>
          <textarea
            rows={3}
            value={errorLog}
            onChange={(e) => setErrorLog(e.target.value)}
            placeholder="Paste TypeScript errors, console stack traces, or failing test output here..."
            className="w-full p-3 text-xs font-mono rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="pt-3 border-t border-[var(--border-default)] space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm cursor-pointer">
            <span className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Automatically hide detected API keys before copying</span>
            </span>
            <input
              type="checkbox"
              checked={redactSecrets}
              onChange={(e) => setRedactSecrets(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer"
            >
              {showAdvanced ? 'Hide advanced format option' : 'Advanced: Choose AI reply format'}
            </button>
            {showAdvanced && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setPatchFormat('search_replace')}
                  className={`flex-1 p-2 rounded-lg border text-xs text-left cursor-pointer ${
                    patchFormatPreference === 'search_replace'
                      ? 'border-blue-600 bg-blue-500/10 font-medium'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  Search & Replace (Recommended - works best across all AI chats)
                </button>
                <button
                  type="button"
                  onClick={() => setPatchFormat('unified_diff')}
                  className={`flex-1 p-2 rounded-lg border text-xs text-left cursor-pointer ${
                    patchFormatPreference === 'unified_diff'
                      ? 'border-blue-600 bg-blue-500/10 font-medium'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  Unified Git Diff (Compact format for large changes)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Ready-to-Use Export Card */}
      <div className="lg:col-span-5 space-y-4">
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 space-y-4">
          <h2 className="font-semibold text-base">Send to Any AI Chatbot</h2>

          <div className="space-y-2.5">
            <button
              type="button"
              disabled={isPacking || !taskDescription.trim() || selectedPaths.size === 0}
              onClick={() => void handleCopyAll()}
              className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium text-sm flex items-center justify-center gap-2 transition cursor-pointer"
            >
              {copiedMode === 'inline' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span>
                {copiedMode === 'inline' ? 'Copied! Paste into your AI chat' : 'Copy Full Prompt & Code'}
              </span>
            </button>

            <button
              type="button"
              disabled={isPacking || !taskDescription.trim() || selectedPaths.size === 0}
              onClick={() => void handleDownloadAndCopy()}
              className="w-full py-2.5 px-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] hover:border-blue-500/50 disabled:opacity-40 font-medium text-sm flex items-center justify-center gap-2 transition cursor-pointer"
            >
              {copiedMode === 'file' ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span>Download Context File (.txt) + Copy Prompt</span>
            </button>
            <p className="text-[11px] text-[var(--text-muted)] text-center">
              Tip: Use the .txt file download when working on many files in Gemini, ChatGPT, or Claude.
            </p>
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

          <div className="p-3.5 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-default)] space-y-2 text-xs text-[var(--text-secondary)]">
            <p className="font-semibold text-[var(--text-primary)]">What to do next:</p>
<ol className="list-decimal list-inside space-y-1">
          <li>Paste into ChatGPT, Gemini, Claude, DeepSeek, or any AI chat.</li>
          <li>When the AI finishes, click Copy on its response.</li>
          <li>Come back here - Chat2Diff catches it automatically in Step 3.</li>
        </ol>
      </div>

          <button
            type="button"
            onClick={() => setStep(3)}
            className="w-full py-2 px-4 rounded-lg border border-blue-500/40 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 text-sm font-medium flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <span>Go to Step 3: Review & Apply Changes</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
