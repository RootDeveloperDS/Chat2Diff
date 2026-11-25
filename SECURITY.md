# Security Policy

Chat2Diff runs locally on your machine with filesystem read/write access inside your chosen project directory. Security is enforced across four layers:

## 1. Localhost Network Isolation
* The HTTP and WebSocket server binds exclusively to **`127.0.0.1`** (never `0.0.0.0`).
* Every request validates the `Host` header against `localhost` / `127.0.0.1` to prevent DNS-rebinding attacks.
* Every `/api/*` request and `/ws` connection requires a random 192-bit per-launch session token (`X-Chat2Diff-Token`) verified using `crypto.timingSafeEqual`.
* The browser extracts `#token=...` into `sessionStorage` on boot and immediately removes it from the address bar via `history.replaceState`.

## 2. Filesystem Root-Jail (`src/server/core/pathGuard.ts`)
* Every read, preview, write, delete, and undo operation passes through `resolveSafeRepoPath`.
* Hard-blocks empty paths, absolute POSIX/Windows paths, `..` traversal segments, `.git/` and `.chat2diff/` internal directories, and symlinks resolving outside the active repository root.

## 3. Secret Protection & Sensitive File Warnings
* `.env*` (except `.env.example`, `.env.sample`, `.env.template`), private key files (`.pem`, `.key`, `id_rsa`, `id_ed25519`), and service account files are hidden during scanning.
* `secretGuard.ts` scans selected source files for common API tokens (OpenAI, Google, GitHub, AWS, Groq, Slack, PEM private keys) and masks them by default before copying or exporting.
* Incoming AI patches touching `.env`, `.github/workflows`, `package.json`, `Dockerfile`, or credential files display an explicit warning banner before apply.

## 4. Zero External Automation or Telemetry
* Chat2Diff makes zero outbound network requests, collects zero analytics, and never scrapes or automates third-party AI web sessions.

## Reporting a Vulnerability
Please open a private security advisory on GitHub at [https://github.com/RootDeveloperDS/Chat2Diff/security/advisories](https://github.com/RootDeveloperDS/Chat2Diff/security/advisories) or report responsibly via the repository maintainer.