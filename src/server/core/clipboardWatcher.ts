import clipboard from 'clipboardy';
import { hasDetectablePatch, sha256 } from './patchEngine.js';

function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastHash = '';
  private enabled: boolean;
  private available = true;
  private isPolling = false;
  private readonly ignoredHashes = new Set<string>();
  private readonly onPatchText: (rawText: string) => void;

  constructor(initialEnabled: boolean, onPatchText: (rawText: string) => void) {
    this.enabled = initialEnabled;
    this.onPatchText = onPatchText;
  }

  ignoreText(text: string): void {
    if (!text) return;
    const hash = sha256(normalizeClipboardText(text));
    this.ignoredHashes.add(hash);
    if (this.ignoredHashes.size > 30) {
      const oldest = this.ignoredHashes.values().next().value;
      if (oldest) this.ignoredHashes.delete(oldest);
    }
  }

  async start(): Promise<void> {
    try {
      const seed = (await clipboard.read()) ?? '';
      this.lastHash = sha256(normalizeClipboardText(seed));
      this.available = true;
    } catch {
      this.available = false;
      this.enabled = false;
      return;
    }

    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, 850);
  }

  private async pollOnce(): Promise<void> {
    if (!this.enabled || !this.available || this.isPolling) return;
    this.isPolling = true;
    try {
      const current = (await clipboard.read()) ?? '';
      const hash = sha256(normalizeClipboardText(current));
      if (hash === this.lastHash) return;
      this.lastHash = hash;

      if (this.ignoredHashes.has(hash)) return;

      if (hasDetectablePatch(current)) {
        this.onPatchText(current);
      }
    } catch {
      // Transient clipboard lock on Windows when another app writes; ignore
    } finally {
      this.isPolling = false;
    }
  }

  setEnabled(next: boolean): { enabled: boolean; available: boolean } {
    if (!this.available) {
      this.enabled = false;
      return { enabled: false, available: false };
    }
    this.enabled = next;
    return { enabled: this.enabled, available: this.available };
  }

  getStatus(): { enabled: boolean; available: boolean } {
    return { enabled: this.enabled, available: this.available };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
