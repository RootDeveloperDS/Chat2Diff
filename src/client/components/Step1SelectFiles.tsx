import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { evaluateModelFit } from '../../shared/constants.js';
import type { FileTreeNode, ModelFitLevel } from '../../shared/types.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

function getLeafPaths(node: FileTreeNode): string[] {
  if (node.type === 'file') return [node.path];
  return (node.children ?? []).flatMap(getLeafPaths);
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query.trim()) return nodes;
  const q = query.toLowerCase();
  const out: FileTreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') {
      if (n.path.toLowerCase().includes(q)) out.push(n);
    } else {
      const matchedChildren = filterTree(n.children ?? [], q);
      if (matchedChildren.length > 0 || n.path.toLowerCase().includes(q)) {
        out.push({ ...n, children: matchedChildren.length > 0 ? matchedChildren : n.children });
      }
    }
  }
  return out;
}

function TriCheckbox({
  state,
  onChange,
}: {
  state: 'checked' | 'unchecked' | 'indeterminate';
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === 'indeterminate';
    }
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      onChange={onChange}
      className="h-4 w-4 rounded border-[var(--border-default)] accent-blue-600 cursor-pointer shrink-0"
    />
  );
}

function FitBadge({ level }: { level: ModelFitLevel }) {
  if (level === 'great') {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        Fits easily
      </span>
    );
  }
  if (level === 'tight') {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Tight fit
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400">
      Too large
    </span>
  );
}

export function Step1SelectFiles() {
  const {
    fileTree,
    totalFiles,
    skippedSecretsCount,
    skippedBinaryCount,
    selectedPaths,
    searchQuery,
    isLoadingTree,
    setSearchQuery,
    toggleNodeSelection,
    selectAllFiles,
    clearSelection,
    refreshTree,
    setStep,
  } = useWorkbenchStore();

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const filteredTree = useMemo(() => filterTree(fileTree, searchQuery), [fileTree, searchQuery]);

  const tokenMap = useMemo(() => {
    const map = new Map<string, number>();
    const visit = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') map.set(n.path, n.estimatedTokens);
        else if (n.children) visit(n.children);
      }
    };
    visit(fileTree);
    return map;
  }, [fileTree]);

  const selectedTokens = useMemo(() => {
    let total = 0;
    for (const p of selectedPaths) total += tokenMap.get(p) ?? 0;
    return total;
  }, [selectedPaths, tokenMap]);

  const modelFit = useMemo(() => evaluateModelFit(selectedTokens), [selectedTokens]);

  const toggleExpand = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const renderNode = (node: FileTreeNode, depth: number) => {
    const leaves = getLeafPaths(node);
    const selectedCount = leaves.filter((p) => selectedPaths.has(p)).length;
    const checkState: 'checked' | 'unchecked' | 'indeterminate' =
      selectedCount === 0
        ? 'unchecked'
        : selectedCount === leaves.length
          ? 'checked'
          : 'indeterminate';

    const isExpanded = searchQuery.trim().length > 0 || expandedDirs.has(node.path);

    return (
      <div key={node.path}>
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-[var(--bg-subtle)] transition text-sm"
          style={{ paddingLeft: `${depth * 18 + 8}px` }}
        >
          {node.type === 'directory' ? (
            <button
              type="button"
              onClick={() => toggleExpand(node.path)}
              className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}

          <TriCheckbox state={checkState} onChange={() => toggleNodeSelection(node)} />

          {node.type === 'directory' ? (
            <button
              type="button"
              onClick={() => toggleExpand(node.path)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
            >
              <Folder className="h-4 w-4 text-blue-500 shrink-0" />
              <span className="font-medium truncate">{node.name}</span>
              <span className="text-xs text-[var(--text-muted)] shrink-0">
                {node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => toggleNodeSelection(node)}
              className="flex items-center justify-between gap-2 flex-1 min-w-0 text-left cursor-pointer"
            >
              <span className="flex items-center gap-2 min-w-0">
                <FileCode2 className="h-4 w-4 text-[var(--text-muted)] shrink-0" />
                <span className="truncate">{node.name}</span>
              </span>
              <span className="text-xs text-[var(--text-muted)] font-mono shrink-0">
                ~{node.estimatedTokens.toLocaleString()} tok
              </span>
            </button>
          )}
        </div>

        {node.type === 'directory' && isExpanded && node.children && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
      {/* Left: Interactive Folder & File Picker */}
      <div className="lg:col-span-8 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[var(--border-default)] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-sm">Pick the folders or files you want to work on</h2>
              <p className="text-xs text-[var(--text-muted)]">
                Check a whole folder to include everything inside it, or pick specific files.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectAllFiles}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
              >
                Select All ({totalFiles})
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => void refreshTree()}
                title="Refresh files from disk"
                className="p-1.5 rounded-lg border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isLoadingTree ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="h-4 w-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter folders or files (e.g. components, api, auth)..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>
              Auto-hidden for safety: .gitignore files, {skippedSecretsCount} secret file(s), and{' '}
              {skippedBinaryCount} binary/large asset(s).
            </span>
          </div>
        </div>

        <div className="p-2 overflow-y-auto max-h-[58vh]">
          {isLoadingTree ? (
            <div className="p-6 text-sm text-[var(--text-muted)]">Scanning project files...</div>
          ) : filteredTree.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--text-muted)]">
              No matching code files found.
            </div>
          ) : (
            filteredTree.map((node) => renderNode(node, 0))
          )}
        </div>
      </div>

      {/* Right: Friendly Selection & Fit Summary */}
      <div className="lg:col-span-4 space-y-4">
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 space-y-5 sticky top-6">
          <div>
            <h2 className="font-semibold text-sm text-[var(--text-secondary)]">Selection Summary</h2>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold">{selectedPaths.size}</span>
              <span className="text-sm text-[var(--text-muted)]">
                {selectedPaths.size === 1 ? 'file selected' : 'files selected'}
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Estimated size: ~{selectedTokens.toLocaleString()} tokens
            </p>
          </div>

          <div className="space-y-2.5 pt-3 border-t border-[var(--border-default)]">
            <p className="text-xs font-medium text-[var(--text-secondary)]">Will this fit in my AI chat?</p>
            <div className="flex items-center justify-between text-sm">
              <span>ChatGPT (128K)</span>
              <FitBadge level={modelFit.chatgpt} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>Claude (200K)</span>
              <FitBadge level={modelFit.claude} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>Gemini (1M)</span>
              <FitBadge level={modelFit.gemini} />
            </div>
          </div>

          <button
            type="button"
            disabled={selectedPaths.size === 0}
            onClick={() => setStep(2)}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium text-sm flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <span>Next: Describe Your Task</span>
            <ArrowRight className="h-4 w-4" />
          </button>

          {selectedPaths.size === 0 && (
            <p className="text-xs text-center text-[var(--text-muted)]">
              Pick at least one file or folder on the left to continue.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
