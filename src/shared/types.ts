export type WizardStep = 1 | 2 | 3;
export type TaskPreset = 'bug_fix' | 'add_feature' | 'improve_code' | 'review_code';
export type PatchFormat = 'search_replace' | 'unified_diff';
export type ExportMode = 'inline_copy' | 'file_attachment';
export type ModelFitLevel = 'great' | 'tight' | 'too_large';

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
stats: {
fileCount: number;
estimatedTokens: number;
redactedSecretsCount: number;
modelFit: ModelFitSummary;
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