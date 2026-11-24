# Chat2Diff

Turn **any AI chatbot** (ChatGPT, Gemini, Claude, DeepSeek, Grok) into a safe, visual, multi-file coding workflow on your local machine — with zero API keys, zero IDE quota limits, and 1-click Undo.

## Quick Start (Development)

```bash
npm install
npm run dev

```

Open `http://localhost:5173` in your browser.

## Production Build & CLI Usage

```bash
npm run build
node dist/cli.js

```

Or point Chat2Diff at any local project folder:

```bash
node dist/cli.js "C:\path\to\your-project"

```

## How It Works

1. **Pick Files:** Select your whole project or just the 2–3 folders you want to work on.
2. **Describe Task:** Write what you need in plain English, paste any error, and click **Copy Prompt & Code** (or **Download Context File**).
3. **Review & Apply:** Copy the AI's reply (or paste it directly), inspect changes side-by-side, apply all or selected files, and undo anytime in one click.