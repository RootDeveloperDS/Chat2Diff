import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PatchFormat, RecentRepo } from '../../shared/types.js';

export interface UserConfig {
  version: number;
  defaultPatchFormat: PatchFormat;
  clipboardWatchEnabled: boolean;
  recentRepos: RecentRepo[];
}

const DEFAULT_CONFIG: UserConfig = {
  version: 1,
  defaultPatchFormat: 'search_replace',
  clipboardWatchEnabled: true,
  recentRepos: [],
};

function getConfigPath(): string {
  const baseDir = process.env.CHAT2DIFF_CONFIG_DIR || path.join(os.homedir(), '.chat2diff');
  return path.join(baseDir, 'config.json');
}

export function loadConfig(): UserConfig {
  const filePath = getConfigPath();
  try {
    if (!fs.existsSync(filePath)) return { ...DEFAULT_CONFIG, recentRepos: [] };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<UserConfig>;
    return {
      version: 1,
      defaultPatchFormat: parsed.defaultPatchFormat === 'unified_diff' ? 'unified_diff' : 'search_replace',
      clipboardWatchEnabled: parsed.clipboardWatchEnabled ?? true,
      recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos.slice(0, 12) : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG, recentRepos: [] };
  }
}

export function saveConfig(config: UserConfig): void {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Non-fatal if home directory is read-only
  }
}

export function recordRecentRepo(repoPath: string): UserConfig {
  const config = loadConfig();
  const resolved = path.resolve(repoPath);
  const name = path.basename(resolved);
  const filtered = config.recentRepos.filter(
    (item) => item.path.toLowerCase() !== resolved.toLowerCase()
  );
  config.recentRepos = [
    { path: resolved, name, lastOpenedAt: new Date().toISOString() },
    ...filtered,
  ].slice(0, 10);
  saveConfig(config);
  return config;
}
