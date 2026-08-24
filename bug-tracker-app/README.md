# Bug Tracker

Scans a public GitHub repo or a zip file for bugs using the Anthropic API, and tracks the findings in a small dashboard. Backend and frontend are separate folders; the backend serves the frontend, so you only need to run one process.

```
bug-tracker-app/
  backend/     Express API + SSE scan endpoints + JSON-file storage
  frontend/    Static HTML/CSS/JS dashboard
```

## Setup

Requires **Node.js 18+** (for built-in `fetch`).

```bash
cd backend
npm install
cp .env.example .env
```

Open `backend/.env` and add your Anthropic API key (get one at https://console.anthropic.com/):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then start it:

```bash
npm start
```

Open **http://localhost:4000** — the backend serves the frontend on the same port.

## How it works

- **GitHub tab**: paste a public repo URL. The backend reads the file tree via GitHub's API and pulls up to 20 source files (skipping `node_modules`, `dist`, `.git`, vendor/build folders, and anything over ~60KB).
- **Zip tab**: upload a `.zip`. It's unpacked server-side with the same file filtering.
- Each file is sent to Claude for review. Progress streams live to the browser over Server-Sent Events.
- Results are saved to `backend/data/scans.json` (a flat JSON file — good enough for personal/local use; swap in a real database if you deploy this for a team).
- Past scans show up at the top of the page so you can revisit them, and marking a bug "resolved" persists across restarts.

## Limits worth knowing

- Only scans up to 20 files per run, and truncates very long files — big repos won't get full coverage.
- It's AI review, not a compiler or linter. It can miss real bugs and occasionally flag non-issues. Treat it as a fast first pass, not ground truth.
- Only **public** GitHub repos are supported — no auth flow for private repos out of the box.
- `scans.json` is unauthenticated local storage. Don't deploy this as-is on the open internet without adding access control.

## Extending it

Ideas if you want to keep going:
- Swap `backend/data/scans.json` for a real database (SQLite/Postgres) once you outgrow a single JSON file.
- Add a GitHub personal access token to `collectGithubFiles` in `backend/services/github.js` to support private repos and raise the rate limit.
- Add a "delete scan" endpoint and button.
- Export findings to CSV/Markdown from the results view.
