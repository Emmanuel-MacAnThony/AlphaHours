// Alpha City Hours — server side (Cloud Functions for Firebase, 2nd gen).
//  /api/openapi.json        Action schema for the ChatGPT custom GPT
//  /api/oauth/*             Sign-in for ChatGPT (each contractor signs in once with Google)
//  /api/reports             ChatGPT sends a day's tasks here
//  /api/me                  Who am I + hours this week (for the GPT)
//  /api/admin/*             Managers: run scoring or Slack import now
// Scheduled: nightly scoring, Slack report import, Slack reminders.
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import express from 'express';
import crypto from 'node:crypto';
import { validateReport, overlapProblems, dayTotals, scoreDays, templateFeedback, todayWAT, addDays, weekStart, dow, isUrl } from './lib.js';

initializeApp();
const db = getFirestore();
const REGION = 'europe-west1';

// ---- configuration (set at deploy; see README) ----
const OAUTH_CLIENT_ID = defineString('OAUTH_CLIENT_ID', { default: 'alpha-city-gpt' });
const OAUTH_CLIENT_SECRET = defineSecret('OAUTH_CLIENT_SECRET');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');   // "none" to switch off AI parsing/feedback
const OPENAI_MODEL = defineString('OPENAI_MODEL', { default: 'gpt-4o-mini' });
const SLACK_BOT_TOKEN = defineSecret('SLACK_BOT_TOKEN'); // "none" to switch off Slack
const SLACK_CHANNEL_ID = defineString('SLACK_CHANNEL_ID', { default: '' });
const APP_URL = defineString('APP_URL', { default: '' }); // e.g. https://hours.yourcompany.com
const on = v => { const x = (v || '').trim(); return x && x !== 'none' ? x : ''; };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = () => crypto.randomBytes(32).toString('base64url');
const lower = e => (e || '').trim().toLowerCase();

async function contractorFor(email) {
  const m = await db.doc(`members/${lower(email)}`).get();
  if (!m.exists) return null;
  const id = m.data().contractorId;
  const r = await db.doc(`roster/${id}`).get();
  if (!r.exists || r.data().active === false) return null;
  return { id, ...r.data() };
}
const isManager = async email => (await db.doc(`managers/${lower(email)}`).get()).exists;

// ---- entries ----
async function entriesFor({ contractorId, date, month, from, to }) {
  let q = db.collection('entries');
  if (contractorId) q = q.where('contractorId', '==', contractorId);
  if (date) q = q.where('date', '==', date);
  if (month) q = q.where('month', '==', month);
  const snap = await q.get();
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (from) rows = rows.filter(e => e.date >= from);
  if (to) rows = rows.filter(e => e.date <= to);
  return rows;
}

async function storeProofFile({ contractorId, name, mime, bytes }) {
  const allowed = /^(image\/|application\/pdf$|video\/|text\/plain$|text\/csv$)/;
  if (!allowed.test(mime || '')) throw new Error(`${name}: file type ${mime || 'unknown'} not allowed (use images, PDF, video or text)`);
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`${name}: over 20 MB`);
  const bucket = getStorage().bucket();
  const safe = (name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `proofs/imported/${contractorId}/${Date.now()}-${safe}`;
  const token = crypto.randomUUID();
  await bucket.file(path).save(bytes, { contentType: mime, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { id: path, url, name: safe, type: mime };
}

async function fetchBytes(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 20 * 1024 * 1024) throw new Error('over 20 MB');
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] };
}

/**
 * Save a validated day for a contractor. Earlier drafts from the same source for that day are replaced,
 * so re-sending a corrected report doesn't duplicate tasks. Returns { saved, hours } or throws { problems }.
 */
