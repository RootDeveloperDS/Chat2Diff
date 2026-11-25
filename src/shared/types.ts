export type WizardStep = 'prepare' | 'review';
export type ChatMode = 'new_chat' | 'follow_up';
export type FollowUpAttachMode = 'smart' | 'all' | 'none';
export type TaskPreset = 'bug_fix' | 'add_feature' | 'improve_code' | 'review_code';
export type PatchFormat = 'search_replace' | 'unified_diff';
export type ExportMode = 'inline_copy' | 'file_attachment';
export type FileBundleStyle = 'all_in_one' | 'separate_prompt';
export type ModelFitLevel = 'great' | 'tight' | 'too_large';

export interface TurnSyncStatus {
appliedFiles: string[];
partiallyAppliedFiles: string[];
notAppliedFiles: string[];
failedFiles: Array<{ filePath: string; reason: string }>;
undoneFiles: string[];
}

export interface RecentRepo {
path: string;
name: string;
lastOpenedAt: string;
}

export interface WorkspaceInfo {
repoPath: string;
repoName: string;
isGitRepo: boolean;
gitBranch: string | null;
clipboardWatchEnabled: boolean;
clipboardAvailable: boolean;
defaultPatchFormat?: PatchFormat;
recentRepos: RecentRepo[];
}


export interface DirectoryEntry {
name: string;
path: string;
isGitRepo: boolean;
}

export interface DirectoryListResponse {
currentPath: string;
parentPath: string | null;
entries: DirectoryEntry[];
}

export interface FileTreeNode {
path: string;
name: string;
type: 'file' | 'directory';
sizeBytes?: number;
estimatedTokens: number;
fileCount: number;
children?: FileTreeNode[];
}

export interface FileTreeResponse {
rootName: string;
totalFiles: number;
skippedSecretsCount: number;
skippedBinaryCount: number;
changedPaths: string[];
tree: FileTreeNode[];
}

export interface PackRequest {
selectedPaths: string[];
preset: TaskPreset;
taskDescription: string;
errorLog?: string;
patchFormatPreference: PatchFormat;
redactSecrets: boolean;
mode: ExportMode;
chatMode?: ChatMode;
turnSync?: TurnSyncStatus | null;
includeSelectedInFollowUp?: boolean;
followUpAttachMode?: FollowUpAttachMode;
fileBundleStyle?: FileBundleStyle;
copyFileToClipboard?: boolean;
}

export interface ModelFitSummary {
chatgpt: ModelFitLevel;
claude: ModelFitLevel;
gemini: ModelFitLevel;
}

export interface PackWarning {
filePath: string;
reason: string;
}

export interface PackResponse {
promptText: string;
contextFileContent: string | null;
contextFileName: string;
cachedFilePath?: string | null;
fileCopiedToClipboard?: boolean;
fileClipboardError?: string | null;
fileBundleStyle?: FileBundleStyle;
stats: {
fileCount: number;
estimatedTokens: number;
redactedSecretsCount: number;
modelFit: ModelFitSummary;
chatMode: ChatMode;
attachedFiles: string[];
};
warnings: PackWarning[];
}

export interface ParsedFileDiff {
filePath: string;
action: 'modify' | 'create' | 'delete';
status: 'ready' | 'failed' | 'blocked';
repairNote: string | null;
securityWarning: string | null;
errorReason: string | null;
originalContent: string;
proposedContent: string;
additions: number;
deletions: number;
}

export interface ParsePatchResponse {
parseId: string;
detectedFormat: 'search_replace' | 'unified_diff' | 'mixed';
summary: {
totalFiles: number;
readyCount: number;
failedCount: number;
blockedCount: number;
};
files: ParsedFileDiff[];
retryPrompt: string | null;
}

export interface ApplyPatchResponse {
snapshotId: string;
appliedFiles: string[];
appliedAt: string;
}

export interface SnapshotFileEntry {
filePath: string;
action: 'modify' | 'create' | 'delete';
}

export interface SnapshotSummary {
snapshotId: string;
appliedAt: string;
summary: string;
files: SnapshotFileEntry[];
reverted: boolean;
}

export interface UndoSnapshotResponse {
snapshotId: string;
restoredFiles: string[];
removedCreatedFiles: string[];
}

export type WsEvent =
| { type: 'PATCH_DETECTED'; payload: { parseResult: ParsePatchResponse } }
| { type: 'WATCHER_STATUS'; payload: { enabled: boolean; available: boolean } };