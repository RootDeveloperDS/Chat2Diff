import { Clock, FolderGit2, FolderOpen, Layers, Moon, Radio, Sun, Zap } from 'lucide-react';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

export function TopBar() {
  const {
    repoName,
    isGitRepo,
    gitBranch,
    clipboardWatchEnabled,
    clipboardAvailable,
    autoJumpToReview,
    darkMode,
    snapshots,
    setRepoPickerOpen,
    setHistoryDrawerOpen,
    toggleWatcher,
    toggleAutoJumpToReview,
    toggleDarkMode,
  } = useWorkbenchStore();

  const activeUndoCount = snapshots.filter((s) => !s.reverted).length;

  return (
    <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 font-bold text-base tracking-tight text-blue-600 dark:text-blue-400 shrink-0">
          <Layers className="h-5 w-5" />
          <span>Chat2Diff</span>
        </div>

        <span className="text-[var(--border-default)]">/</span>

        <button
          type="button"
          onClick={() => setRepoPickerOpen(true)}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] hover:border-blue-500/50 transition text-sm font-medium truncate max-w-[260px] sm:max-w-xs cursor-pointer"
          title="Click to switch project folder"
        >
          {isGitRepo ? (
            <FolderGit2 className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
          ) : (
            <FolderOpen className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <span className="truncate">{repoName}</span>
          {gitBranch && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono shrink-0">
              {gitBranch}
            </span>
          )}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void toggleWatcher()}
          disabled={!clipboardAvailable}
          className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition cursor-pointer ${
            clipboardWatchEnabled && clipboardAvailable
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--text-muted)]'
          }`}
          title={
            clipboardAvailable
              ? 'Toggle automatic detection when you copy an AI reply'
              : 'Clipboard auto-watch unavailable; use manual paste in Step 3'
          }
        >
          <Radio className={`h-3.5 w-3.5 ${clipboardWatchEnabled ? 'animate-pulse' : ''}`} />
          <span>
            {!clipboardAvailable
              ? 'Manual Paste Mode'
              : clipboardWatchEnabled
                ? 'Listening for AI Replies'
                : 'Auto-Listen Paused'}
          </span>
        </button>

        <button
          type="button"
          onClick={toggleAutoJumpToReview}
          className={`hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium border transition cursor-pointer ${
            autoJumpToReview
              ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
              : 'border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--text-muted)]'
          }`}
          title="Automatically switch to Review & Apply when an AI patch is copied to your clipboard"
        >
          <Zap className="h-3.5 w-3.5"/>
          <span>{autoJumpToReview ? 'Auto-Review On' : 'Auto-Review Off'}</span>
        </button>

        <button
          type="button"
          onClick={() => setHistoryDrawerOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-subtle)] transition cursor-pointer"
        >
          <Clock className="h-3.5 w-3.5" />
          <span>Undo History</span>
          {activeUndoCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-blue-600 text-white text-[11px]">
              {activeUndoCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={toggleDarkMode}
          aria-label="Toggle color theme"
          className="p-2 rounded-lg border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] transition cursor-pointer"
        >
          {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
