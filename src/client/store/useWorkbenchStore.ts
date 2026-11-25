import { create } from 'zustand';
import { diffLines } from 'diff';
import type {
  ChatMode,
  FileBundleStyle,
  FileTreeNode,
  FollowUpAttachMode,
  PackResponse,
  ParsePatchResponse,
  PatchFormat,
  RecentRepo,
  SnapshotSummary,
  TaskPreset,
  TurnSyncStatus,
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
const AUTO_JUMP_STORAGE_KEY = 'chat2diff_auto_jump_review';
const FILE_BUNDLE_STYLE_STORAGE_KEY = 'chat2diff_file_bundle_style';

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

function loadSavedAutoJump(): boolean {
  if (typeof window === 'undefined') return true;
  const val = localStorage.getItem(AUTO_JUMP_STORAGE_KEY);
  return val === null ? true : val === 'true';
}

function loadSavedFileBundleStyle(): FileBundleStyle {
  if (typeof window === 'undefined') return 'all_in_one';
  const val = localStorage.getItem(FILE_BUNDLE_STYLE_STORAGE_KEY);
  return val === 'separate_prompt' ? 'separate_prompt' : 'all_in_one';
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

function buildTurnSyncFromState(
  parse: ParsePatchResponse | null,
  appliedSet: Set<string>,
  partialSet: Set<string>,
  undoneSet: Set<string>
): TurnSyncStatus | null {
  if (!parse && appliedSet.size === 0 && partialSet.size === 0 && undoneSet.size === 0) {
    return null;
  }
  const appliedFiles = Array.from(appliedSet);
  const partiallyAppliedFiles = Array.from(partialSet).filter((p) => !appliedSet.has(p));
  const undoneFiles = Array.from(undoneSet).filter(
    (p) => !appliedSet.has(p) && !partialSet.has(p)
  );
  const notAppliedFiles = parse
    ? parse.files
        .filter(
          (f) =>
            f.status === 'ready' &&
            !appliedSet.has(f.filePath) &&
            !partialSet.has(f.filePath) &&
            !undoneSet.has(f.filePath)
        )
        .map((f) => f.filePath)
    : [];
  const failedFiles = parse
    ? parse.files
        .filter((f) => f.status === 'failed' || f.status === 'blocked')
        .map((f) => ({
          filePath: f.filePath,
          reason: f.errorReason ?? 'Could not apply cleanly',
        }))
    : [];
  return { appliedFiles, partiallyAppliedFiles, notAppliedFiles, failedFiles, undoneFiles };
}

interface WorkbenchStore {
  // Navigation & Drawers
  activeStep: WizardStep;
  repoPickerOpen: boolean;
  historyDrawerOpen: boolean;
  darkMode: boolean;
  autoJumpToReview: boolean;
  filePanelCollapsed: boolean;
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

  // Prepare: File Picker
  fileTree: FileTreeNode[];
  totalFiles: number;
  skippedSecretsCount: number;
  skippedBinaryCount: number;
  changedPaths: string[];
  selectedPaths: Set<string>;
  searchQuery: string;
  isLoadingTree: boolean;

  // Prepare: Task & Chat Sync
  chatMode: ChatMode;
  followUpAttachMode: FollowUpAttachMode;
  includeSelectedInFollowUp: boolean;
  turnSync: TurnSyncStatus | null;
  preset: TaskPreset;
  taskDescription: string;
  errorLog: string;
  patchFormatPreference: PatchFormat;
  fileBundleStyle: FileBundleStyle;
  redactSecrets: boolean;
  lastPackResult: PackResponse | null;
  isPacking: boolean;

  // Review & Apply
  rawPasteInput: string;
  activeParse: ParsePatchResponse | null;
  checkedApplyPaths: Set<string>;
  appliedFilePaths: Set<string>;
  partiallyAppliedFilePaths: Set<string>;
  undoneFilePaths: Set<string>;
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
  toggleAutoJumpToReview: () => void;
  setFilePanelCollapsed: (collapsed: boolean) => void;
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
  selectChangedFiles: () => void;
  removePathsFromSelection: (paths: string[]) => void;
  clearSelection: () => void;

  setChatMode: (mode: ChatMode) => void;
  setFollowUpAttachMode: (mode: FollowUpAttachMode) => void;
  setIncludeSelectedInFollowUp: (val: boolean) => void;
  startNewChat: () => void;
  startFollowUpFromReview: () => void;
  clearTurnSync: () => void;
  setPreset: (preset: TaskPreset) => void;
  setTaskDescription: (val: string) => void;
  setErrorLog: (val: string) => void;
  setPatchFormat: (fmt: PatchFormat) => void;
  setFileBundleStyle: (style: FileBundleStyle) => void;
  setRedactSecrets: (val: boolean) => void;
  packContext: (
    mode: 'inline_copy' | 'file_attachment',
    options?: { copyFileToClipboard?: boolean; fileBundleStyle?: FileBundleStyle }
  ) => Promise<PackResponse | null>;

  setRawPasteInput: (val: string) => void;
  receiveIncomingParse: (parse: ParsePatchResponse, fromClipboard: boolean) => void;
  parseManualPaste: () => Promise<void>;
  parseRawText: (text: string) => Promise<void>;
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
  activeStep: 'prepare',
  repoPickerOpen: false,
  historyDrawerOpen: false,
  darkMode: initialDark,
  autoJumpToReview: loadSavedAutoJump(),
  filePanelCollapsed: false,
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
  changedPaths: [],
  selectedPaths: new Set<string>(),
  searchQuery: '',
  isLoadingTree: false,

  chatMode: 'new_chat',
  followUpAttachMode: 'smart',
  includeSelectedInFollowUp: false,
  turnSync: null,
  preset: 'bug_fix',
  taskDescription: '',
  errorLog: '',
  patchFormatPreference: loadSavedPatchFormat() ?? 'search_replace',
  fileBundleStyle: loadSavedFileBundleStyle(),
  redactSecrets: loadSavedRedactSecrets(),
  lastPackResult: null,
  isPacking: false,

  rawPasteInput: '',
  activeParse: null,
  checkedApplyPaths: new Set<string>(),
  appliedFilePaths: new Set<string>(),
  partiallyAppliedFilePaths: new Set<string>(),
  undoneFilePaths: new Set<string>(),
  appliedFileSnapshots: {},
  selectedPreviewFile: null,
  hasUnreadPatch: false,
  isParsing: false,
  isApplying: false,

  snapshots: [],

  setStep: (step) =>
    set((s) => ({
      activeStep: step,
      hasUnreadPatch: step === 'review' ? false : s.hasUnreadPatch,
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

  toggleAutoJumpToReview: () =>
    set((s) => {
      const next = !s.autoJumpToReview;
      if (typeof window !== 'undefined') {
        localStorage.setItem(AUTO_JUMP_STORAGE_KEY, String(next));
      }
      return { autoJumpToReview: next };
    }),

  setFilePanelCollapsed: (filePanelCollapsed) => set({ filePanelCollapsed }),

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
        changedPaths: data.changedPaths ?? [],
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
        partiallyAppliedFilePaths: new Set(),
        undoneFilePaths: new Set(),
        appliedFileSnapshots: {},
        selectedPreviewFile: null,
        lastPackResult: null,
        chatMode: 'new_chat',
        turnSync: null,
        activeStep: 'prepare',
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

  selectChangedFiles: () => {
    const changed = get().changedPaths;
    if (changed.length === 0) {
      get().pushToast('info', 'No uncommitted Git changes found.');
      return;
    }
    const next = new Set(changed);
    set({ selectedPaths: next });
    saveSelection(get().repoPath, next);
    get().pushToast('info', `Selected ${changed.length} changed file(s).`);
  },

  removePathsFromSelection: (paths) => {
    const next = new Set(get().selectedPaths);
    for (const p of paths) next.delete(p);
    set({ selectedPaths: next });
    saveSelection(get().repoPath, next);
  },

  clearSelection: () => {
    set({ selectedPaths: new Set() });
    saveSelection(get().repoPath, new Set());
  },

  setChatMode: (chatMode) => set({ chatMode }),
  setFollowUpAttachMode: (followUpAttachMode) =>
    set({
      followUpAttachMode,
      includeSelectedInFollowUp: followUpAttachMode === 'all',
    }),
  setIncludeSelectedInFollowUp: (includeSelectedInFollowUp) =>
    set({
      includeSelectedInFollowUp,
      followUpAttachMode: includeSelectedInFollowUp ? 'all' : 'smart',
    }),

  startNewChat: () =>
    set({
      chatMode: 'new_chat',
      followUpAttachMode: 'smart',
      turnSync: null,
      includeSelectedInFollowUp: false,
      lastPackResult: null,
    }),

  startFollowUpFromReview: () => {
    const s = get();
    const sync = buildTurnSyncFromState(
      s.activeParse,
      s.appliedFilePaths,
      s.partiallyAppliedFilePaths,
      s.undoneFilePaths
    );
    set({
      activeStep: 'prepare',
      chatMode: 'follow_up',
      followUpAttachMode: 'smart',
      includeSelectedInFollowUp: false,
      turnSync: sync,
      taskDescription: '',
      errorLog: '',
      lastPackResult: null,
    });
  },

  clearTurnSync: () => set({ turnSync: null }),

  setPreset: (preset) => set({ preset }),
  setTaskDescription: (taskDescription) => set({ taskDescription }),
  setErrorLog: (errorLog) => set({ errorLog }),
  setPatchFormat: (patchFormatPreference) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(PATCH_FORMAT_STORAGE_KEY, patchFormatPreference);
    }
    set({ patchFormatPreference });
  },
  setFileBundleStyle: (fileBundleStyle) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(FILE_BUNDLE_STYLE_STORAGE_KEY, fileBundleStyle);
    }
    set({ fileBundleStyle });
  },
  setRedactSecrets: (redactSecrets) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(REDACT_SECRETS_STORAGE_KEY, String(redactSecrets));
    }
    set({ redactSecrets });
  },

  packContext: async (mode, options) => {
    const state = get();
    if (state.chatMode === 'new_chat' && state.selectedPaths.size === 0) {
      state.pushToast('error', 'Pick at least one file on the left first.');
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
        chatMode: state.chatMode,
        turnSync: state.chatMode === 'follow_up' ? state.turnSync : null,
        includeSelectedInFollowUp: state.includeSelectedInFollowUp,
        followUpAttachMode:
          state.chatMode === 'follow_up' ? state.followUpAttachMode : undefined,
        fileBundleStyle: options?.fileBundleStyle ?? state.fileBundleStyle,
        copyFileToClipboard: options?.copyFileToClipboard,
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
    const { activeStep, autoJumpToReview } = get();
    const isOnReview = activeStep === 'review';
    const shouldJump = fromClipboard && autoJumpToReview && !isOnReview;
    const initialSync = buildTurnSyncFromState(parse, new Set(), new Set(), new Set());

    set({
      activeParse: parse,
      checkedApplyPaths: new Set(readyPaths),
      appliedFilePaths: new Set<string>(),
      partiallyAppliedFilePaths: new Set<string>(),
      undoneFilePaths: new Set<string>(),
      appliedFileSnapshots: {},
      selectedPreviewFile: firstFile,
      turnSync: initialSync,
      activeStep: shouldJump ? 'review' : activeStep,
      hasUnreadPatch: fromClipboard && !isOnReview && !shouldJump,
    });
    if (fromClipboard) {
      get().pushToast(
        'info',
        shouldJump
          ? `Loaded AI changes for ${parse.summary.totalFiles} file(s) from clipboard.`
          : `Detected AI changes for ${parse.summary.totalFiles} file(s).`,
        undefined,
        !isOnReview && !shouldJump ? { label: 'Review Now', step: 'review' } : undefined
      );
    }
  },

  parseRawText: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) {
      get().pushToast('error', 'Paste the AI reply first.');
      return;
    }
    set({ isParsing: true });
    try {
      const result = await api.parsePatch(trimmed);
      set({ isParsing: false, activeStep: 'review', rawPasteInput: trimmed });
      get().receiveIncomingParse(result, false);
    } catch (err) {
      set({ isParsing: false });
      get().pushToast('error', err instanceof Error ? err.message : 'Could not parse AI reply.');
    }
  },

  parseManualPaste: async () => {
    await get().parseRawText(get().rawPasteInput);
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
      partiallyAppliedFilePaths: new Set(),
      undoneFilePaths: new Set(),
      appliedFileSnapshots: {},
      selectedPreviewFile: null,
    }),

  applyCheckedFiles: async (customContents) => {
    const {
      activeParse,
      checkedApplyPaths,
      appliedFilePaths,
      partiallyAppliedFilePaths,
      undoneFilePaths,
      appliedFileSnapshots,
    } = get();
    const targetPaths = Array.from(checkedApplyPaths).filter((p) => !appliedFilePaths.has(p));
    if (!activeParse || targetPaths.length === 0) return;

    set({ isApplying: true });
    try {
      const res = await api.applyPatch(activeParse.parseId, targetPaths, customContents);
      const appliedSet = new Set(res.appliedFiles);
      const nextApplied = new Set(appliedFilePaths);
      const nextPartial = new Set(partiallyAppliedFilePaths);
      const nextUndone = new Set(undoneFilePaths);
      const nextSnapshots = { ...appliedFileSnapshots };
      const nextChecked = new Set(checkedApplyPaths);

      const updatedFiles = activeParse.files.map((f) => {
        if (!appliedSet.has(f.filePath)) return f;
        nextChecked.delete(f.filePath);
        nextUndone.delete(f.filePath);
        const override = customContents?.[f.filePath];
        if (override !== undefined && override !== f.proposedContent) {
          nextPartial.add(f.filePath);
          const stats = countDiffLines(override, f.proposedContent);
          return { ...f, originalContent: override, ...stats };
        }
        nextApplied.add(f.filePath);
        nextPartial.delete(f.filePath);
        nextSnapshots[f.filePath] = res.snapshotId;
        return f;
      });

      const nextParse = { ...activeParse, files: updatedFiles };
      set({
        isApplying: false,
        activeParse: nextParse,
        appliedFilePaths: nextApplied,
        partiallyAppliedFilePaths: nextPartial,
        undoneFilePaths: nextUndone,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
        turnSync: buildTurnSyncFromState(nextParse, nextApplied, nextPartial, nextUndone),
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
      const nextPartial = new Set(get().partiallyAppliedFilePaths);
      nextPartial.delete(filePath);
      const nextUndone = new Set(get().undoneFilePaths);
      nextUndone.delete(filePath);
      const nextChecked = new Set(get().checkedApplyPaths);
      nextChecked.delete(filePath);
      const nextSnapshots = { ...get().appliedFileSnapshots, [filePath]: res.snapshotId };

      set({
        isApplying: false,
        appliedFilePaths: nextApplied,
        partiallyAppliedFilePaths: nextPartial,
        undoneFilePaths: nextUndone,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
        turnSync: buildTurnSyncFromState(activeParse, nextApplied, nextPartial, nextUndone),
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
      const nextPartial = new Set(get().partiallyAppliedFilePaths);
      const nextUndone = new Set(get().undoneFilePaths);
      const nextChecked = new Set(get().checkedApplyPaths);
      const nextSnapshots = { ...get().appliedFileSnapshots };
      nextUndone.delete(filePath);
      if (isFullyApplied) {
        nextApplied.add(filePath);
        nextPartial.delete(filePath);
        nextChecked.delete(filePath);
        nextSnapshots[filePath] = res.snapshotId;
      } else {
        nextPartial.add(filePath);
      }

      const updatedFiles = activeParse.files.map((f) =>
        f.filePath === filePath ? { ...f, originalContent: mergedContent, ...stats } : f
      );
      const nextParse = { ...activeParse, files: updatedFiles };

      set({
        isApplying: false,
        activeParse: nextParse,
        appliedFilePaths: nextApplied,
        partiallyAppliedFilePaths: nextPartial,
        undoneFilePaths: nextUndone,
        appliedFileSnapshots: nextSnapshots,
        checkedApplyPaths: nextChecked,
        turnSync: buildTurnSyncFromState(nextParse, nextApplied, nextPartial, nextUndone),
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
      const nextPartial = new Set(get().partiallyAppliedFilePaths);
      const nextUndone = new Set(get().undoneFilePaths);
      const nextSnapshots = { ...get().appliedFileSnapshots };
      for (const p of touched) {
        nextApplied.delete(p);
        nextPartial.delete(p);
        nextUndone.add(p);
        delete nextSnapshots[p];
      }
      set({
        appliedFilePaths: nextApplied,
        partiallyAppliedFilePaths: nextPartial,
        undoneFilePaths: nextUndone,
        appliedFileSnapshots: nextSnapshots,
        turnSync: buildTurnSyncFromState(get().activeParse, nextApplied, nextPartial, nextUndone),
      });
      const count = touched.size;
      await Promise.all([get().refreshTree(true), get().refreshHistory()]);
      get().pushToast('success', `Restored ${count} file(s) to their previous state.`);
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : 'Could not undo snapshot.');
    }
  },
}));
