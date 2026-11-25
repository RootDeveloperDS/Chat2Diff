import { useEffect } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { WizardStep } from '../shared/types.js';
import { HistoryDrawer } from './components/HistoryDrawer.js';
import { RepoPickerModal } from './components/RepoPickerModal.js';
import { Step1SelectFiles } from './components/Step1SelectFiles.js';
import { Step2DescribeTask } from './components/Step2DescribeTask.js';
import { Step3ReviewApply } from './components/Step3ReviewApply.js';
import { TopBar } from './components/TopBar.js';
import { connectPatchSocket } from './lib/api.js';
import { useWorkbenchStore } from './store/useWorkbenchStore.js';

const VIEWS: Array<{ id: WizardStep; title: string; shortcut: string }> = [
  { id: 'prepare', title: '1. Prepare & Send', shortcut: 'Alt+1' },
  { id: 'review', title: '2. Review & Apply', shortcut: 'Alt+2' },
];

function looksLikePatchText(text: string): boolean {
  if (!text || text.length < 15) return false;
  if (/(?:<[ \t]*){4,12}[ \t]*SEARCH/i.test(text) && /(?:>[ \t]*){4,12}[ \t]*REPLACE/i.test(text)) {
    return true;
  }
  if (/^--- .+\n\+\+\+ .+/m.test(text) && text.includes('@@')) return true;
  if (/^[ \t]*(?:[#*>\s\-\/\d.]*)(?:CREATE FILE|NEW FILE|DELETE FILE|REMOVE FILE)\*{0,2}\s*:/mi.test(text)) {
    return true;
  }
  return false;
}

export function App() {
  const {
    activeStep,
    repoName,
    socketConnected,
    selectedPaths,
    activeParse,
    appliedFilePaths,
    hasUnreadPatch,
    filePanelCollapsed,
    toasts,
    setStep,
    bootstrap,
    receiveIncomingParse,
    parseRawText,
    setWatcherStatus,
    setSocketConnected,
    dismissToast,
    undoSnapshotById,
  } = useWorkbenchStore();

  useEffect(() => {
    void bootstrap();
    const disconnect = connectPatchSocket(
      (evt) => {
        if (evt.type === 'PATCH_DETECTED') {
          receiveIncomingParse(evt.payload.parseResult, true);
        } else if (evt.type === 'WATCHER_STATUS') {
          setWatcherStatus(evt.payload.enabled, evt.payload.available);
        }
      },
      (connected) => setSocketConnected(connected)
    );
    return disconnect;
  }, [bootstrap, receiveIncomingParse, setWatcherStatus, setSocketConnected]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === '1') {
        e.preventDefault();
        setStep('prepare');
      } else if (e.key === '2') {
        e.preventDefault();
        setStep('review');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setStep]);

  // Paste-Anywhere shortcut (Ctrl+V / Cmd+V outside text inputs)
  useEffect(() => {
    const onGlobalPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const pasted = e.clipboardData?.getData('text/plain') ?? '';
      if (!pasted.trim()) return;
      const onReview = useWorkbenchStore.getState().activeStep === 'review';
      if (onReview || looksLikePatchText(pasted)) {
        e.preventDefault();
        void parseRawText(pasted);
      }
    };
    window.addEventListener('paste', onGlobalPaste);
    return () => window.removeEventListener('paste', onGlobalPaste);
  }, [parseRawText]);

  const pendingReviewCount = activeParse
    ? activeParse.files.filter((f) => f.status === 'ready' && !appliedFilePaths.has(f.filePath))
        .length
    : 0;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <TopBar />

      {repoName !== 'Loading...' && !socketConnected && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-1.5 text-center text-xs text-amber-800 dark:text-amber-200 shrink-0">
          Local Chat2Diff server disconnected — re-run <code className="font-mono font-semibold">npx chat2diff</code> in your terminal to reconnect.
        </div>
      )}

      {/* Clean 2-Mode Navigation */}
      <nav className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-2 shrink-0">
        <div className="max-w-xl mx-auto grid grid-cols-2 gap-2">
          {VIEWS.map((s) => {
            const active = activeStep === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                title={`Switch view (${s.shortcut})`}
                className={`py-2 px-3 rounded-lg text-xs sm:text-sm font-medium flex items-center justify-center gap-2 transition cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{s.title}</span>
                {s.id === 'prepare' && selectedPaths.size > 0 && (
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-white/20 text-white' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                    }`}
                  >
                    {selectedPaths.size} files
                  </span>
                )}
                {s.id === 'review' && pendingReviewCount > 0 && (
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-white/20 text-white' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    }`}
                  >
                    {pendingReviewCount} pending
                  </span>
                )}
                {s.id === 'review' && hasUnreadPatch && (
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Active Mode Workspace */}
      <main className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {activeStep === 'prepare' ? (
          <div className="p-4 sm:p-5 max-w-[1440px] mx-auto w-full flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-5">
            {!filePanelCollapsed && (
              <div className="lg:col-span-5 xl:col-span-4 min-h-0 flex flex-col">
                <Step1SelectFiles />
              </div>
            )}
            <div
              className={`${
                filePanelCollapsed ? 'lg:col-span-12 max-w-4xl mx-auto w-full' : 'lg:col-span-7 xl:col-span-8'
              } min-h-0 flex flex-col`}
            >
              <Step2DescribeTask />
            </div>
          </div>
        ) : (
          <Step3ReviewApply />
        )}
      </main>

      <RepoPickerModal />
      <HistoryDrawer />

      {/* Toast Notifications */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-xl shadow-lg border text-xs flex items-center justify-between gap-3 ${
              t.tone === 'success'
                ? 'bg-emerald-600 text-white border-emerald-500'
                : t.tone === 'error'
                  ? 'bg-red-600 text-white border-red-500'
                  : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border-default)]'
            }`}
          >
            <span>{t.text}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {t.actionLabel && t.actionStep && (
                <button
                  type="button"
                  onClick={() => {
                    setStep(t.actionStep!);
                    dismissToast(t.id);
                  }}
                  className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold cursor-pointer"
                >
                  {t.actionLabel}
                </button>
              )}
              {t.undoSnapshotId && (
                <button
                  type="button"
                  onClick={() => {
                    void undoSnapshotById(t.undoSnapshotId!);
                    dismissToast(t.id);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/20 hover:bg-white/30 font-semibold cursor-pointer"
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo
                </button>
              )}
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="p-0.5 opacity-80 hover:opacity-100 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
