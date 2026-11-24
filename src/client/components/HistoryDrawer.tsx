import { RotateCcw, X } from 'lucide-react';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

export function HistoryDrawer() {
  const { historyDrawerOpen, setHistoryDrawerOpen, snapshots, undoSnapshotById } =
    useWorkbenchStore();

  if (!historyDrawerOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs">
      <div className="w-full max-w-md bg-[var(--bg-surface)] h-full shadow-2xl border-l border-[var(--border-default)] flex flex-col">
        <div className="p-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Applied Changes History</h2>
            <p className="text-xs text-[var(--text-muted)]">
              Every apply creates a local backup so you can undo safely.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setHistoryDrawerOpen(false)}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {snapshots.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-muted)]">
              No changes applied in this project yet.
            </div>
          ) : (
            snapshots.map((snap) => (
              <div
                key={snap.snapshotId}
                className="p-3.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{snap.summary}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {new Date(snap.appliedAt).toLocaleString()}
                    </p>
                  </div>
                  {snap.reverted ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-muted)]">
                      Undone
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void undoSnapshotById(snap.snapshotId)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Undo
                    </button>
                  )}
                </div>

                <ul className="space-y-1 text-xs font-mono text-[var(--text-secondary)]">
                  {snap.files.map((f) => (
                    <li key={f.filePath} className="truncate">
                      <span className="uppercase text-[10px] mr-1.5 text-[var(--text-muted)]">
                        [{f.action}]
                      </span>
                      {f.filePath}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
