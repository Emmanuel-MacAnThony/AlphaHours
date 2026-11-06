// Pure helpers: report validation, overlap checks and scoring. No Firebase here, so it can be unit-tested.

export const TZ_OFFSET_MS = 3600e3; // WAT = UTC+1, no daylight saving
export const todayWAT = (now = Date.now()) => new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
export const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
export const weekStart = d => addDays(d, -((dow(d) + 6) % 7));
export const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? h * 60 + mi : null; };
export const pad = t => { const m = toMin(t); return m == null ? t : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export const spanH = (s, e) => { const a = toMin(s), b = toMin(e); return a == null || b == null || b <= a ? 0 : Math.round((b - a) / 60 * 100) / 100; };
export const isUrl = u => typeof u === 'string' && /^https:\/\/\S+\.\S+/i.test(u.trim());
const str = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

/**
 * Validate a daily report sent by ChatGPT or parsed from Slack.
 * body: { date, tasks: [{ start, end, project, task, outputs, outputType?, proofLinks?, fileNames? }] }
 * fileNames: names of files that came with the report (attached as proof to tasks that list them).
 * Returns { date, tasks, problems } — problems is a list of plain-English messages; empty means valid.
 */
export function validateReport(body, { fileNames = [], now = Date.now() } = {}) {
  const problems = [];
  const today = todayWAT(now);
  const date = str(body?.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) problems.push('date must be YYYY-MM-DD.');
  else if (date > today) problems.push(`date ${date} is in the future (today is ${today} WAT).`);
  else if (date < addDays(today, -35)) problems.push(`date ${date} is more than 35 days ago; ask a manager to add it.`);
  const raw = Array.isArray(body?.tasks) ? body.tasks : [];
  if (!raw.length) problems.push('add at least one task.');
  if (raw.length > 30) problems.push('a day can have at most 30 tasks.');
  const files = new Set(fileNames);
  const tasks = raw.slice(0, 30).map((t, i) => {
    const n = `Task ${i + 1}`;
    const start = pad(str(t?.start, 5)), end = pad(str(t?.end, 5));
    if (toMin(start) == null || toMin(end) == null) problems.push(`${n}: start and end must be times like 09:00.`);
    else if (toMin(end) <= toMin(start)) problems.push(`${n}: end time must be after start time.`);
    const project = str(t?.project, 120), task = str(t?.task, 500);
    if (!project) problems.push(`${n}: add the project or client.`);
    if (task.length < 10) problems.push(`${n}: describe what was done (at least 10 characters).`);
    const outputs = Number(t?.outputs);
    if (!Number.isInteger(outputs) || outputs < 0 || outputs > 500) problems.push(`${n}: outputs must be a whole number from 0 to 500.`);
    const links = (Array.isArray(t?.proofLinks) ? t.proofLinks : []).map(u => str(u, 2000)).filter(Boolean).slice(0, 5);
    links.filter(u => !isUrl(u)).forEach(u => problems.push(`${n}: proof link "${u.slice(0, 60)}" must start with https://`));
    const fileRefs = (Array.isArray(t?.fileNames) ? t.fileNames : []).map(f => str(f, 200)).filter(f => files.has(f));
    if (!links.filter(isUrl).length && !fileRefs.length) problems.push(`${n}: add proof of work (a link, or a screenshot for calls, WhatsApp and meetings).`);
    return { start, end, hours: spanH(start, end), project, task, outputs: Number.isInteger(outputs) ? outputs : 0, outputType: str(t?.outputType, 60), proofLinks: links.filter(isUrl), fileNames: fileRefs };
  });
  const sorted = tasks.filter(t => toMin(t.start) != null && toMin(t.end) > toMin(t.start)).slice().sort((a, b) => toMin(a.start) - toMin(b.start));
  for (let i = 1; i < sorted.length; i++) if (toMin(sorted[i].start) < toMin(sorted[i - 1].end)) problems.push(`times overlap: ${sorted[i - 1].start}–${sorted[i - 1].end} and ${sorted[i].start}–${sorted[i].end}.`);
  return { date, tasks, problems };
}

/** Problems for new tasks that overlap tasks already saved that day. */
export function overlapProblems(newTasks, existing) {
  const out = [];
  for (const t of newTasks) for (const e of existing) {
    if (!e.start || !e.end) continue;
    if (toMin(t.start) < toMin(e.end) && toMin(e.start) < toMin(t.end)) out.push(`${t.start}–${t.end} overlaps ${e.start}–${e.end} ("${(e.task || '').slice(0, 40)}"), already in the tracker.`);
  }
  return out;
}

export const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const band = ratio => ratio == null ? null : ratio >= 1.5 ? 5 : ratio >= 1.1 ? 4 : ratio >= 0.8 ? 3 : ratio >= 0.5 ? 2 : 1;

/** Roll entries up to one row per contractor per day (rejected entries left out). */
export function dayTotals(entries) {
  const days = new Map();
  for (const e of entries) {
    if (e.status === 'rejected') continue;
    const k = `${e.contractorId}|${e.date}`;
    const d = days.get(k) || { contractorId: e.contractorId, date: e.date, hours: 0, outputs: 0, provedHours: 0, tasks: [] };
    const h = Number(e.hours) || 0;
    d.hours += h; d.outputs += Number(e.outputs) || 0;
    if (isUrl(e.proofLink) || (e.proofFiles || []).length) d.provedHours += h;
    d.tasks.push(e); days.set(k, d);
  }
  return [...days.values()];
}

/**
 * Score each contractor-day on output volume and output per hour, compared with the team's
 * median over the baseline window. Needs at least 3 contractor-days in the baseline.
 */
export function scoreDays(targetDays, baselineDays) {
  const usable = baselineDays.filter(d => d.hours > 0);
  const enough = usable.length >= 3;
  const medPerDay = enough ? median(usable.map(d => d.outputs)) : null;
  const medPerHour = enough ? median(usable.map(d => d.outputs / d.hours)) : null;
  return targetDays.map(d => {
    const perHour = d.hours > 0 ? Math.round(d.outputs / d.hours * 100) / 100 : 0;
    const coverage = d.hours > 0 ? d.provedHours / d.hours : 0;
    const volumeScore = enough && medPerDay > 0 ? band(d.outputs / medPerDay) : null;
    const efficiencyScore = enough && medPerHour > 0 ? band(perHour / medPerHour) : null;
    const score = volumeScore && efficiencyScore ? Math.round((volumeScore + efficiencyScore) / 2) : null;
    const issues = [];
    if (coverage < 0.8) issues.push(`only ${Math.round(coverage * 100)}% of hours have proof`);
    if (d.hours > 10) issues.push(`${Math.round(d.hours * 10) / 10} h in one day`);
    if (d.outputs === 0 && d.hours >= 2) issues.push('no outputs recorded');
    const recommendation = score == null ? 'review' : score >= 3 && !issues.length ? 'approve' : 'review';
    return {
      contractorId: d.contractorId, date: d.date, month: d.date.slice(0, 7),
      hours: Math.round(d.hours * 100) / 100, outputs: d.outputs, outputsPerHour: perHour,
      proofCoverage: Math.round(coverage * 100) / 100,
      teamOutputsPerDay: medPerDay, teamOutputsPerHour: medPerHour == null ? null : Math.round(medPerHour * 100) / 100,
      volumeScore, efficiencyScore, score, issues, recommendation,
      baselineNote: enough ? null : 'Not enough team history yet (needs 3 logged days) to score.',
    };
  });
}

export function templateFeedback(s) {
  if (s.score == null) return `Logged ${s.hours} h and ${s.outputs} outputs. Scoring starts once the team has a few days of history.`;
  const vs = s.teamOutputsPerHour ? ` (team typical: ${s.teamOutputsPerHour}/h)` : '';
  let line = `${s.outputs} outputs in ${s.hours} h = ${s.outputsPerHour} per hour${vs}. Score ${s.score}/5.`;
  if (s.issues.length) line += ` To check: ${s.issues.join('; ')}.`;
  return line;
}