async function saveDay({ contractor, report, files, source }) {
  const existing = (await entriesFor({ contractorId: contractor.id, date: report.date })).filter(e => e.status !== 'rejected');
  const replaceable = existing.filter(e => e.source === source && e.status === 'draft');
  const keep = existing.filter(e => !replaceable.includes(e));
  const problems = overlapProblems(report.tasks, keep);
  if (problems.length) throw { problems };
  const batch = db.batch();
  replaceable.forEach(e => batch.delete(db.doc(`entries/${e.id}`)));
  const now = new Date().toISOString();
  for (const t of report.tasks) {
    const ref = db.collection('entries').doc();
    batch.set(ref, {
      contractorId: contractor.id, date: report.date, month: report.date.slice(0, 7),
      start: t.start, end: t.end, hours: t.hours, project: t.project, task: t.task,
      outputs: t.outputs, outputType: t.outputType || '',
      proofLink: t.proofLinks[0] || '', proofLinks: t.proofLinks,
      proofFiles: t.fileNames.map(n => files[n]).filter(Boolean),
      status: 'draft', reason: '', submittedAt: null, source, createdAt: now,
    });
  }
  await batch.commit();
  return { saved: report.tasks.length, hours: Math.round(report.tasks.reduce((s, t) => s + t.hours, 0) * 100) / 100, replaced: replaceable.length };
}

// ---- OpenAI (optional) ----
async function openai(messages, { json = false } = {}) {
  const key = on(OPENAI_API_KEY.value()); if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL.value(), messages, temperature: 0.2, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!res.ok) { logger.warn('OpenAI error', res.status, await res.text()); return null; }
  const out = (await res.json()).choices?.[0]?.message?.content || '';
  if (!json) return out.trim();
  try { return JSON.parse(out); } catch { return null; }
}

// ---- Slack (optional) ----
async function slack(method, body) {
  const token = on(SLACK_BOT_TOKEN.value()); if (!token) return null;
  const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) logger.warn('Slack error', method, data.error);
  return data;
}
async function slackMention(email) {
  const r = await slack('users.lookupByEmail', { email }).catch(() => null);
  return r?.ok ? `<@${r.user.id}>` : null;
}

// ---- scoring ----
async function runScoring(dates) {
  const results = [];
  for (const date of dates) {
    const baseline = dayTotals(await entriesFor({ from: addDays(date, -14), to: addDays(date, -1) }).then(rows => rows.filter(e => e.status === 'approved' || e.status === 'submitted')));
    const target = dayTotals((await entriesFor({ date })).filter(e => e.status !== 'rejected'));
    const scored = scoreDays(target, baseline);
    for (const s of scored) {
      const tasks = target.find(d => d.contractorId === s.contractorId).tasks;
      let feedback = null;
      if (s.score != null) {
        feedback = await openai([
          { role: 'system', content: 'You give short, fair, specific feedback to an hourly contractor at Alpha City about one day of work. Two sentences max. Focus on output volume and output per hour versus the team typical rate, and proof gaps. Never mention pay, salary or rates. Plain English, no emoji.' },
          { role: 'user', content: JSON.stringify({ metrics: s, tasks: tasks.map(t => ({ time: `${t.start}-${t.end}`, project: t.project, task: t.task, outputs: t.outputs, outputType: t.outputType })) }) },
        ]).catch(() => null);
      }
      const doc = { ...s, feedback: feedback || templateFeedback(s), scoredAt: new Date().toISOString() };
      await db.doc(`scores/${s.contractorId}_${s.date}`).set(doc);
      results.push(doc);
    }
  }
  return results;
}

// ---- Slack report import ----
const REPORT_PROMPT = (today) => `You turn a contractor's Slack daily work report into JSON for a timesheet.
Today is ${today} (Africa/Lagos). Return {"isReport": boolean, "date": "YYYY-MM-DD", "tasks": [{"start":"HH:MM","end":"HH:MM","project":"","task":"","outputs":0,"outputType":"","proofLinks":[]}]}.
Only set isReport true if the message describes work done with times. Use 24-hour times. "outputs" is how many concrete things were produced (emails sent, candidates screened, calls made, documents written). Copy any https links mentioned for a task into its proofLinks. Never invent tasks, times or links.`;

