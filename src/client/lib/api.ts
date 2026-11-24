import { DEV_SESSION_TOKEN } from '../../shared/constants.js';
import type {
  ApplyPatchResponse,
  DirectoryListResponse,
  FileTreeResponse,
  PackRequest,
  PackResponse,
  ParsePatchResponse,
  SnapshotSummary,
  UndoSnapshotResponse,
  WorkspaceInfo,
  WsEvent,
} from '../../shared/types.js';

const TOKEN_STORAGE_KEY = 'chat2diff_session_token';

function initSessionToken(): string {
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = decodeURIComponent(hash.slice('#token='.length));
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
    return token;
  }
  const saved = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (saved) return saved;
  return import.meta.env.DEV ? DEV_SESSION_TOKEN : '';
}

const sessionToken = initSessionToken();

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Chat2Diff-Token': sessionToken,
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!res.ok || json.data === undefined) {
    throw new Error(json.message || `Request failed (${res.status})`);
  }
  return json.data;
}

export const api = {
  getWorkspace: () => request<WorkspaceInfo>('/api/v1/workspace'),
  listDirectories: (dir?: string) =>
    request<DirectoryListResponse>(
      `/api/v1/filesystem/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`
    ),
  openWorkspace: (repoPath: string) =>
    request<{ repoPath: string; repoName: string; isGitRepo: boolean; gitBranch: string | null }>(
      '/api/v1/workspace/open',
      { method: 'POST', body: JSON.stringify({ repoPath }) }
    ),
  getFileTree: () => request<FileTreeResponse>('/api/v1/files/tree'),
  packContext: (body: PackRequest) =>
    request<PackResponse>('/api/v1/pack', { method: 'POST', body: JSON.stringify(body) }),
  parsePatch: (rawText: string) =>
    request<ParsePatchResponse>('/api/v1/patch/parse', {
      method: 'POST',
      body: JSON.stringify({ rawText }),
    }),
  applyPatch: (
    parseId: string,
    selectedFilePaths: string[],
    customContents?: Record<string, string>
  ) =>
    request<ApplyPatchResponse>('/api/v1/patch/apply', {
      method: 'POST',
      body: JSON.stringify({ parseId, selectedFilePaths, customContents }),
    }),
  getHistory: () => request<{ snapshots: SnapshotSummary[] }>('/api/v1/history'),
  undoSnapshot: (snapshotId: string) =>
    request<UndoSnapshotResponse>(`/api/v1/history/${encodeURIComponent(snapshotId)}/undo`, {
      method: 'POST',
    }),
  toggleWatcher: (enabled: boolean) =>
    request<{ enabled: boolean; available: boolean }>('/api/v1/watcher/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
};

export function connectPatchSocket(
  onEvent: (event: WsEvent) => void,
  onStatus: (connected: boolean) => void
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 1000;
  let timer: number | null = null;

  const connect = (): void => {
    if (closed) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(sessionToken)}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      retryMs = 1000;
      onStatus(true);
    };
    ws.onmessage = (evt) => {
      try {
        onEvent(JSON.parse(String(evt.data)) as WsEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) {
        timer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 1.5, 6000);
      }
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  connect();
  return () => {
    closed = true;
    if (timer) window.clearTimeout(timer);
    ws?.close();
  };
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
