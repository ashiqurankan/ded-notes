import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Object.values(config).every(Boolean);

function createDb(app: FirebaseApp): Firestore {
  // IndexedDB only exists in the browser; the server render just needs an instance.
  if (typeof window === 'undefined') return getFirestore(app);
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    // Already initialised (hot reload) or persistence unavailable (some private modes).
    try {
      return initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
    } catch {
      return getFirestore(app);
    }
  }
}

let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

// Only initialise Firebase when it is configured, so a missing .env shows the
// setup message instead of crashing with auth/invalid-api-key.
if (firebaseConfigured) {
  const app = getApps().length ? getApp() : initializeApp(config);
  authInstance = getAuth(app);
  dbInstance = createDb(app);
  // Local testing against `firebase emulators:start` (never set this on Vercel).
  if (process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === 'true' && typeof window !== 'undefined') {
    const flag = window as unknown as { __dedEmulators?: boolean };
    if (!flag.__dedEmulators) {
      flag.__dedEmulators = true;
      connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
    }
  }
}

export const auth = authInstance as Auth;
export const db = dbInstance as Firestore;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * True when Firebase Auth is served from this site's own domain (via the
 * /__/auth rewrite in next.config.ts). Redirect sign-in is only reliable on
 * Safari / iOS when this is the case.
 */
export function authOnSameDomain() {
  return typeof window !== 'undefined' && config.authDomain === window.location.host;
}