async function runSlackImport() {
  const channel = SLACK_CHANNEL_ID.value();
  if (!on(SLACK_BOT_TOKEN.value()) || !channel || !on(OPENAI_API_KEY.value())) return { skipped: 'Slack import needs SLACK_BOT_TOKEN, SLACK_CHANNEL_ID and OPENAI_API_KEY' };
  const stateRef = db.doc('slackState/main');
  const state = (await stateRef.get()).data() || {};
  const oldest = state.lastTs || String(Math.floor(Date.now() / 1000) - 86400);
  const hist = await slack('conversations.history', { channel, oldest, limit: 100 });
  if (!hist?.ok) return { error: hist?.error || 'history failed' };
  const msgs = (hist.messages || []).filter(m => !m.subtype && !m.bot_id && (m.text || '').length > 20).sort((a, b) => Number(a.ts) - Number(b.ts));
  let last = oldest, handled = 0;
  for (const m of msgs) {
    last = m.ts;
    const info = await slack('users.info', { user: m.user });
    const email = info?.user?.profile?.email;
    const contractor = email && await contractorFor(email);
    if (!contractor) continue;
    const today = todayWAT();
    const parsed = await openai([{ role: 'system', content: REPORT_PROMPT(today) }, { role: 'user', content: m.text }], { json: true });
    if (!parsed?.isReport) continue;
    // Files attached to the Slack message become proof for every task that has no link.
    const files = {}; const names = [];
    for (const f of m.files || []) {
      try {
        const { bytes, mime } = await fetchBytes(f.url_private_download || f.url_private, { Authorization: `Bearer ${on(SLACK_BOT_TOKEN.value())}` });
        const stored = await storeProofFile({ contractorId: contractor.id, name: f.name, mime: f.mimetype || mime, bytes });
        files[stored.name] = stored; names.push(stored.name);
      } catch (e) { logger.warn('Slack file skipped', e.message); }
    }
    (parsed.tasks || []).forEach(t => { if (!(t.proofLinks || []).some(isUrl)) t.fileNames = names; });
    const report = validateReport(parsed, { fileNames: names });
    let reply;
    if (report.problems.length) reply = `I couldn't log this yet:\n• ${report.problems.join('\n• ')}\nPlease post a corrected report, or log it in the tracker.`;
    else {
      try { const r = await saveDay({ contractor, report, files, source: 'slack' }); reply = `Logged ${r.saved} task${r.saved > 1 ? 's' : ''} (${r.hours} h) for ${report.date} as drafts. Check them and press Submit week in the tracker by Monday 12:00 WAT.`; }
      catch (e) { reply = `I couldn't log this yet:\n• ${(e.problems || [e.message]).join('\n• ')}`; }
    }
    await slack('chat.postMessage', { channel, thread_ts: m.ts, text: reply });
    handled++;
  }
  await stateRef.set({ lastTs: last, ranAt: new Date().toISOString() }, { merge: true });
  return { handled };
}

