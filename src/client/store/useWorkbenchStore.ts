import { create } from 'zustand';
import { diffLines } from 'diff';
import type {
  FileTreeNode,
  PackResponse,
  ParsePatchResponse,
  PatchFormat,
  RecentRepo,
  SnapshotSummary,
  TaskPreset,
  WizardStep,
} from '../../shared/types.js';
import { api } from '../lib/api.js';

export interface ToastMessage {
  id: string;
  tone: 'success' | 'error' | 'info';
  text: string;
  undoSnapshotId?: string;
  actionLabel?: string;
  actionStep?: WizardStep;
}

function collectLeafFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') out.push(n);
    else if (n.children) out.push(...collectLeafFiles(n.children));
  }
  return out;
}

function getSelectionStorageKey(repoPath: string): string {
  return `chat2diff_selection::${repoPath.toLowerCase()}`;
}

function loadSavedSelection(repoPath: string): string[] {
  if (typeof window === 'undefined' || !repoPath) return [];
  try {
    const raw = localStorage.getItem(getSelectionStorageKey(repoPath));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSelection(repoPath: string, paths: Set<string>): void {
  if (typeof window === 'undefined' || !repoPath) return;
  try {
    localStorage.setItem(getSelectionStorageKey(repoPath), JSON.stringify(Array.from(paths)));
  } catch {
    // ignore quota errors
  }
}

const PATCH_FORMAT_STORAGE_KEY = 'chat2diff_patch_format';
const REDACT_SECRETS_STORAGE_KEY = 'chat2diff_redact_secrets';

function loadSavedPatchFormat(): PatchFormat | null {
  if (typeof window === 'undefined') return null;
  const val = localStorage.getItem(PATCH_FORMAT_STORAGE_KEY);
  return val === 'unified_diff' || val === 'search_replace' ? val : null;
}

function loadSavedRedactSecrets(): boolean {
  if (typeof window === 'undefined') return true;
  const val = localStorage.getItem(REDACT_SECRETS_STORAGE_KEY);
  return val === null ? true : val === 'true';
}

function countDiffLines(original: string, proposed: string): { additions: number; deletions: number } {
  const parts = diffLines(original, proposed);
  let additions = 0;
  let deletions = 0;
  for (const p of parts) {
    const count = p.count ?? 0;
    if (p.added) additions += count;
    if (p.removed) deletions += count;
  }
  return { additions, deletions };
}

interface WorkbenchStore {
  // Navigation & Drawers
  activeStep: WizardStep;
  repoPickerOpen: boolean;
  historyDrawerOpen: boolean;
  darkMode: boolean;
  socketConnected: boolean;
  toasts: ToastMessage[];

  // Workspace
  repoPath: string;
  repoName: string;
  isGitRepo: boolean;
  gitBranch: string | null;
  clipboardWatchEnabled: boolean;
  clipboardAvailable: boolean;
  recentRepos: RecentRepo[];

  // Step 1
  fileTree: FileTreeNode[];
  totalFiles: number;
  skippedSecretsCount: number;
  skippedBinaryCount: number;
  selectedPaths: Set<string>;
  searchQuery: string;
  isLoadingTree: boolean;

  // Step 2
  preset: TaskPreset;
  taskDescription: string;
  errorLog: string;
  patchFormatPreference: PatchFormat;
  redactSecrets: boolean;
  lastPackResult: PackResponse | null;
  isPacking: boolean;

  // Step 3
  rawPasteInput: string;
  activeParse: ParsePatchResponse | null;
  checkedApplyPaths: Set<string>;
  appliedFilePaths: Set<string>;
  appliedFileSnapshots: Record<string, string>;
  selectedPreviewFile: string | null;
  hasUnreadPatch: boolean;
  isParsing: boolean;
  isApplying: boolean;

  // History
  snapshots: SnapshotSummary[];

  // Actions
  setStep: (step: WizardStep) => void;
  setRepoPickerOpen: (open: boolean) => void;
  setHistoryDrawerOpen: (open: boolean) => void;
  toggleDarkMode: () => void;
  setSocketConnected: (connected: boolean) => void;
  pushToast: (
    tone: ToastMessage['tone'],
    text: string,
    undoSnapshotId?: string,
    action?: { label: string; step: WizardStep }
  ) => void;
  dismissToast: (id: string) => void;

  bootstrap: () => Promise<void>;
  refreshTree: (silent?: boolean) => Promise<void>;
  refreshHistory: () => Promise<void>;
  switchRepo: (repoPath: string) => Promise<void>;
  toggleWatcher: () => Promise<void>;
  setWatcherStatus: (enabled: boolean, available: boolean) => void;

  setSearchQuery: (q: string) => void;
  toggleNodeSelection: (node: FileTreeNode) => void;
  selectAllFiles: () => void;
  clearSelection: () => void;

  setPreset: (preset: TaskPreset) => void;
  setTaskDescription: (val: string) => void;
  setErrorLog: (val: string) => void;
  setPatchFormat: (fmt: PatchFormat) => void;
  setRedactSecrets: (val: boolean) => void;
  packContext: (mode: 'inline_copy' | 'file_attachment') => Promise<PackResponse | null>;

  setRawPasteInput: (val: string) => void;
  receiveIncomingParse: (parse: ParsePatchResponse, fromClipboard: boolean) => void;
  parseManualPaste: () => Promise<void>;
  toggleApplyFile: (filePath: string) => void;
  setAllReadyApply: (checked: boolean) => void;
  setSelectedPreviewFile: (filePath: string) => void;
  clearActiveParse: () => void;
  applyCheckedFiles: (customContents?: Record<string, string>) => Promise<void>;
  applySingleFile: (filePath: string, customContent?: string) => Promise<void>;
  applyPartialFileContent: (filePath: string, mergedContent: string) => Promise<void>;
  undoSnapshotById: (snapshotId: string) => Promise<void>;
}

const initialDark =
  typeof window !== 'undefined' &&
  (localStorage.getItem('chat2diff_theme') === 'dark' ||
    (!localStorage.getItem('chat2diff_theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches));

if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('dark', initialDark);
}

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  activeStep: 1,
  repoPickerOpen: false,
  historyDrawerOpen: false,
  darkMode: initialDark,
  socketConnected: false,
  toasts: [],

  repoPath: '',
  repoName: 'Loading...',
  isGitRepo: false,
  gitBranch: null,
  clipboardWatchEnabled: true,
  clipboardAvailable: true,
  recentRepos: [],

  fileTree: [],
  totalFiles: 0,
  skippedSecretsCount: 0,
  skippedBinaryCount: 0,
  selectedPaths: new Set<string>(),
  searchQuery: '',
  isLoadingTree: false,

  preset: 'bug_fix',
  taskDescription: '',
  errorLog: '',
  patchFormatPreference: loadSavedPatchFormat() ?? 'search_replace',
  redactSecrets: loadSavedRedactSecrets(),
  lastPackResult: null,
  isPacking: false,

  rawPasteInput: '',
  activeParse: null,
  checkedApplyPaths: new Set<string>(),
  appliedFilePaths: new Set<string>(),
  appliedFileSnapshots: {},
  selectedPreviewFile: null,
  hasUnreadPatch: false,
  isParsing: false,
  isApplying: false,

  snapshots: [],

  setStep: (step) =>
    set((s) => ({
      activeStep: step,
      hasUnreadPatch: step === 3 ? false : s.hasUnreadPatch,
    })),

  setRepoPickerOpen: (open) => set({ repoPickerOpen: open }),
  setHistoryDrawerOpen: (open) => {
    set({ historyDrawerOpen: open });
    if (open) void get().refreshHistory();
  },

  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      document.documentElement.classList.toggle('dark', next);
      localStorage.setItem('chat2diff_theme', next ? 'dark' : 'light');
      return { darkMode: next };
    }),

  setSocketConnected: (connected) => set({ socketConnected: connected }),

  pushToast: (tone, text, undoSnapshotId, action) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      toasts: [
        ...s.toasts.slice(-3),
        {
          id,
          tone,
          text,
          undoSnapshotId,
          actionLabel: action?.label,
          actionStep: action?.step,
        },
      ],
    }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, undoSnapshotId || action ? 9000 : 4500);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  bootstrap: async () => {
    try {
      const ws = await api.getWorkspace();
      const savedFmt = loadSavedPatchFormat();
      set({
        repoPath: ws.repoPath,
        repoName: ws.repoName,
        isGitRepo: ws.isGitRepo,
        gitBranch: ws.gitBranch,
        clipboardWatchEnabled: ws.clipboardWatchEnabled,
        clipboardAvailable: ws.clipboardAvailable,
        patchFormatPreference: savedFmt ?? ws.defaultPatchFormat ?? get().patchFormatPreference,
        recentRepos: ws.recentRepos,
      });
      await Promise.all([get().refreshTree(), get().refreshHistory()]);
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : 'Failed to connect to server.');
    }
  },

  refreshTree: async (silent = false) => {
    if (!silent) set({ isLoadingTree: true });
    try {
      const data = await api.getFileTree();
      const validPaths = new Set(collectLeafFiles(data.tree).map((f) => f.path));
      const currentSelected = get().selectedPaths;
      const source =
        currentSelected.size > 0 ? Array.from(currentSelected) : loadSavedSelection(get().repoPath);
      const kept = new Set(source.filter((p) => validPaths.has(p)));
      set({
        fileTree: data.tree,
        totalFiles: data.totalFiles,
        skippedSecretsCount: data.skippedSecretsCount,
        skippedBinaryCount: data.skippedBinaryCount,
        selectedPaths: kept,
        isLoadingTree: false,
      });
    } catch (err) {
      set({ isLoadingTree: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Could not scan project files.');
    }
  },

  refreshHistory: async () => {
    try {
      const { snapshots } = await api.getHistory();
      set({ snapshots });
    } catch {
      // non-fatal
    }
  },

  switchRepo: async (repoPath) => {
    try {
      await api.openWorkspace(repoPath);
      set({
        repoPickerOpen: false,
        selectedPaths: new Set(),
        activeParse: null,
        checkedApplyPaths: new Set(),
        appliedFilePaths: new Set(),
        appliedFileSnapshots: {},
        selectedPreviewFile: null,
        lastPackResult: null,
        activeStep: 1,
      });
      await get().bootstrap();
      get().pushToast('success', `Opened project: ${get().repoName}`);
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : 'Could not switch project.');
    }
  },

  toggleWatcher: async () => {
    const next = !get().clipboardWatchEnabled;
    try {
      const status = await api.toggleWatcher(next);
      set({ clipboardWatchEnabled: status.enabled, clipboardAvailable: status.available });
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : 'Could not toggle watcher.');
    }
  },

  setWatcherStatus: (enabled, available) =>
    set({ clipboardWatchEnabled: enabled, clipboardAvailable: available }),

  setSearchQuery: (q) => set({ searchQuery: q }),

  toggleNodeSelection: (node) => {
    const next = new Set(get().selectedPaths);
    if (node.type === 'file') {
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
    } else {
      const leaves = collectLeafFiles(node.children ?? []);
      const allSelected = leaves.length > 0 && leaves.every((f) => next.has(f.path));
      for (const leaf of leaves) {
        if (allSelected) next.delete(leaf.path);
        else next.add(leaf.path);
      }
    }
    set({ selectedPaths: next });
    saveSelection(get().repoPath, next);
  },

  selectAllFiles: () => {
    const all = collectLeafFiles(get().fileTree).map((f) => f.path);
    const next = new Set(all);
    set({ selectedPaths: next });
    saveSelection(get().repoPath, next);
  },

  clearSelection: () => {
    set({ selectedPaths: new Set() });
    saveSelection(get().repoPath, new Set());
  },

  setPreset: (preset) => set({ preset }),
  setTaskDescription: (taskDescription) => set({ taskDescription }),
  setErrorLog: (errorLog) => set({ errorLog }),
  setPatchFormat: (patchFormatPreference) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(PATCH_FORMAT_STORAGE_KEY, patchFormatPreference);
    }
    set({ patchFormatPreference });
  },
  setRedactSecrets: (redactSecrets) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(REDACT_SECRETS_STORAGE_KEY, String(redactSecrets));
    }
    set({ redactSecrets });
  },

  packContext: async (mode) => {
    const state = get();
    if (state.selectedPaths.size === 0) {
      state.pushToast('error', 'Pick at least one file in Step 1 first.');
      return null;
    }
    if (!state.taskDescription.trim()) {
      state.pushToast('error', 'Describe what you want the AI to do first.');
      return null;
    }

    set({ isPacking: true });
    try {
      const result = await api.packContext({
        selectedPaths: Array.from(state.selectedPaths),
        preset: state.preset,
        taskDescription: state.taskDescription,
        errorLog: state.errorLog,
        patchFormatPreference: state.patchFormatPreference,
        redactSecrets: state.redactSecrets,
        mode,
      });
      set({ lastPackResult: result, isPacking: false });
      return result;
    } catch (err) {
      set({ isPacking: false });
      state.pushToast('error', err instanceof Error ? err.message : 'Failed to prepare prompt.');
      return null;
    }
  },

  setRawPasteInput: (rawPasteInput) => set({ rawPasteInput }),

  receiveIncomingParse: (parse, fromClipboard) => {
    const readyPaths = parse.files.filter((f) => f.status === 'ready').map((f) => f.filePath);
    const firstFile = parse.files[0]?.filePath ?? null;
    const isOnStep3 = get().activeStep === 3;
    set({
      activeParse: parse,
      checkedApplyPaths: new Set(readyPaths),
      appliedFilePaths: new Set<string>(),
      appliedFileSnapshots: {},
      selectedPreviewFile: firstFile,
      hasUnreadPatch: fromClipboard && !isOnStep3,
    });
    if (fromClipboard) {
      get().pushToast(
        'info',
        `Detected AI changes for ${parse.summary.totalFiles} file(s).`,
        undefined,
        !isOnStep3 ? { label: 'Review Now', step: 3 } : undefined
      );
    }
  },

  parseManualPaste: async () => {
    const text = get().rawPasteInput.trim();
    if (!text) {
      get().pushToast('error', 'Paste the AI reply first.');
      return;
    }
    set({ isParsing: true });
    try {
      const result = await api.parsePatch(text);
      set({ isParsing: false });
      get().receiveIncomingParse(result, false);
    } catch (err) {
      set({ isParsing: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Could not parse AI reply.');
    }
  },

  toggleApplyFile: (filePath) => {
    const next = new Set(get().checkedApplyPaths);
    if (next.has(filePath)) next.delete(filePath);
    else next.add(filePath);
    set({ checkedApplyPaths: next });
  },

  setAllReadyApply: (checked) => {
    const parse = get().activeParse;
    if (!parse) return;
    if (!checked) {
      set({ checkedApplyPaths: new Set() });
      return;
    }
    const applied = get().appliedFilePaths;
    set({
      checkedApplyPaths: new Set(
        parse.files
          .filter((f) => f.status === 'ready' && !applied.has(f.filePath))
          .map((f) => f.filePath)
      ),
    });
  },

  setSelectedPreviewFile: (filePath) => set({ selectedPreviewFile: filePath }),

  clearActiveParse: () =>
    set({
      activeParse: null,
      checkedApplyPaths: new Set(),
      appliedFilePaths: new Set(),
      appliedFileSnapshots: {},
      selectedPreviewFile: null,
    }),

  applyCheckedFiles: async (customContents) => {
    const { activeParse, checkedApplyPaths, appliedFilePaths, appliedFileSnapshots } = get();
    const targetPaths = Array.from(checkedApplyPaths).filter((p) => !appliedFilePaths.has(p));
    if (!activeParse || targetPaths.length === 0) return;

    set({ isApplying: true });
    try {
      const res = await api.applyPatch(activeParse.parseId, targetPaths, customContents);
      const appliedSet = new Set(res.appliedFiles);
      const nextApplied = new Set(appliedFilePaths);
      const nextSnapshots = { ...appliedFileSnapshots };
      const nextChecked = new Set(checkedApplyPaths);

      const updatedFiles = activeParse.files.map((f) => {
        if (!appliedSet.has(f.filePath)) return f;
        nextChecked.delete(f.filePath);
        const override = customContents?.[f.filePath];
        if (override !== undefined && override !== f.proposedContent) {
          const stats = countDiffLines(override, f.proposedContent);
          return { ...f, originalContent: override, ...stats };
        }
        nextApplied.add(f.filePath);
        nextSnapshots[f.filePath] = res.snapshotId;
        return f;
      });

      set({
        isApplying: false,
        activeParse: { ...activeParse, files: updatedFiles },
        appliedFilePaths: nextApplied,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
      });
      await Promise.all([get().refreshTree(true), get().refreshHistory()]);
      get().pushToast(
        'success',
        `Applied changes to ${res.appliedFiles.length} file(s).`,
        res.snapshotId
      );
    } catch (err) {
      set({ isApplying: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Failed to apply changes.');
    }
  },

  applySingleFile: async (filePath, customContent) => {
    const { activeParse, appliedFilePaths } = get();
    if (!activeParse || appliedFilePaths.has(filePath)) return;
    const file = activeParse.files.find((f) => f.filePath === filePath);
    if (!file || file.status !== 'ready') return;

    if (customContent !== undefined && customContent !== file.proposedContent) {
      await get().applyPartialFileContent(filePath, customContent);
      return;
    }

    set({ isApplying: true });
    try {
      const res = await api.applyPatch(activeParse.parseId, [filePath]);
      const nextApplied = new Set(get().appliedFilePaths);
      nextApplied.add(filePath);
      const nextChecked = new Set(get().checkedApplyPaths);
      nextChecked.delete(filePath);
      const nextSnapshots = { ...get().appliedFileSnapshots, [filePath]: res.snapshotId };

      set({
        isApplying: false,
        appliedFilePaths: nextApplied,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
      });
      await Promise.all([get().refreshTree(true), get().refreshHistory()]);
      get().pushToast('success', `Applied ${filePath}.`, res.snapshotId);
    } catch (err) {
      set({ isApplying: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Failed to apply file.');
    }
  },

  applyPartialFileContent: async (filePath, mergedContent) => {
    const { activeParse } = get();
    if (!activeParse) return;
    const file = activeParse.files.find((f) => f.filePath === filePath);
    if (!file || file.status !== 'ready') return;

    set({ isApplying: true });
    try {
      const res = await api.applyPatch(activeParse.parseId, [filePath], {
        [filePath]: mergedContent,
      });
      const isFullyApplied = mergedContent === file.proposedContent;
      const stats = isFullyApplied
        ? { additions: 0, deletions: 0 }
        : countDiffLines(mergedContent, file.proposedContent);

      const nextApplied = new Set(get().appliedFilePaths);
      const nextChecked = new Set(get().checkedApplyPaths);
      const nextSnapshots = { ...get().appliedFileSnapshots };
      if (isFullyApplied) {
        nextApplied.add(filePath);
        nextChecked.delete(filePath);
        nextSnapshots[filePath] = res.snapshotId;
      }

      const updatedFiles = activeParse.files.map((f) =>
        f.filePath === filePath ? { ...f, originalContent: mergedContent, ...stats } : f
      );

      set({
        isApplying: false,
        activeParse: { ...activeParse, files: updatedFiles },
        appliedFilePaths: nextApplied,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
      });
      await Promise.all([get().refreshTree(true), get().refreshHistory()]);
      get().pushToast(
        'success',
        isFullyApplied ? `Applied all changes to ${filePath}.` : `Applied change block to ${filePath}.`,
        res.snapshotId
      );
    } catch (err) {
      set({ isApplying: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Failed to apply change.');
    }
  },

  undoSnapshotById: async (snapshotId) => {
    try {
      const res = await api.undoSnapshot(snapshotId);
      const touched = new Set([...res.restoredFiles, ...res.removedCreatedFiles]);
      const nextApplied = new Set(get().appliedFilePaths);
      const nextSnapshots = { ...get().appliedFileSnapshots };
      for (const p of touched) {
        nextApplied.delete(p);
        delete nextSnapshots[p];
      }
      set({ appliedFilePaths: nextApplied, appliedFileSnapshots: nextSnapshots });
      const count = touched.size;
      await Promise.all([get().refreshTree(true), get().refreshHistory()]);
      get().pushToast('success', `Restored ${count} file(s) to their previous state.`);
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : 'Could not undo snapshot.');
    }
  },
}));
