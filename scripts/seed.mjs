// Loads managers, contractors, rates and settings into Firestore.
// Usage: node scripts/seed.mjs --project YOUR-FIREBASE-PROJECT-ID [--file seed/data.json]
// Auth: run `gcloud auth application-default login` first (or set GOOGLE_APPLICATION_CREDENTIALS).
import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const projectId = arg('--project');
const file = arg('--file') || 'seed/data.json';
if (!projectId) { console.error('Missing --project YOUR-FIREBASE-PROJECT-ID'); process.exit(1); }

const data = JSON.parse(readFileSync(file, 'utf8'));
const bad = [...data.managers, ...Object.values(data.roster).map(r => r.email)].filter(e => !e || /REPLACE/.test(e) || !e.includes('@'));
if (bad.length) { console.error('Fill in every email in ' + file + ' first. Problems: ' + JSON.stringify(bad)); process.exit(1); }

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const batch = db.batch();
for (const email of data.managers) batch.set(db.doc(`managers/${email.toLowerCase()}`), { addedAt: new Date().toISOString() });
for (const [id, s] of Object.entries(data.settings || {})) batch.set(db.doc(`settings/${id}`), s);
for (const [id, r] of Object.entries(data.roster)) {
  const email = r.email.toLowerCase();
  batch.set(db.doc(`roster/${id}`), { ...r, email });
  batch.set(db.doc(`members/${email}`), { contractorId: id });
}
for (const [id, p] of Object.entries(data.pay)) batch.set(db.doc(`pay/${id}`), p);
for (const [id, e] of Object.entries(data.entries || {})) batch.set(db.doc(`entries/${id}`), { source: "claude-tracker", outputs: e.outputs ?? null, ...e });
await batch.commit();
console.log(`Seeded ${data.managers.length} managers, ${Object.keys(data.roster).length} contractors, ${Object.keys(data.entries || {}).length} logged entries, settings and pay.`);