// ---- reminders (hours only, never pay) ----
async function activeRoster() {
  const snap = await db.collection('roster').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.active !== false);
}
async function runReminder(kind) {
  const channel = SLACK_CHANNEL_ID.value();
  if (!on(SLACK_BOT_TOKEN.value()) || !channel) return { skipped: 'Slack not configured' };
  const today = todayWAT(); const roster = await activeRoster();
  const tag = async r => (r.email && await slackMention(r.email)) || r.name;
  const appUrl = APP_URL.value();
  let text = null;
  if (kind === 'friday') {
    const ws = weekStart(today); const rows = await entriesFor({ from: ws, to: today });
    const behind = roster.filter(r => new Set(rows.filter(e => e.contractorId === r.id && e.status !== 'rejected').map(e => e.date)).size < 3);
    if (behind.length) text = `Reminder: please log this week's hours (Mon ${ws} to Sun ${addDays(ws, 6)}). The week is due Monday 12:00 WAT. ${(await Promise.all(behind.map(tag))).join(', ')}${appUrl ? `\n${appUrl}` : ''}`;
  }
  if (kind === 'monday') {
    const ws = weekStart(addDays(today, -7)); const rows = await entriesFor({ from: ws, to: addDays(ws, 6) });
    const behind = roster.filter(r => { const mine = rows.filter(e => e.contractorId === r.id); return !mine.length || mine.some(e => e.status === 'draft'); });
    if (behind.length) text = `Final reminder: last week's timesheet is due today at 12:00 WAT. Check your entries and press Submit week. ${(await Promise.all(behind.map(tag))).join(', ')}`;
  }
  if (kind === 'tuesday') {
    const rows = await entriesFor({ from: addDays(today, -35), to: today });
    const pending = rows.filter(e => e.status === 'submitted');
    if (pending.length) {
      const people = new Set(pending.map(e => e.contractorId)).size;
      const mgrs = (await db.collection('managers').get()).docs.map(d => d.id);
      const tags = (await Promise.all(mgrs.map(slackMention))).filter(Boolean).join(' ');
      text = `${tags} ${pending.length} entries (${Math.round(pending.reduce((s, e) => s + e.hours, 0) * 10) / 10} h) from ${people} ${people > 1 ? 'people' : 'person'} are waiting for approval. Deadline Wed 17:00 WAT.`.trim();
    }
  }
  if (kind === 'summary') {
    const ws = weekStart(addDays(today, -7)); const rows = (await entriesFor({ from: ws, to: addDays(ws, 6) })).filter(e => e.status !== 'rejected');
    const lines = roster.map(r => { const mine = rows.filter(e => e.contractorId === r.id); return `• ${r.name}: ${Math.round(mine.reduce((s, e) => s + e.hours, 0) * 10) / 10} h, ${mine.reduce((s, e) => s + (e.outputs || 0), 0)} outputs`; });
    text = `Week of ${ws}: hours logged\n${lines.join('\n')}`;
  }
  if (text) await slack('chat.postMessage', { channel, text });
  return { posted: !!text };
}

// ---- HTTP API ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
const base = req => on(APP_URL.value()) || `https://${req.get('x-forwarded-host') || req.get('host')}`;
const allowedRedirect = uri => { try { const u = new URL(uri); return u.protocol === 'https:' && ['chat.openai.com', 'chatgpt.com'].includes(u.hostname) && u.pathname.startsWith('/aip/'); } catch { return false; } };

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state = '', response_type } = req.query;
  if (client_id !== OAUTH_CLIENT_ID.value() || response_type !== 'code' || !allowedRedirect(redirect_uri)) return res.status(400).send('Invalid sign-in request.');
  const q = new URLSearchParams({ client_id, redirect_uri, state });
  res.redirect(302, `/connect.html?${q}`);
});

app.post('/api/oauth/approve', async (req, res) => {
  const { idToken, client_id, redirect_uri, state = '' } = req.body || {};
  if (client_id !== OAUTH_CLIENT_ID.value() || !allowedRedirect(redirect_uri)) return res.status(400).json({ error: 'Invalid sign-in request.' });
  let user; try { user = await getAuth().verifyIdToken(idToken); } catch { return res.status(401).json({ error: 'Your Google sign-in expired. Try again.' }); }
  if (!user.email_verified) return res.status(403).json({ error: 'Use a verified Google account.' });
  const contractor = await contractorFor(user.email);
  if (!contractor) return res.status(403).json({ error: `${user.email} isn't set up as a contractor in the tracker. Ask Mary Jane or Bradford to add it.` });
  const code = rand();
  await db.doc(`oauthCodes/${sha(code)}`).set({ email: lower(user.email), contractorId: contractor.id, redirect_uri, expiresAt: Date.now() + 10 * 60e3 });
  const u = new URL(redirect_uri); u.searchParams.set('code', code); if (state) u.searchParams.set('state', state);
  res.json({ redirect: u.toString(), name: contractor.name });
});

