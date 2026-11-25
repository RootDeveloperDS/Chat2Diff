# Contributing to Chat2Diff

Contributions, bug reports, and patch-parser edge cases are welcome!

## Development Setup

Requirements: **Node.js 20.11+** and **Git**.

```bash
git clone https://github.com/RootDeveloperDS/Chat2Diff.git
cd Chat2Diff
npm install
npm run dev
```

* Backend API + WebSocket server runs on `http://127.0.0.1:4310`
* Vite React UI runs on `http://localhost:5173` (proxying `/api` and `/ws`)

## Architecture Map

* `src/shared/` — Shared TypeScript types and constants (zero Node/DOM deps).
* `src/server/core/` — Core engines:
  * `repoScanner.ts` — Git/FS repo walker + uncommitted Git change detection.
  * `pathGuard.ts` & `secretGuard.ts` — Root-jail containment and API key redaction.
  * `promptBuilder.ts` — Prompt formatting, delta follow-up hash tracking, and file bundling.
  * `patchEngine.ts` — Multi-format Search/Replace + Unified Diff parser and self-healer.
  * `snapshotManager.ts` — Conflict checks, atomic backups, and 1-click Undo.
  * `fileClipboard.ts` & `clipboardWatcher.ts` — Cross-platform native file copy and SHA-256 clipboard radar.
* `src/client/` — React 19 + Tailwind v4 + Zustand local workbench UI.
* `tests/` — Vitest unit and Hono API integration test suite.

## Pull Request Checklist

1. Keep UI copy plain, beginner-friendly, and free of unnecessary jargon.
2. Add or update Vitest tests in `tests/` for any bug fix or parser rule change.
3. Verify the full quality gate passes locally before opening a PR:
   ```bash
   npm run check
   ```