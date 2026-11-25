# Changelog

All notable changes to **Chat2Diff** are documented in this file.

## [1.3.0] - 2026-11-24

### Added
* **2-Mode Local Workbench (`npx chat2diff`):** Collapsible split-screen **Prepare & Send** view paired with **Review & Apply**.
* **Grounded Multi-Turn Follow-Up Sync:** **New Chat** vs **Same Chat (Follow-Up)** modes with persistent SHA-256 file hash tracking and automatic sync reports (`applied`, `partial`, `skipped`, `failed`, `undone`).
* **Zero-Bloat File Attachment & Native Clipboard:** Overwrites a single temporary cache file in `~/.chat2diff/cache/` and places the native file object on the OS clipboard (Windows, macOS, Linux) with both **1-Paste Magic** and **Separate File + Prompt** modes.
* **Hardened Multi-Format Patch Engine:** 4-backtick fenced Search/Replace parser and Unified Git Diff engine with multi-tier self-healing, explicit malformed-block reporting, smart path resolution, and automatic on-disk source attachment in **Copy Fix Prompt**.
* **IDE-Style Diff Reviewer:** Side-by-side and unified views with word-level highlighting, line wrapping, collapsible unchanged gaps, per-hunk apply, single-file apply, and 1-click Undo snapshots.
* **Local Security & CLI Polish:** `127.0.0.1` Host validation, constant-time per-session token auth, root-jail path guard, secret redaction, `--help`/`--version` CLI flags, Vitest suite, and cross-OS GitHub Actions CI.