app.post('/api/oauth/token', async (req, res) => {
  let { client_id, client_secret } = req.body || {};
  const basic = /^Basic (.+)$/i.exec(req.get('authorization') || '');
  if (basic) [client_id, client_secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
  const secret = OAUTH_CLIENT_SECRET.value();
  const okSecret = client_secret && secret && client_secret.length === secret.length && crypto.timingSafeEqual(Buffer.from(client_secret), Buffer.from(secret));
  if (client_id !== OAUTH_CLIENT_ID.value() || !okSecret) return res.status(401).json({ error: 'invalid_client' });
  const { grant_type } = req.body || {};
  let grant;
  if (grant_type === 'authorization_code') {
    const ref = db.doc(`oauthCodes/${sha(req.body.code || '')}`); const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'invalid_grant' });
    const c = snap.data(); await ref.delete();
    if (c.expiresAt < Date.now() || (req.body.redirect_uri && req.body.redirect_uri !== c.redirect_uri)) return res.status(400).json({ error: 'invalid_grant' });
    grant = { email: c.email, contractorId: c.contractorId };
  } else if (grant_type === 'refresh_token') {
    const snap = await db.doc(`oauthRefresh/${sha(req.body.refresh_token || '')}`).get();
    if (!snap.exists) return res.status(400).json({ error: 'invalid_grant' });
    grant = { email: snap.data().email, contractorId: snap.data().contractorId };
  } else return res.status(400).json({ error: 'unsupported_grant_type' });
  if (!(await contractorFor(grant.email))) return res.status(400).json({ error: 'invalid_grant' });
  const access = rand(), refresh = rand(), ttl = 30 * 86400;
  await db.doc(`oauthTokens/${sha(access)}`).set({ ...grant, expiresAt: Date.now() + ttl * 1000, createdAt: new Date().toISOString() });
  await db.doc(`oauthRefresh/${sha(refresh)}`).set({ ...grant, createdAt: new Date().toISOString() });
  res.json({ access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh });
});

async function bearer(req, res, next) {
  const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Sign in to Alpha City Hours first.' });
  const snap = await db.doc(`oauthTokens/${sha(m[1])}`).get();
  if (!snap.exists || snap.data().expiresAt < Date.now()) return res.status(401).json({ error: 'Your sign-in expired. Sign in again.' });
  const contractor = await contractorFor(snap.data().email);
  if (!contractor) return res.status(403).json({ error: 'Your account is no longer active in the tracker.' });
  req.contractor = contractor; next();
}

app.get('/api/me', bearer, async (req, res) => {
  const today = todayWAT(); const ws = weekStart(today);
  const rows = (await entriesFor({ contractorId: req.contractor.id, from: ws, to: today })).filter(e => e.status !== 'rejected');
  res.json({ name: req.contractor.name, today, weekStart: ws, hoursThisWeek: Math.round(rows.reduce((s, e) => s + e.hours, 0) * 100) / 100, daysLoggedThisWeek: new Set(rows.map(e => e.date)).size, trackerUrl: base(req) });
});

app.post('/api/reports', bearer, async (req, res) => {
  const body = req.body || {};
  // Files the user attached in ChatGPT arrive as openaiFileIdRefs with temporary download links.
  const files = {}; const fileProblems = [];
  for (const f of (Array.isArray(body.openaiFileIdRefs) ? body.openaiFileIdRefs : []).slice(0, 10)) {
    try {
      if (!/^https:\/\//.test(f.download_link || '')) throw new Error('missing download link');
      const { bytes, mime } = await fetchBytes(f.download_link);
      const stored = await storeProofFile({ contractorId: req.contractor.id, name: f.name, mime: f.mime_type || mime, bytes });
      files[f.name] = stored;
    } catch (e) { fileProblems.push(`${f?.name || 'file'}: ${e.message}`); }
  }
  const report = validateReport(body, { fileNames: Object.keys(files) });
  const problems = fileProblems.concat(report.problems);
  if (problems.length) return res.status(400).json({ error: 'The report was not saved. Fix these and send it again.', problems });
  try {
    const r = await saveDay({ contractor: req.contractor, report, files, source: 'chatgpt' });
    res.json({ ok: true, ...r, date: report.date, message: `Saved ${r.saved} task${r.saved > 1 ? 's' : ''} (${r.hours} h) for ${report.date} as drafts. ${req.contractor.name} should check them and press Submit week by Monday 12:00 WAT.`, trackerUrl: base(req) });
  } catch (e) {
    if (e.problems) return res.status(409).json({ error: 'The report was not saved.', problems: e.problems });
    logger.error(e); res.status(500).json({ error: 'Something went wrong saving the report. Try again in a minute.' });
  }
});

async function managerOnly(req, res, next) {
  const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
  try { const u = await getAuth().verifyIdToken(m?.[1] || ''); if (await isManager(u.email)) return next(); } catch {}
  res.status(403).json({ error: 'Managers only.' });
}
app.post('/api/admin/score', managerOnly, async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : todayWAT();
  res.json({ scored: (await runScoring([date])).length, date });
});
app.post('/api/admin/slack-import', managerOnly, async (req, res) => res.json(await runSlackImport()));

