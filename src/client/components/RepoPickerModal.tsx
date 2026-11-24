import { useEffect, useState } from 'react';
import { ArrowUp, Check, Folder, FolderGit2, X } from 'lucide-react';
import type { DirectoryListResponse } from '../../shared/types.js';
import { api } from '../lib/api.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

export function RepoPickerModal() {
  const { repoPickerOpen, setRepoPickerOpen, repoPath, recentRepos, switchRepo } =
    useWorkbenchStore();

  const [dirData, setDirData] = useState<DirectoryListResponse | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDirectories(target);
      setDirData(res);
      setManualPath(res.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open folder.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (repoPickerOpen) {
      void browse(repoPath || undefined);
    }
  }, [repoPickerOpen, repoPath]);

  if (!repoPickerOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Choose Project Folder</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Pick any local folder on your computer to work on with Chat2Diff.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRepoPickerOpen(false)}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {recentRepos.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Recent Projects</p>
              <div className="flex flex-wrap gap-2">
                {recentRepos.slice(0, 6).map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => void switchRepo(r.path)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition cursor-pointer ${
                      r.path.toLowerCase() === repoPath.toLowerCase()
                        ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
                        : 'border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'
                    }`}
                    title={r.path}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void browse(manualPath);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="Paste or type a folder path..."
              className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-lg text-xs font-medium border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              Go
            </button>
          </form>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-[var(--bg-subtle)] border-b border-[var(--border-default)] flex items-center justify-between gap-2">
              <span className="text-xs font-mono truncate text-[var(--text-secondary)]">
                {dirData?.currentPath ?? '...'}
              </span>
              {dirData?.parentPath && (
                <button
                  type="button"
                  onClick={() => void browse(dirData.parentPath!)}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-canvas)] shrink-0 cursor-pointer"
                >
                  <ArrowUp className="h-3 w-3" />
                  Up
                </button>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-[var(--border-default)]">
              {loading ? (
                <div className="p-4 text-xs text-[var(--text-muted)]">Loading folders...</div>
              ) : dirData && dirData.entries.length > 0 ? (
                dirData.entries.map((entry) => (
                  <div
                    key={entry.path}
                    className="px-3 py-2 flex items-center justify-between hover:bg-[var(--bg-subtle)] transition"
                  >
                    <button
                      type="button"
                      onClick={() => void browse(entry.path)}
                      className="flex items-center gap-2 text-sm text-left flex-1 min-w-0 cursor-pointer"
                    >
                      {entry.isGitRepo ? (
                        <FolderGit2 className="h-4 w-4 text-blue-500 shrink-0" />
                      ) : (
                        <Folder className="h-4 w-4 text-[var(--text-muted)] shrink-0" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void switchRepo(entry.path)}
                      className="ml-2 px-2.5 py-1 rounded text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 cursor-pointer"
                    >
                      Open
                    </button>
                  </div>
                ))
              ) : (
                <div className="p-4 text-xs text-[var(--text-muted)]">No subfolders here.</div>
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-subtle)] flex items-center justify-between">
          <span className="text-xs text-[var(--text-muted)] truncate max-w-md">
            Current folder: {dirData?.currentPath}
          </span>
          <button
            type="button"
            disabled={!dirData}
            onClick={() => dirData && void switchRepo(dirData.currentPath)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" />
            Use This Folder
          </button>
        </div>
      </div>
    </div>
  );
}
