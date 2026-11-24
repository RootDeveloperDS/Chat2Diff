import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApplyPatchResponse,
  SnapshotSummary,
  UndoSnapshotResponse,
} from '../../shared/types.js';
import { getStoredParseSession, sha256, type StoredFilePlan } from './patchEngine.js';
import { resolveSafeRepoPath } from './pathGuard.js';

interface ManifestFileEntry {
  filePath: string;
  action: 'modify' | 'create' | 'delete';
  existedBefore: boolean;
  backupBlobName: string | null;
}

interface SnapshotManifest {
  snapshotId: string;
  appliedAt: string;
  reverted: boolean;
  revertedAt: string | null;
  files: ManifestFileEntry[];
}

function getSnapshotsRoot(repoPath: string): string {
  const gitDir = path.join(repoPath, '.git');
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    return path.join(gitDir, 'chat2diff', 'snapshots');
  }
  return path.join(repoPath, '.chat2diff', 'snapshots');
}

function formatSummary(files: ManifestFileEntry[]): string {
  const mod = files.filter((f) => f.action === 'modify').length;
  const cre = files.filter((f) => f.action === 'create').length;
  const del = files.filter((f) => f.action === 'delete').length;
  const parts: string[] = [];
  if (mod > 0) parts.push(`Updated ${mod} file${mod > 1 ? 's' : ''}`);
  if (cre > 0) parts.push(`Created ${cre} file${cre > 1 ? 's' : ''}`);
  if (del > 0) parts.push(`Deleted ${del} file${del > 1 ? 's' : ''}`);
  return parts.join(', ') || 'No files changed';
}

export function applySelectedFiles(
  repoPath: string,
  parseId: string,
  selectedFilePaths: string[],
  customContents?: Record<string, string>
): ApplyPatchResponse {
  const session = getStoredParseSession(parseId);
  if (!session || path.resolve(session.repoPath) !== path.resolve(repoPath)) {
    throw new Error('EXPIRED_PARSE_ID: Preview expired or belongs to another project. Please re-preview.');
  }

  const plansToApply = selectedFilePaths
    .map((p) => session.plans.get(p))
    .filter((p): p is StoredFilePlan => Boolean(p && p.status === 'ready'));

  if (plansToApply.length === 0) {
    throw new Error('NO_FILES_SELECTED: Select at least one ready file to apply.');
  }

  // Conflict check: make sure files didn't change externally since preview
  for (const plan of plansToApply) {
    const absPath = resolveSafeRepoPath(repoPath, plan.filePath);
    const existsNow = fs.existsSync(absPath);
    if (plan.existedBefore && !existsNow) {
      throw new Error(`FILE_CHANGED_ON_DISK: "${plan.filePath}" was removed after preview.`);
    }
    if (existsNow && plan.expectedDiskSha256) {
      const currentHash = sha256(fs.readFileSync(absPath, 'utf8'));
      if (currentHash !== plan.expectedDiskSha256) {
        throw new Error(`FILE_CHANGED_ON_DISK: "${plan.filePath}" changed on disk after preview. Re-preview first.`);
      }
    }
  }

  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const snapshotId = `snap_${ts}_${crypto.randomBytes(3).toString('hex')}`;
  const snapshotDir = path.join(getSnapshotsRoot(repoPath), snapshotId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const manifestFiles: ManifestFileEntry[] = [];
  const appliedFiles: string[] = [];

  for (let idx = 0; idx < plansToApply.length; idx++) {
    const plan = plansToApply[idx];
    const absPath = resolveSafeRepoPath(repoPath, plan.filePath);
    const existedBefore = plan.existedBefore;
    let backupBlobName: string | null = null;

    // 1. Save exact pre-apply bytes
    if (existedBefore && fs.existsSync(absPath)) {
      backupBlobName = `${String(idx).padStart(3, '0')}_${path.basename(plan.filePath)}.bak`;
      fs.copyFileSync(absPath, path.join(snapshotDir, backupBlobName));
    }

    // 2. Write change to disk
    if (plan.action === 'delete') {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
      plan.expectedDiskSha256 = null;
      plan.existedBefore = false;
    } else {
      const overrideLf = customContents?.[plan.filePath];
      const contentToWrite =
        overrideLf !== undefined
          ? plan.hadCrlf
            ? overrideLf.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
            : overrideLf.replace(/\r\n/g, '\n')
          : plan.proposedContent;
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, contentToWrite, 'utf8');
      plan.expectedDiskSha256 = sha256(contentToWrite);
      plan.existedBefore = true;
    }

    manifestFiles.push({
      filePath: plan.filePath,
      action: plan.action,
      existedBefore,
      backupBlobName,
    });
    appliedFiles.push(plan.filePath);
  }

  const appliedAt = new Date().toISOString();
  const manifest: SnapshotManifest = {
    snapshotId,
    appliedAt,
    reverted: false,
    revertedAt: null,
    files: manifestFiles,
  };

  fs.writeFileSync(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  return { snapshotId, appliedFiles, appliedAt };
}

export function listSnapshots(repoPath: string): SnapshotSummary[] {
  const root = getSnapshotsRoot(repoPath);
  if (!fs.existsSync(root)) return [];

  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const snapshots: SnapshotSummary[] = [];

  for (const d of dirs) {
    const manifestPath = path.join(root, d.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      snapshots.push({
        snapshotId: m.snapshotId,
        appliedAt: m.appliedAt,
        summary: formatSummary(m.files),
        files: m.files.map((f) => ({ filePath: f.filePath, action: f.action })),
        reverted: m.reverted,
      });
    } catch {
      // skip corrupt manifest
    }
  }

  snapshots.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  return snapshots.slice(0, 40);
}

export function undoSnapshot(repoPath: string, snapshotId: string): UndoSnapshotResponse {
  if (!/^snap_[a-zA-Z0-9_]+$/.test(snapshotId)) {
    throw new Error('NOT_FOUND: Invalid snapshot ID.');
  }

  const snapshotDir = path.join(getSnapshotsRoot(repoPath), snapshotId);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('NOT_FOUND: Snapshot does not exist.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  if (manifest.reverted) {
    throw new Error('ALREADY_REVERTED: This change has already been undone.');
  }

  const restoredFiles: string[] = [];
  const removedCreatedFiles: string[] = [];

  for (const entry of manifest.files) {
    const absPath = resolveSafeRepoPath(repoPath, entry.filePath);
    if (entry.existedBefore && entry.backupBlobName) {
      const backupPath = path.join(snapshotDir, entry.backupBlobName);
      if (fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.copyFileSync(backupPath, absPath);
        restoredFiles.push(entry.filePath);
      }
    } else if (!entry.existedBefore) {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        removedCreatedFiles.push(entry.filePath);
      }
    }
  }

  manifest.reverted = true;
  manifest.revertedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return { snapshotId, restoredFiles, removedCreatedFiles };
}
