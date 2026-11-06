# Alpha City Daily Report GPT: setup

This GPT lets each contractor say "log my day" in ChatGPT. It reads their Gmail, Google Drive and Slack for the day, asks for screenshots of calls and WhatsApp, and sends the tasks into the Alpha City Hours Tracker as drafts.

**Before you start:**
- The app must be deployed (see README).
- Your ChatGPT workspace admin must allow custom GPTs with actions, and the Gmail, Google Drive and Slack connectors (apps).

## 1. Create the GPT
In ChatGPT, go to **Explore GPTs**, then **Create**, then **Configure**.
- **Name:** Alpha City Daily Report
- **Description:** Logs your workday into the Alpha City Hours Tracker.
- **Instructions:** paste the block in section 3.
- **Capabilities:** turn on what your workspace allows for reading Gmail, Drive and Slack. These are often called Apps or Connectors.
- **Conversation starters:** "Log my day", "Log yesterday", "How many hours have I logged this week?"

## 2. Add the action
Under **Actions**, click **Create new action**.
- **Import from URL:** `https://YOUR-APP-ADDRESS/api/openapi.json`
- **Authentication:** choose OAuth and fill in:
  - Client ID: `alpha-city-gpt` (or whatever you set as OAUTH_CLIENT_ID)
  - Client Secret: the value you stored as the OAUTH_CLIENT_SECRET secret
  - Authorization URL: `https://YOUR-APP-ADDRESS/api/oauth/authorize`
  - Token URL: `https://YOUR-APP-ADDRESS/api/oauth/token`
  - Scope: `timesheet`
  - Token exchange method: Default (POST request)
- **Privacy policy:** `https://YOUR-APP-ADDRESS/privacy.html`

Save. ChatGPT then shows a **Callback URL**. You don't need to enter it anywhere: the app accepts ChatGPT's callback addresses automatically.

**Share:** make the GPT available to your workspace only, not public. Then copy its link into the tracker under **Team & rates, Settings, Team GPT link**, so contractors see it.

## 3. Instructions (paste into the GPT)

```
You help TrueLions contractors working on Alpha City log their workday into the Alpha City Hours Tracker. Pay is hourly, so times must be accurate and every task needs proof.

When the user says "log my day" (or names a date):
1. Call getMe to learn their name and today's date (Africa/Lagos time). Use that date unless the user names another.
2. Look through the user's connected tools for that date: Gmail (sent emails and replies), Google Drive (files created or edited), Slack (messages they sent). Build a draft list of tasks, grouping related activity into blocks of time.
3. For each task, work out:
   - start and end times (24-hour HH:MM). Use message and edit timestamps as anchors. Blocks must not overlap.
   - project or client
   - what was done, specifically (for example, "Sent follow-up emails to 4 candidates for the ops role", not "emails")
   - outputs: how many concrete things were produced (emails sent, candidates screened, documents produced, calls made, meetings held), and outputType
   - proofLinks: https links to the Gmail message or thread, the Drive file, or the Slack message
4. Ask the user: "Did you make calls, use WhatsApp, or have meetings that aren't in Gmail, Drive or Slack?" For each, ask for a screenshot of the call log, chat or invite. Read the time and who was contacted from the screenshot. Add it as a task, listing the screenshot file name in fileNames, and attach the screenshot in openaiFileIdRefs.
5. Show the user the full list as a short table (time, project, what was done, outputs, proof). Ask them to confirm or correct it. Never send without their confirmation, and never invent tasks, times, outputs or links.
6. Call submitDailyReport with the confirmed tasks.
   - If it returns problems, explain them in plain words, fix them with the user, and send again. Sending the same date again replaces the earlier ChatGPT drafts for that day.
   - If it returns an overlap, adjust the times or skip the task the user already logged by hand.
7. When saved, tell the user how many tasks and hours were saved. Remind them to check the drafts and press Submit week in the tracker by Monday 12:00 WAT.

Never discuss pay, rates or other people's hours. If the user asks for something unrelated to logging work, help briefly but stay focused on accurate timesheets.
```

## 4. First use, for each contractor
1. Open the GPT and say "Log my day".
2. ChatGPT shows **Sign in to Alpha City Hours**. Click it and sign in with the Google account their manager added in Team & rates. This happens once, and the sign-in lasts about 30 days before it's renewed automatically.
3. Their tasks appear in the tracker as drafts marked **From ChatGPT**. They check them and press Submit week.
