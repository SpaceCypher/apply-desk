# Apply Desk

Paste a job link. An agent opens the application in a real browser, fills it from your profile and saved answers, and sends you a screenshot on Telegram. Nothing is submitted until you tap **Approve**.

You host your own copy. Your data stays in your database; the only shared thing is the code.

## How it works

```
 You ──link──▶ Web app (Vercel) ──dispatch──▶ Worker (GitHub Actions, Chrome + Playwright)
                    │                                │
                    └──────── Neon Postgres ◀────────┤  profile, answers, queue, encrypted vault
                                                     ├─▶ Gemini      decides the next form action
                                                     ├─▶ Telegram    questions, screenshots, Approve
                                                     └─▶ Gmail IMAP  reads email verification codes
```

- **Web app** on Vercel. Sign-in is locked to one GitHub account.
- **Worker** runs in GitHub Actions, so your laptop can be off.
- **Gemini** reads the page and picks the next action. Known profile fields are filled directly. Anything it doesn't know becomes a Telegram question, and your answer is saved for next time.
- **Gmail inbox** (a dedicated one) receives account and application verification codes. The agent reads them itself.

## What it can apply on

| Site | Notes |
| --- | --- |
| Workday | Account creation, sign-in and multi-step forms. Tenants differ; some still need you. |
| Greenhouse | Hosted and embedded boards, dropdowns, uploads, email security codes. |
| Lever | Standard fields, grouped questions, uploads. |
| Ashby | Application forms and uploads. |
| SmartRecruiters, Typeform | Best-effort through the browser agent. |
| Google Forms | Public forms only. Forms that require Google sign-in stop. |
| Any other career page | Best-effort. Finds the apply button and works through the form. |

Sites behind bot walls (AWS WAF, Cloudflare challenges and similar) stop and ask you to apply manually. The agent does not try to get around them. Try every new site in **Dry run** first.

## Modes

| Mode | What happens |
| --- | --- |
| **Dry run** | Fills and inspects the form. Submitting and other writes are blocked. |
| **Review** (default) | Fills everything, then waits for your Approve on Telegram or in the app. |
| **Auto** | Off by default. Unlocks only after 20 applications have gone through Review. |

If a submit may have gone out but no confirmation came back, the job is marked `submission_unverified` and never retried, so you can't double-apply. `/stop` on Telegram halts everything.

## Setup

About 30 minutes. You need your own accounts for each service below; all have free tiers except Gemini, which needs billing enabled for sane rate limits (light use costs cents).

### 1. Fork and clone

Fork this repo on GitHub, open the **Actions** tab of your fork and enable workflows. Then:

```bash
git clone https://github.com/<you>/apply-desk.git
cd apply-desk
npm ci          # Node 22+
```

### 2. Create the accounts

Collect these values as you go; setup asks for each one.

| What | Where | Values |
| --- | --- | --- |
| Vercel project | [vercel.com/new](https://vercel.com/new), import your fork. The first deploy may fail; you just need its URL. | `AUTH_URL` = `https://<project>.vercel.app` |
| Postgres | [neon.tech](https://neon.tech), new project | `DATABASE_URL` |
| GitHub OAuth app | GitHub → Settings → Developer settings → OAuth Apps. Callback: `https://<project>.vercel.app/api/auth/callback/github` | `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` |
| Your GitHub user ID | `gh api user -q .id` | `ALLOWED_GITHUB_ID` |
| Dispatch token | Fine-grained token, your fork only, **Actions: read and write** | `GH_DISPATCH_TOKEN`, `GH_REPOSITORY` = `<you>/apply-desk` |
| Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey), enable billing | `GEMINI_API_KEY` |
| Telegram bot | Message [@BotFather](https://t.me/BotFather) `/newbot`, then send your bot any message. Get your chat ID from `https://api.telegram.org/bot<token>/getUpdates`. | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Job inbox | A new Gmail account with 2-step verification and an [app password](https://myaccount.google.com/apppasswords). Use this address on your applications. | `JOB_GMAIL_ADDRESS`, `JOB_GMAIL_APP_PASSWORD` |

Already on GCP? Choose `vertex` in setup instead of an API key and supply `GOOGLE_CLOUD_PROJECT` and a service-account JSON with the Vertex AI User role.

### 3. Run setup

```bash
npm run setup
```

It asks for the values above, generates your vault key and secrets, then checks each service for real: a Postgres connection, a tiny Gemini call, your Telegram bot and chat, a Gmail login and a harmless workflow dispatch. If everything passes, it runs the database migrations, registers the Telegram webhook and writes `.env.local`. If `gh` is signed in, it offers to upload the GitHub Actions secrets for you.

`.env.local` holds your `VAULT_KEY`. Back it up somewhere safe. If you lose it, your saved credentials can't be decrypted.

### 4. Finish on Vercel

Copy every variable setup lists into Vercel → Project → Settings → Environment Variables, then redeploy. If you skipped the `gh` upload, add the GitHub secrets it lists under your fork's Settings → Secrets and variables → Actions.

### 5. First run

1. Open your Vercel URL and sign in with GitHub.
2. Fill **Profile** (see below).
3. In **Settings**, switch to **Dry run** and paste a job link on the home page or send it to your bot.
4. Watch the run in the app. When it looks right, switch to **Review** and apply for real.

## Build your profile

Don't type it all in. Give [docs/profile-prompt.md](docs/profile-prompt.md) to ChatGPT, Claude or Gemini along with your resume or LinkedIn text. It returns JSON in the exact import format. Check it, save it as a `.json` file, then use **Profile → Import**.

Paste your resume as plain text (or your own `.tex`) under **Profile → Resume & writing**. The agent tailors and builds a PDF per job from it, and you can download each one under **Documents**. Anything the agent doesn't know, it asks once on Telegram and remembers.

## Telegram commands

| Command | Does |
| --- | --- |
| `<job link>` | Queue an application |
| `/dry <job link>` | Queue it as a dry run |
| `/status` | What's running |
| `/stop`, `/resume` | Kill switch on and off |

Plain text answers whatever question is open.

## Costs

- **Gemini** is the only real cost. A paid AI Studio key is cheap at personal volume; set a budget in Google Cloud. The free tier works but has low rate limits, and Google may use free-tier prompts, which contain your resume, to improve its products. See [pricing](https://ai.google.dev/gemini-api/docs/pricing) and [terms](https://ai.google.dev/gemini-api/terms).
- **GitHub Actions** is free for public repos. A private fork uses your monthly minutes; each application takes a few minutes.
- **Vercel, Neon, Telegram, Gmail** free tiers are enough for one person.

## Development

```bash
npm run dev                              # web app on localhost:3000
npm run worker                           # run the worker locally against your queue
npm run bench -- --planner scripted      # local fixture forms, no model calls
npm test                                 # needs a scratch Postgres and Chrome, see below
npm run lint && npm run typecheck && npm run build
```

Point tests at a throwaway database, never your real one:

```bash
export DATABASE_URL=postgresql://localhost/apply_desk_test
export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm run migrate && npm test
```

Database and browser tests skip if those aren't set. `worker/lib/invariants.test.mjs` guards the submit rules (dry run blocks writes, Review needs approval, unverified submits never retry). Don't weaken it.

## Use it responsibly

Apply only to jobs you actually want, read what it fills before you approve, and respect each site's terms. This is an assistant for your own applications, not a spam cannon.

## License

[MIT](LICENSE)
