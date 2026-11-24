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

const STEPS: Array<{ id: WizardStep; title: string }> = [
  { id: 1, title: '1. Pick Files' },
  { id: 2, title: '2. Describe Task' },
  { id: 3, title: '3. Review & Apply' },
];

export function App() {
  const {
    activeStep,
    selectedPaths,
    hasUnreadPatch,
    toasts,
    setStep,
    bootstrap,
    receiveIncomingParse,
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
        setStep(1);
      } else if (e.key === '2') {
        e.preventDefault();
        setStep(2);
      } else if (e.key === '3') {
        e.preventDefault();
        setStep(3);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setStep]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <TopBar />

      {/* 3-Step Guided Navigation */}
      <nav className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-2 shrink-0">
        <div className="max-w-3xl mx-auto grid grid-cols-3 gap-2">
          {STEPS.map((s) => {
            const active = activeStep === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                className={`py-2 px-3 rounded-lg text-xs sm:text-sm font-medium flex items-center justify-center gap-2 transition cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{s.title}</span>
                {s.id === 1 && selectedPaths.size > 0 && (
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-white/20 text-white' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                    }`}
                  >
                    {selectedPaths.size}
                  </span>
                )}
                {s.id === 3 && hasUnreadPatch && (
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Active Step Workspace */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        {activeStep === 1 && <Step1SelectFiles />}
        {activeStep === 2 && <Step2DescribeTask />}
        {activeStep === 3 && <Step3ReviewApply />}
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
