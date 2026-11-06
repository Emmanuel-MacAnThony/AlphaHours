# Alpha City Hours Tracker (v2, standalone)

A timesheet app for TrueLions' hourly contractors on Alpha City. It runs on your own Google Cloud project, through Firebase. The owner is Mary Jane.

- **Sign-in:** everyone signs in with their Google (Gmail) account. Managers get the manager view. Each contractor only sees their own hours and feedback.
- **ChatGPT writes straight in.** Contractors say "log my day" to the team GPT. It reads their Gmail, Drive and Slack, asks for screenshots of calls and WhatsApp, and sends the tasks to the tracker as drafts.
- **Slack (optional).** A daily report posted in #hours-tracker is read by AI, turned into tasks, and confirmed in a thread reply. The Slack bot also posts the weekly reminders.
- **AI scoring.** Every night at 23:30 WAT, each person's day is scored 1–5 on output volume and output per hour, compared with the team's typical rate. Good days are marked "Recommended to approve".
- **Same features as the current tracker:** day sheets with start and end times, required proof of work, weekly submit and approval, flags, pay statements, and Team & rates (managers only, rate = salary ÷ 200 h).

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| `public/` | Firebase Hosting | The app (`index.html`), the ChatGPT sign-in page (`connect.html`), and `privacy.html` |
| `functions/` | Cloud Functions (europe-west1) | `/api/*`: ChatGPT sign-in, the reports endpoint, admin actions. It also runs the scheduled scoring, Slack import and reminders |
| Firestore | Database | Contractors, pay (managers only), entries, scores |
| Cloud Storage | Files | Proof screenshots and files |
| `firestore.rules`, `storage.rules` | Security | Who can read and write what. Tested: contractors can't read pay or other people's hours, and can't approve their own |
| `seed/data.json` | Your data | The 5 contractors, salaries, rates and settings, exported from the Claude tracker. **Contains salaries: keep private, don't commit to git.** |
| `docs/chatgpt-gpt-setup.md` | Guide | How to create the team GPT and connect it |

## Before deploying, collect these

1. **Google Cloud / Firebase project** on the **Blaze (pay-as-you-go)** plan. Cloud Functions and Storage require it. At this size, usage should stay mostly within the free allowance. Set a budget alert (for example $20 a month).
2. **OpenAI API key** from https://platform.openai.com. This is separate from ChatGPT seats and is billed per use (small at this scale). It's used for reading Slack reports and writing feedback. Without it, scoring still works with plain-text feedback, but Slack import is off.
3. **Slack bot** (optional). See "Slack bot" below.
4. **Your web address**, for example `hours.yourcompany.com`.
5. **Google sign-in emails** for Mary Jane, Bradford and the 5 contractors.

## Deploy (for the engineer)

Needs Node.js 22, the Firebase CLI and the gcloud CLI.

1. **Create the Firebase project.** In https://console.firebase.google.com, choose Add project (or add Firebase to the existing TrueLions Google Cloud project), then upgrade it to **Blaze**.
2. **Turn on the services in the console:**
   - **Authentication:** Sign-in method, Google, Enable.
   - **Firestore Database:** Create, production mode, location `europe-west1`. This can't be changed later.
   - **Storage:** Get started, production mode, same region.
3. **Install and log in:**
   ```bash
   npm install
   ```
   ```bash
   npm --prefix functions install
   ```
   ```bash
   npx firebase login
   ```
