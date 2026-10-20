# AERON AI & Robotics website

This project contains a responsive AI and robotics website plus a Node.js backend for real AI content generation. The browser sends the content type and brief to the local server. The server calls Google Gemini through Google's official `@google/genai` JavaScript SDK. The Gemini key stays in the server-side `.env` file and is never sent to browser code.

## Requirements

- Windows 10 or 11
- Node.js 24.15 or newer (the project uses Node's built-in SQLite module; install a current release from [nodejs.org](https://nodejs.org/))
- A Google AI Studio Gemini API key

## Start the website on Windows

1. Open PowerShell and go to the project folder:

   ```powershell
   cd "C:\Users\Tech Wiz Studio\Downloads\MY AI DOc"
   ```

2. Install the project dependencies (if `npm` is blocked by PowerShell's script policy, run `npm.cmd install`):

   ```powershell
   npm.cmd install
   ```

3. Make your private environment file only if one does not already exist:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

4. In Notepad, add `GEMINI_API_KEY=your_google_ai_studio_key` and save. Keep `.env` private; `.gitignore` excludes it from Git. Do not overwrite an existing `.env`; add or update the settings inside it. You can change `GEMINI_MODEL` if needed.

5. Start the local website server:

   ```powershell
   npm.cmd start
   ```

6. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser. Scroll to **AI Studio**, choose a draft type, enter a brief of 10–2,000 characters, and select **Generate with AI**. The server must remain running while you use the feature. Press **Ctrl+C** in PowerShell to stop it.

The API call uses your Google AI Studio account and is subject to its usage limits and billing settings. The website does not provide an offline or sample response: if the key is missing or the API request fails, it shows an error instead.

## Files

- `index.html`, `styles.css`, `script.js`: AERON website design, responsive layouts, navigation, and AI Studio interface.
- `server.js`: local website server and validated `/api/generate` endpoint.
- `package.json`: Node.js dependencies and start command.
- `.env.example`: safe template containing placeholders only for local server settings.
- `.gitignore`: excludes `.env` and installed dependencies.

You can still open `index.html` directly to view the static homepage, but the AI generator requires the server URL above.

## OpenAI Agents API blog assistant

This project also includes an interactive terminal app for the saved **AI Blog Assistant** agent. It creates a session in OpenAI project `proj_pJCRBi4iy1ebI6fIqCQJOlbe`, sends an initial message, streams the session events and generated text, and accepts follow-up messages until you enter `/exit`.

The app reuses saved agent `agent_68f49f5482e04fa9bedf640ff5689fd30d8f99d1bada487ba2`. At session creation it applies the current model, instructions, reasoning, and text configuration as per-session overrides. It omits other agent fields so the saved tools and remaining settings are preserved. The session uses `environment: { "type": "none" }` because blog drafting does not need a command executor or workspace sandbox. API calls use `curl.exe` directly.

### Run it on Windows

1. Make sure `.env` contains a valid `OPENAI_API_KEY` with access to the selected project and Agents API. If authentication fails, create or select an active key in your OpenAI account and update the value in `.env`. Keep it private and do not commit it.
2. Use a `curl.exe` version 8.3 or newer (the Windows build on this machine supports the required environment-variable header expansion).
3. From the project folder, start the session:

   ```powershell
   npm.cmd run agents
   ```

4. Reply to the assistant's opening question in the terminal. Enter `/exit` when you are done.

The app defaults to the project and saved-agent IDs above. You can override them with `OPENAI_PROJECT_ID`, `OPENAI_AGENT_ID`, or `OPENAI_BASE_URL`. Agents API usage may incur charges. See the [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview), [session configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), and [session event streaming](https://developers.openai.com/api/docs/guides/agents-api/sessions/events) for API details.

## Backend blog automation (Gemini-powered)

The blog system is backend-only. It does not add dashboard controls or change the homepage. It stores topics, articles, schedules, automation settings, and run history in `data/blog.sqlite` using Node's built-in SQLite module. Article generation uses Google's official `@google/genai` SDK. Use Node.js 24.15 or newer.

### Configure secure access

The blog management endpoints require a private bearer token. Add or update these lines in your existing `.env` file; do not replace the file, since it may already contain settings you need:

```env
BLOG_ADMIN_TOKEN=paste_a_private_random_token_here
GEMINI_API_KEY=your_private_google_ai_studio_key
GEMINI_MODEL=gemini-3.8-flash
```

Generate a token in PowerShell with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy that generated value into `.env`. Keep the token private and do not paste it into chat or commit it to a repository. `GEMINI_API_KEY` and `GEMINI_MODEL` are read only by the backend. The key is never returned by the API or sent to browser code. Article generation and automation make Gemini API requests and may incur usage charges. This blog workflow does not require an OpenAI key. Tests use mocked AI responses and do not make paid requests.

### Automatic daily publishing

When the Node.js backend is running, its scheduler selects two new evergreen topic ideas, checks them against saved topics and articles, generates one article for each with Gemini, validates the content and SEO fields, then saves each as a draft and publishes it through the existing SQLite publication method. The topic title stores the category, suggested keywords store tags, and an additive `image_alt_text` column stores image alt text. A persistent daily-run record and per-article slots prevent retries, restarts, or another server process from publishing the same slot twice. If one article fails, any successfully published article is kept and only the missing slot can be retried. Temporary rate-limit and network failures are retried; other errors are recorded in server logs and the run history.

The target time is **2:30 PM Asia/Karachi**. The scheduler calculates that wall-clock time explicitly and checks for missed work after a restart. The topic prompt is evergreen and does not claim live research: Tavily is not configured, and the system does not fabricate sources or citations.

The backend must remain running and have access to persistent SQLite storage. On a personal Windows computer, leave it awake with `npm.cmd start` running; sleep, shutdown, or a network outage can delay the run. For dependable daily publishing, use an always-on server or container with a persistent disk and process supervision (automatic restart). Do not run deployments against separate database files. The app's default host is local-only; do not expose it publicly without a secure deployment setup. Tests use temporary databases and mocked Gemini responses and do not publish to the saved site database or spend API credits.

### Start and test

In PowerShell, from the project folder, run:

```powershell
npm.cmd test
npm.cmd start
```

The tests use a temporary database and mocked AI responses; they do not need a key or make paid requests. They do not modify the saved blog database. The server creates `data/blog.sqlite` on startup. Stop it with **Ctrl+C**. The database is ignored by Git.

### Backend endpoints

Send management requests to `http://127.0.0.1:3000/api/blog` with an `Authorization: Bearer <your BLOG_ADMIN_TOKEN>` header. For example:

```powershell
$adminToken = "your private token"
$headers = @{ Authorization = "Bearer $adminToken" }
$topic = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/blog/topics" -Headers $headers -ContentType "application/json" -Body '{"title":"Humanoid robot safety","brief":"Questions for evaluating robots in shared workspaces","keywords":["robotics","safety"]}'
```

The returned topic ID can be used with these routes:

- `GET/POST /api/blog/topics` and `GET/PATCH/DELETE /api/blog/topics/:id` — manage topics.
- `POST /api/blog/articles/generate` with `{"topicId":"..."}` — generate a full AI article and save it as a draft, including its title, structured content, SEO description, keywords, image alt text, and URL slug.
- `GET /api/blog/articles` and `GET/PATCH/DELETE /api/blog/articles/:id` — list, edit, or delete draft content.
- `POST /api/blog/articles/:id/schedule` with `{"scheduledAt":"2030-01-01T12:00:00Z"}` — schedule a future local publication.
- `POST /api/blog/articles/:id/publish` or `/unschedule` — publish now or return a scheduled article to draft.
- `GET/POST /api/blog/automations`, `PATCH/DELETE /api/blog/automations/:id` — configure recurring draft and publication schedules.
- `POST /api/blog/automations/run-due` — process due work immediately for local testing.
- `GET /api/blog/status` — view counts, configured generator, whether a key is configured (the key itself is never returned), and the daily run time and latest result.
- `GET /api/blog/public/articles` and `GET /api/blog/public/articles/:slug` — read published articles without an admin token.

Scheduled publication changes the article's state and makes it available through the public JSON endpoints; no external CMS, WordPress site, or social platform is connected. The daily automation publishes generated articles directly, so only run it where automatic publishing is intended. If generation says the key is missing, add `GEMINI_API_KEY=...` to `.env` and restart with `npm.cmd start`. Set `GEMINI_MODEL` to a model enabled for your Google AI Studio project. If the key is rejected, check it in Google AI Studio. Never paste the key into frontend files or a public repository.

