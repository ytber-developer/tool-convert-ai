# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Web UI (primary way to run)
npm run ui              # Start Express server at http://localhost:3100

# CLI (headless / scripted)
npm start               # Run batch job from input/data.xlsx directly

# One-time setup
npm run login           # Open browser for manual ChatGPT login, saves cookies/session.json
npm run create-sample   # Generate input/data.xlsx with 3 sample rows
```

No test suite or linter configured.

## Architecture

This tool automates ChatGPT via Puppeteer: reads an Excel file row-by-row, uploads each image + prompt to a new ChatGPT conversation, then saves the output image named after the sample name.

### Data flow

```
Excel (input/data.xlsx)
  → excel-reader.js      reads rows: { name, imageUrl, description }
  → downloader.js        downloads imageUrl → /tmp file
  → ChatGPTAutomator     opens new conversation, uploads image, types prompt, waits for response
  → downloader.js        saves output image → output/<sanitized-name>.png
```

### Two entry points sharing the same core

- **`src/index.js`** — CLI runner. Reads `.env`, iterates rows sequentially, prints to stdout.
- **`src/server.js`** — Express web server. Exposes the same job logic via REST + **Server-Sent Events** for real-time UI updates. Frontend lives in `public/index.html` (vanilla HTML/CSS/JS, no build step).

Both call the same three modules: `excel-reader`, `chatgpt-automator`, `downloader`.

### Key modules

| File | Responsibility |
|------|----------------|
| `src/chatgpt-automator.js` | `ChatGPTAutomator` class — Puppeteer lifecycle, session cookies, image upload, prompt typing, response polling, output download |
| `src/excel-reader.js` | Parses `.xlsx` header row with fuzzy matching (handles Vietnamese column names), returns `{ rowNumber, name, imageUrl, description }[]` |
| `src/downloader.js` | `downloadImageToTemp` (URL → `/tmp`), `saveOutputImage` (Buffer/URL → `output/`), `sanitizeFilename` |
| `src/server.js` | Express + Multer upload, SSE broadcast, single in-memory `jobState`, `runJob()` async loop |

### Session management

Cookies are persisted to `cookies/session.json` after first login. On each launch, `ChatGPTAutomator.launch()` loads them automatically. Run `npm run login` to re-authenticate when the session expires.

### ChatGPT UI selectors

`chatgpt-automator.js` tries multiple CSS selectors in order for each interaction (attach button, prompt textarea, send button, download button) because ChatGPT's DOM changes frequently. If automation breaks, inspect the live DOM at `https://chatgpt.com` and update the selector arrays in `_uploadImage`, `_typePrompt`, `_submitMessage`, and `downloadOutputImage`.

### Output strategy (priority order)

1. Click the download button inside ChatGPT's last assistant message → rename to `<name>.png`
2. Scrape the image `src` from the last assistant message → `axios` download → save
3. Fallback: save the text response as `<name>.txt`

Rows whose output file already exists are **skipped** (idempotent reruns).

### Environment variables (`.env`)

| Variable | Default | Notes |
|----------|---------|-------|
| `INPUT_FILE` | `./input/data.xlsx` | CLI mode only |
| `OUTPUT_DIR` | `./output` | Shared |
| `DELAY_BETWEEN_ROWS` | `5000` | ms, avoids rate limiting |
| `HEADLESS` | `false` | Set `true` for background runs |
| `PORT` | `3100` | Web UI port |

### SSE event types (server → browser)

`info`, `success`, `error`, `warn`, `progress`, `skip`, `done`, `stopped` — all carry `{ type, message }`.  
`rowDone` carries `{ index, status, name, file? }` to update the table row badge.  
`finished` carries the full `results[]` array.
