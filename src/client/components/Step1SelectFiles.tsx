import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileCode2,
  Folder,
  GitBranch,
  Minimize2,
  PanelLeftClose,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { evaluateModelFit } from '../../shared/constants.js';
import type { FileTreeNode, ModelFitLevel } from '../../shared/types.js';
import { useWorkbenchStore } from '../store/useWorkbenchStore.js';

function getLeafPaths(node: FileTreeNode): string[] {
  if (node.type === 'file') return [node.path];
  return (node.children ?? []).flatMap(getLeafPaths);
}

function collectAllDirPaths(nodes: FileTreeNode[]): string[] {
  const dirs: string[] = [];
  for (const n of nodes) {
    if (n.type === 'directory') {
      dirs.push(n.path);
      if (n.children) dirs.push(...collectAllDirPaths(n.children));
    }
  }
  return dirs;
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
    changedPaths,
    selectedPaths,
    searchQuery,
    isLoadingTree,
    setSearchQuery,
    toggleNodeSelection,
    selectAllFiles,
    selectChangedFiles,
    removePathsFromSelection,
    clearSelection,
    refreshTree,
    setFilePanelCollapsed,
  } = useWorkbenchStore();

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (fileTree.length === 0) return;
    setExpandedDirs((prev) => {
      if (prev.size > 0) return prev;
      const topDirs = fileTree
        .filter((n) => n.type === 'directory')
        .slice(0, 6)
        .map((n) => n.path);
      return new Set(topDirs);
    });
  }, [fileTree]);

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

  const selectedFolderChips = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const p of selectedPaths) {
      const idx = p.lastIndexOf('/');
      const folder = idx === -1 ? '(root)' : p.slice(0, idx);
      const list = groups.get(folder) ?? [];
      list.push(p);
      groups.set(folder, list);
    }
    return Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [selectedPaths]);

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
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col flex-1 min-h-[420px] lg:max-h-[calc(100vh-148px)]">
      <div className="p-3.5 border-b border-[var(--border-default)] space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm">Project Files</h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              {selectedPaths.size} of {totalFiles} selected (~{selectedTokens.toLocaleString()} tok)
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFilePanelCollapsed(true)}
            title="Hide file tree for more writing space"
            className="hidden lg:inline-flex p-1.5 rounded-lg border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={selectAllFiles}
            className="text-[11px] px-2 py-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            All ({totalFiles})
          </button>
          {changedPaths.length > 0 && (
            <button
              type="button"
              onClick={selectChangedFiles}
              title="Select only uncommitted Git changes"
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 cursor-pointer"
            >
              <GitBranch className="h-3 w-3" />
              <span>Changed ({changedPaths.length})</span>
            </button>
          )}
          <button
            type="button"
            onClick={clearSelection}
            className="text-[11px] px-2 py-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            Clear
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpandedDirs(new Set(collectAllDirPaths(fileTree)))}
              title="Expand all folders"
              className="p-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setExpandedDirs(new Set())}
              title="Collapse all folders"
              className="p-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void refreshTree()}
              title="Refresh files from disk"
              className="p-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingTree ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="h-3.5 w-3.5 text-[var(--text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter folders or files..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="p-2 overflow-y-auto flex-1 min-h-0">
        {isLoadingTree ? (
          <div className="p-5 text-xs text-[var(--text-muted)]">Scanning project files...</div>
        ) : filteredTree.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--text-muted)]">
            No matching code files found.
          </div>
        ) : (
          filteredTree.map((node) => renderNode(node, 0))
        )}
      </div>

      {/* Compact Footer: Selected Chips + Model Fit + Safety Notice */}
      <div className="p-3 border-t border-[var(--border-default)] bg-[var(--bg-subtle)]/50 space-y-2.5 shrink-0">
        {selectedFolderChips.length > 0 && (
          <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
            {selectedFolderChips.map(([folder, paths]) => (
              <span
                key={folder}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[11px] font-mono"
              >
                <span className="truncate max-w-[130px]">{folder}</span>
                <span className="text-[var(--text-muted)]">({paths.length})</span>
                <button
                  type="button"
                  onClick={() => removePathsFromSelection(paths)}
                  className="text-[var(--text-muted)] hover:text-red-500 cursor-pointer"
                  title={`Remove ${folder}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
          <span className="text-[var(--text-muted)]">ChatGPT: <FitBadge level={modelFit.chatgpt} /></span>
          <span className="text-[var(--text-muted)]">Claude: <FitBadge level={modelFit.claude} /></span>
          <span className="text-[var(--text-muted)]">Gemini: <FitBadge level={modelFit.gemini} /></span>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="truncate">
            Auto-hidden: .gitignore, {skippedSecretsCount} secret(s), {skippedBinaryCount} binary/large
          </span>
        </div>
      </div>
    </div>
  );
}
