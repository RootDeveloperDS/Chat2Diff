import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FileClipboardResult {
  copied: boolean;
  error?: string;
}

export function getCacheDir(): string {
  const baseDir = process.env.CHAT2DIFF_CONFIG_DIR || path.join(os.homedir(), '.chat2diff');
  return path.join(baseDir, 'cache');
}

export function writeSingleCacheFile(fileName: string, content: string): string {
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const safeName =
    path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '-') || 'chat2diff-context.txt';
  const targetPath = path.join(cacheDir, safeName);

  // Keep storage strictly at 1 cached file by clearing previous context files
  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (entry !== safeName && entry.endsWith('.txt')) {
        try {
          fs.unlinkSync(path.join(cacheDir, entry));
        } catch {
          // ignore locked file
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }

  fs.writeFileSync(targetPath, content, 'utf8');
  return targetPath;
}

export function cleanupCacheDir(): void {
  const cacheDir = getCacheDir();
  try {
    if (!fs.existsSync(cacheDir)) return;
    for (const entry of fs.readdirSync(cacheDir)) {
      if (entry.endsWith('.txt')) {
        try {
          fs.unlinkSync(path.join(cacheDir, entry));
        } catch {
          // ignore locked file
        }
      }
    }
  } catch {
    // non-fatal on shutdown
  }
}

function runPipeCommand(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        }
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        done(false);
      }, 4500);

      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      child.stdin.on('error', () => done(false));
      child.stdin.end(input, 'utf8');
    } catch {
      resolve(false);
    }
  });
}

function extractShortError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err ?? 'Unknown error');
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return 'PowerShell timed out while accessing clipboard.';
  const raw = (e.stderr || e.message || 'Unknown clipboard error').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 180);
}

export async function copyFileToClipboard(filePath: string): Promise<FileClipboardResult> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { copied: false, error: 'Cached context file not found on disk.' };
  }

  if (process.platform === 'win32') {
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      '$p = $env:CHAT2DIFF_CLIP_PATH',
      'try {',
      '  Add-Type -AssemblyName System.Windows.Forms',
      '  $files = New-Object System.Collections.Specialized.StringCollection',
      '  [void]$files.Add($p)',
      '  $data = New-Object System.Windows.Forms.DataObject',
      '  $data.SetFileDropList($files)',
      '  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 120)',
      '} catch {',
      '  Set-Clipboard -LiteralPath $p',
      '}',
    ].join('\n');

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-EncodedCommand',
      encoded,
    ];
    const env = { ...process.env, CHAT2DIFF_CLIP_PATH: resolved };

    const sysPs = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const candidates = Array.from(
      new Set([
        ...(fs.existsSync(sysPs) ? [sysPs] : []),
        'powershell.exe',
        'pwsh',
      ])
    );

    let lastErr = '';
    for (const bin of candidates) {
      try {
        await execFileAsync(bin, psArgs, {
          env,
          timeout: 15_000,
          windowsHide: true,
        });
        return { copied: true };
      } catch (err) {
        lastErr = extractShortError(err);
      }
    }

    console.warn('[Chat2Diff] File clipboard failed:', lastErr);
    return {
      copied: false,
      error: `Could not copy file to Windows clipboard (${lastErr}). Use Copy Path or Save .txt.`,
    };
  }

  if (process.platform === 'darwin') {
    try {
      await execFileAsync(
        'osascript',
        [
          '-e',
          'on run argv',
          '-e',
          'set the clipboard to POSIX file (item 1 of argv)',
          '-e',
          'end run',
          '--',
          resolved,
        ],
        { timeout: 6000 }
      );
      return { copied: true };
    } catch (err) {
      return {
        copied: false,
        error: `Could not copy file to macOS clipboard (${extractShortError(err)}). Use Copy Path or Save .txt.`,
      };
    }
  }

  // Linux (Wayland wl-copy or X11 xclip using text/uri-list)
  const uriPayload = `${pathToFileURL(resolved).href}\r\n`;
  if (process.env.WAYLAND_DISPLAY) {
    if (await runPipeCommand('wl-copy', ['--type', 'text/uri-list'], uriPayload)) {
      return { copied: true };
    }
  }
  if (await runPipeCommand('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list'], uriPayload)) {
    return { copied: true };
  }
  if (await runPipeCommand('wl-copy', ['--type', 'text/uri-list'], uriPayload)) {
    return { copied: true };
  }

  return {
    copied: false,
    error: 'Install xclip or wl-clipboard for Ctrl+V file paste, or use Copy Path / Save .txt.',
  };
}