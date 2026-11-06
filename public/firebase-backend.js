// Firebase adapter: gives the tracker the same small API it used inside Claude
// (db.doc/collection/onSnapshot, uploads, sign-in), backed by Firestore, Storage and Google sign-in.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, collection, query, where, setDoc, updateDoc, deleteDoc, getDoc, onSnapshot, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// Served from `firebase emulators:start` on this machine: use the local emulators, never a real project.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

function announce(backend) { window.__backend = backend; window.dispatchEvent(new CustomEvent('backend-ready')); }

(async () => {
  let config;
  try {
    // Firebase Hosting serves the project's web config at this reserved address.
    const res = await fetch('/__/firebase/init.json');
    if (!res.ok) throw new Error('no config');
    config = await res.json();
  } catch (e) {
    if (!LOCAL) { announce(null); return; }
    config = { apiKey: 'demo-key', projectId: 'demo-alpha-city', authDomain: 'localhost', storageBucket: 'demo-alpha-city.appspot.com' };
  }

  const app = initializeApp(config);
  const auth = getAuth(app), fs = getFirestore(app), storage = getStorage(app);
  if (LOCAL) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(fs, '127.0.0.1', 8181);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }

  const wrapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
  const wrapQuery = s => ({ docs: s.docs.map(wrapDoc), size: s.size, empty: s.empty });
  const makeQuery = (path, filters) => ({
    where: (f, op, v) => makeQuery(path, filters.concat([[f, op, v]])),
    onSnapshot: (next, err) => onSnapshot(query(collection(fs, path), ...filters.map(([f, op, v]) => where(f, op, v))), s => next(wrapQuery(s)), err),
  });
  const db = {
    doc: path => ({
      set: data => setDoc(doc(fs, path), data),
      update: data => updateDoc(doc(fs, path), data),
      delete: () => deleteDoc(doc(fs, path)),
      get: async () => wrapDoc(await getDoc(doc(fs, path))),
      onSnapshot: (next, err) => onSnapshot(doc(fs, path), s => next(wrapDoc(s)), err),
    }),
    collection: path => makeQuery(path, []),
  };

  const assets = {
    async upload(file) {
      const user = auth.currentUser; if (!user) throw { code: 'not_signed_in' };
      const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `proofs/${user.uid}/${Date.now()}-${safe}`;
      const r = ref(storage, path);
      try { await uploadBytes(r, file, { contentType: file.type || 'application/octet-stream' }); }
      catch (e) { throw { code: /unauthorized/.test(e.code) ? 'unsupported_type' : 'upload_failed', message: e.message }; }
      return { id: path, url: await getDownloadURL(r), contentType: file.type };
    },
  };

  announce({
    db, assets,
    signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
    onUser: cb => onAuthStateChanged(auth, cb),
    // A manager has a document at managers/<email>; a contractor has members/<email> -> { contractorId }.
    async roleFor(email) {
      const e = (email || '').toLowerCase();
      const [m, mem] = await Promise.all([getDoc(doc(fs, 'managers', e)).catch(() => null), getDoc(doc(fs, 'members', e)).catch(() => null)]);
      return { isManager: !!(m && m.exists()), contractorId: mem && mem.exists() ? mem.data().contractorId : null };
    },
  });
})();
