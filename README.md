# Chat2Diff

**Turn any AI chatbot (ChatGPT, Gemini, Claude, DeepSeek, Grok, or local Web UIs) into a safe, visual, multi-file coding workbench on your machine.**

No API keys. No IDE agent quotas. No browser scraping or ToS ban risks. Works on **Windows, macOS, and Linux** across any language or framework (TypeScript, Python, Rust, Go, Java, HTML, Markdown, and more).

---

## Quick Start

Requires **Node.js 20.11+**. Run inside any project folder (Git or non-Git):

```bash
npx chat2diff
```

Or target a specific folder directly:

```bash
npx chat2diff ./path/to/your-project
```

Chat2Diff starts a local server on `127.0.0.1` with a random per-session token and opens the visual workbench in your browser.

---

## How It Works (2-Mode Workflow)

### 1. Prepare & Send
* **Pick only what matters:** Select your full project, check 2–3 specific folders, or click **Changed** to select uncommitted Git files. `.gitignore` rules, binaries, lockfiles, and `.env` / private key files are excluded automatically.
* **Describe your task in plain English:** Pick a preset (**Fix a Bug**, **Add a Feature**, **Improve Code**, **Review Only**), optionally paste compiler or runtime logs, and choose **Search & Replace** (default) or **Unified Git Diff**.
* **Zero Downloads bloat:** Paste text directly for small selections, or use **Attach as File** — Chat2Diff overwrites a single temporary cache file and copies the native file object to your clipboard so pressing `Ctrl+V` in Gemini, ChatGPT, or Claude attaches it immediately without cluttering your `Downloads` folder.
  * **1-Paste Magic:** Packages task instructions + code inside one file (`Ctrl+V` → type `go`).
  * **Separate File + Prompt:** Step 1 copies the code file, Step 2 copies your readable prompt.
* **Grounded Multi-Turn Follow-Ups:** Switch to **Same Chat (Follow-Up)** on Turn 2+ to report exact applied, partial, skipped, failed, and undone files to the AI without re-uploading unchanged files every turn.

### 2. Review & Apply
* **Automatic Clipboard Detection & Paste-Anywhere:** Copy the AI's reply (or press `Ctrl+V` anywhere in the app) to open the visual diff viewer immediately.
* **Self-Healing Patch Engine:** Handles 4-backtick Search/Replace blocks, Unified Git Diffs, indentation drift, CRLF/LF preservation, and smart path resolution. If any file still fails, **Copy Fix Prompt** automatically attaches that file's exact current on-disk source for one-shot recovery.
* **Granular Control:** Inspect changes **Side-by-Side** or **Unified** with word-level highlighting and line wrapping. Apply a single change block (hunk), one file at a time, or a checked batch without losing your place.
* **1-Click Undo History:** Every apply saves a local pre-apply backup snapshot (`.git/chat2diff/snapshots/` or `.chat2diff/snapshots/`). Revert any batch byte-for-byte in one click.

---

## CLI Options

```text
Usage: npx chat2diff [directory] [options]

Options:
  -p, --port <num>   Localhost port to bind (default: 4310, auto-increments if busy)
  --no-open          Start server without auto-opening your browser
  --no-watch         Start with automatic clipboard listener paused
  -v, --version      Print Chat2Diff version
  -h, --help         Show help message
```

---

## Privacy & Local Security

* **100% Local-First:** Zero telemetry, zero cloud accounts, zero outbound API calls.
* **Hardened Local Server:** Binds strictly to `127.0.0.1`, validates the `Host` header against DNS rebinding, and enforces a random per-launch `X-Chat2Diff-Token` via constant-time comparison on all API and WebSocket routes.
* **Root-Jail Path Guard:** Hard-blocks `../` traversal, absolute paths, escaping symlinks, and `.git/` writes.
* **Secret Protection:** Automatically excludes `.env*` and private keys from file scanning, and detects/redacts common API keys before copying to external AI chats.

See [SECURITY.md](./SECURITY.md) for full details.

---

## Local Development

```bash
git clone https://github.com/RootDeveloperDS/Chat2Diff.git
cd Chat2Diff
npm install
npm run dev
```

Open `http://localhost:5173`. Run the full quality gate anytime:

```bash
npm run check
```

---

## License

[MIT](./LICENSE) — Created by [Devansh Sharma (RootDeveloperDS)](https://github.com/RootDeveloperDS).