app.get('/api/openapi.json', (req, res) => res.json(openapi(base(req))));

function openapi(server) {
  const task = { type: 'object', required: ['start', 'end', 'project', 'task', 'outputs'], properties: {
    start: { type: 'string', description: 'Start time, 24-hour HH:MM, Lagos time' },
    end: { type: 'string', description: 'End time, 24-hour HH:MM, after start' },
    project: { type: 'string', description: 'Project or client, e.g. Alpha City' },
    task: { type: 'string', description: 'What was done, specific (at least 10 characters)' },
    outputs: { type: 'integer', description: 'How many concrete outputs: emails sent, candidates screened, calls made, documents produced, meetings held' },
    outputType: { type: 'string', description: 'Kind of output, e.g. emails, calls, profiles screened' },
    proofLinks: { type: 'array', items: { type: 'string' }, description: 'https links proving the work: Gmail message, Drive file, Slack message' },
    fileNames: { type: 'array', items: { type: 'string' }, description: 'Names of files in openaiFileIdRefs that prove this task (screenshots of calls, WhatsApp, meetings)' },
  } };
  return {
    openapi: '3.1.0',
    info: { title: 'Alpha City Hours', version: '2.0.0', description: 'Send a contractor\'s daily timesheet to the Alpha City Hours Tracker.' },
    servers: [{ url: server }],
    paths: {
      '/api/me': { get: { operationId: 'getMe', summary: 'Who is signed in, today\'s date (Lagos) and hours logged this week', responses: { 200: { description: 'OK' } } } },
      '/api/reports': { post: { operationId: 'submitDailyReport', summary: 'Save one day of tasks as drafts in the tracker. Re-sending the same date replaces earlier ChatGPT drafts for that date.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['date', 'tasks'], properties: {
          date: { type: 'string', description: 'The work date, YYYY-MM-DD' },
          tasks: { type: 'array', items: task },
          openaiFileIdRefs: { type: 'array', items: { type: 'string' }, description: 'Screenshots or files the user attached as proof' },
        } } } } },
        responses: { 200: { description: 'Saved' }, 400: { description: 'Problems to fix; read "problems" and ask the user' }, 409: { description: 'Overlaps with hours already in the tracker' } } } },
    },
    components: { schemas: {} },
  };
}

const common = { region: REGION, secrets: [OAUTH_CLIENT_SECRET, OPENAI_API_KEY, SLACK_BOT_TOKEN] };
export const api = onRequest({ ...common, timeoutSeconds: 120, memory: '512MiB' }, app);
export const scoreNightly = onSchedule({ ...common, schedule: '30 23 * * *', timeZone: 'Africa/Lagos', timeoutSeconds: 540 }, async () => { const t = todayWAT(); await runScoring([addDays(t, -1), t]); });
export const slackImport = onSchedule({ ...common, schedule: 'every 30 minutes', timeZone: 'Africa/Lagos' }, async () => { logger.info(await runSlackImport()); });
export const reminderFriday = onSchedule({ ...common, schedule: '0 16 * * 5', timeZone: 'Africa/Lagos' }, async () => { await runReminder('friday'); });
export const reminderMonday = onSchedule({ ...common, schedule: '0 9 * * 1', timeZone: 'Africa/Lagos' }, async () => { await runReminder('monday'); });
export const reminderTuesday = onSchedule({ ...common, schedule: '0 10 * * 2', timeZone: 'Africa/Lagos' }, async () => { await runReminder('tuesday'); });
export const weeklySummary = onSchedule({ ...common, schedule: '0 8 * * 1', timeZone: 'Africa/Lagos' }, async () => { await runReminder('summary'); });

// exported for tests
export const _internal = { app, runScoring, saveDay, contractorFor, openapi, dow };
