import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import open from 'open';
import { WebSocket, WebSocketServer } from 'ws';
import { APP_VERSION, DEFAULT_PORT, DEV_SESSION_TOKEN } from '../shared/constants.js';
import type { WsEvent } from '../shared/types.js';
import { createApp, isValidLocalHost, type ServerState, verifySessionToken } from './app.js';
import { ClipboardWatcher } from './core/clipboardWatcher.js';
import { loadConfig, recordRecentRepo } from './core/configStore.js';
import { cleanupCacheDir } from './core/fileClipboard.js';
import { parseAndPreviewPatch } from './core/patchEngine.js';

function getAppVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkgPath = path.resolve(currentDir, rel);
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === 'chat2diff' && pkg.version) {
          return pkg.version;
        }
      }
    } catch {
      // try next path
    }
  }
  return APP_VERSION;
}

function printHelp(version: string): void {
  console.log(`
Chat2Diff v${version} — Use any AI chatbot safely on your local codebase.

Usage:
  npx chat2diff [directory] [options]

Arguments:
  directory          Target project folder (default: current working directory)

Options:
  -p, --port <num>   Localhost port to bind (default: ${DEFAULT_PORT}, auto-increments if busy)
  --no-open          Start server without auto-opening your browser
  --no-watch         Start with automatic clipboard listener paused
  -v, --version      Print Chat2Diff version
  -h, --help         Show this help message

Examples:
  npx chat2diff
  npx chat2diff ./my-project
  npx chat2diff --port 4500 --no-open
`);
}

function parseCliArgs(argv: string[]): {
  targetDir: string;
  port: number;
  noOpen: boolean;
  noWatch: boolean;
  devMode: boolean;
  showHelp: boolean;
  showVersion: boolean;
} {
  let targetDir = process.cwd();
  let port = Number(process.env.CHAT2DIFF_PORT) || DEFAULT_PORT;
  let noOpen = process.env.CHAT2DIFF_NO_OPEN === '1';
  let noWatch = false;
  let devMode = false;
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') showHelp = true;
    else if (arg === '-v' || arg === '--version') showVersion = true;
    else if (arg === '--no-open') noOpen = true;
    else if (arg === '--no-watch') noWatch = true;
    else if (arg === '--dev') devMode = true;
    else if ((arg === '-p' || arg === '--port') && argv[i + 1]) {
      const parsedPort = Number(argv[++i]);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        console.error(`Error: Invalid port number. Use a value between 1 and 65535.`);
        process.exit(1);
      }
      port = parsedPort;
    } else if (arg.startsWith('-')) {
      console.error(`Error: Unknown option "${arg}". Run "chat2diff --help" for usage.`);
      process.exit(1);
    } else {
      targetDir = path.resolve(arg);
    }
  }

  return { targetDir, port, noOpen, noWatch, devMode, showHelp, showVersion };
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      const tester = net.createServer();
      tester.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port < startPort + 30) {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, '127.0.0.1');
    };
    tryPort(startPort);
  });
}

async function main(): Promise<void> {
  const version = getAppVersion();
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.showHelp) {
    printHelp(version);
    process.exit(0);
  }
  if (opts.showVersion) {
    console.log(version);
    process.exit(0);
  }

  if (!fs.existsSync(opts.targetDir) || !fs.statSync(opts.targetDir).isDirectory()) {
    console.error(`Error: Directory not found: ${opts.targetDir}`);
    process.exit(1);
  }

  recordRecentRepo(opts.targetDir);
  const config = loadConfig();
  const sessionToken = opts.devMode
    ? DEV_SESSION_TOKEN
    : crypto.randomBytes(24).toString('hex');

  const port = opts.devMode ? opts.port : await findAvailablePort(opts.port);

  const wss = new WebSocketServer({ noServer: true });
  const broadcast = (event: WsEvent): void => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  let serverState!: ServerState;

  const watcher = new ClipboardWatcher(
    opts.noWatch ? false : config.clipboardWatchEnabled,
    (rawText) => {
      const parseResult = parseAndPreviewPatch(
        serverState.repoPath,
        rawText,
        loadConfig().defaultPatchFormat
      );
      if (parseResult) {
        if (parseResult.retryPrompt) {
          watcher.ignoreText(parseResult.retryPrompt);
        }
        broadcast({ type: 'PATCH_DETECTED', payload: { parseResult } });
      }
    }
  );

  serverState = {
    repoPath: opts.targetDir,
    sessionToken,
    watcher,
    broadcastWatcherStatus: () => {
      broadcast({ type: 'WATCHER_STATUS', payload: watcher.getStatus() });
    },
  };

  const app = createApp(serverState);

  const httpServer = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const token = url.searchParams.get('token') ?? undefined;

    if (
      url.pathname !== '/ws' ||
      !isValidLocalHost(req.headers.host) ||
      !verifySessionToken(token, sessionToken)
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await watcher.start();

  const launchUrl = `http://127.0.0.1:${port}/#token=${sessionToken}`;

  console.log('');
  console.log(`  Chat2Diff v${version} is running locally`);
  console.log(`  Project: ${serverState.repoPath}`);
  if (opts.devMode) {
    console.log(`  API:     http://127.0.0.1:${port}`);
    console.log('  Dev UI:  http://localhost:5173');
  } else {
    console.log(`  Open:    ${launchUrl}`);
  }
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  if (!opts.noOpen && !opts.devMode) {
    await open(launchUrl).catch(() => {});
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    watcher.stop();
    cleanupCacheDir();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start Chat2Diff:', err);
  process.exit(1);
});