4. **Point the folder at the project.** Replace `YOUR-FIREBASE-PROJECT-ID` in `.firebaserc` with your project ID.
5. **Settings.** Copy `functions/.env.example` to `functions/.env`, then set `APP_URL`. Also set `SLACK_CHANNEL_ID` if you're using Slack.
6. **Secrets.** Each command asks you to paste a value. Use `none` for anything you aren't using yet.
   ```bash
   npx firebase functions:secrets:set OAUTH_CLIENT_SECRET
   ```
   (Generate this one with `openssl rand -hex 32` and keep it; you'll need it for the GPT.)
   ```bash
   npx firebase functions:secrets:set OPENAI_API_KEY
   ```
   ```bash
   npx firebase functions:secrets:set SLACK_BOT_TOKEN
   ```
7. **Deploy everything** (app, API, scheduled jobs, rules, indexes):
   ```bash
   npx firebase deploy
   ```
   The first deploy may ask to enable some Google APIs (Cloud Functions, Cloud Build, Cloud Scheduler, Secret Manager, Artifact Registry). Answer yes.
8. **Custom domain.** In Hosting, choose Add custom domain and follow the DNS steps. Then add the domain under Authentication, Settings, **Authorized domains**.
9. **Load the team.** Fill in every email in `seed/data.json`, then run:
   ```bash
   gcloud auth application-default login
   ```
   ```bash
   node scripts/seed.mjs --project YOUR-FIREBASE-PROJECT-ID
   ```
10. **Check it.** Open the app, sign in as Mary Jane, and look at Team & rates. Then sign in as a contractor in a private window and confirm they see only "My hours".
11. **Set up the GPT:** follow `docs/chatgpt-gpt-setup.md`. Then paste the GPT link into the app under Team & rates, **Settings**.

## Slack bot (optional)

1. Go to https://api.slack.com/apps, then **Create New App**, From scratch. Name it "Alpha City Hours" and pick your workspace.
2. Under **OAuth & Permissions, Bot Token Scopes**, add:
   - `channels:history`
   - `groups:history` (if #hours-tracker is private)
   - `chat:write`
   - `users:read`
   - `users:read.email`
   - `files:read`
3. **Install to Workspace.** A Slack admin may need to approve. Then copy the **Bot User OAuth Token** (starts with `xoxb-`). That's the `SLACK_BOT_TOKEN` secret.
4. In Slack, open #hours-tracker and type `/invite @Alpha City Hours`.
5. Put the channel ID in `functions/.env` as `SLACK_CHANNEL_ID`, then deploy again.

**What the bot does:**
- Reminds people on Friday at 16:00 and Monday at 09:00.
- Nudges the managers about pending approvals on Tuesday at 10:00.
- Posts a weekly hours summary on Monday at 08:00.
- Checks the channel every 30 minutes for daily reports, and replies in the thread with what it logged or what to fix.

Contractors' Slack emails must match the emails in Team & rates.

## Day-to-day

- **Add a manager:** in Firestore, collection `managers`, add a document whose ID is their email in lowercase. By design, this can't be done from the app.
- **Add or remove a contractor:** use Team & rates. The email field controls who can sign in. Setting someone to Inactive removes their access to ChatGPT sign-in.
- **Run scoring or the Slack import right now** (for example, after fixing data): a manager can call `POST /api/admin/score` or `POST /api/admin/slack-import` with their Firebase ID token. Ask the engineer.
- **Backups:** in Google Cloud, go to Firestore, Disaster recovery, and turn on point-in-time recovery or scheduled backups.

## How scoring works

For each contractor-day, using hours that weren't returned:
- **Volume** compares the day's outputs with the team's median outputs per day over the previous 14 days.
- **Efficiency** compares outputs per hour with the team's median outputs per hour.
- Each ratio is banded: 1.5× typical or more = 5, 1.1× = 4, 0.8× = 3, 0.5× = 2, below that = 1. The **score** is the average of the two.
- A day is marked **Review** instead of **Recommended to approve** if:
  - less than 80% of its hours have proof
  - it has more than 10 hours
  - it has no outputs across 2 or more hours
  - its score is below 3
- Scoring starts once the team has 3 logged days of history.
- Managers still make the final approval. Scores never change pay automatically.

## Tests

- `npm --prefix functions test` runs the report validation and scoring unit tests.
- The database rules and the ChatGPT sign-in and report flow were also tested against the Firebase emulators during development.

## Privacy

Contractor data and pay are personal data under Nigeria's NDPA 2023. Access is limited to the people who need it:
- Proof files are private to the team, but anyone holding a file's direct link can open it.
- Task text is sent to OpenAI only for Slack parsing and feedback.

Tell the contractors what is collected and why; `privacy.html` is a starting point.
