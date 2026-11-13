# ded - notes

A private, cross-platform notes app (installable PWA) built with Next.js, Firebase Google Authentication and Cloud Firestore, hosted on Vercel. One macOS-style interface everywhere: Mac, Windows, Linux, ChromeOS, iPhone, iPad and Android, in the browser or installed to the home screen / dock.

## Features

- Google sign-in (popup on desktop, redirect on phones / installed apps when served from your own domain)
- Private per-user notes and folders, real-time sync across devices, offline editing with honest sync status
- Rich text: headings, bold, italic, strikethrough, inline code, links, bullet / numbered / check lists, quotes, code blocks, text size, undo/redo, Markdown shortcuts
- Pinned notes (shown first, reorderable), folders (create / rename / reorder / delete), tags, archive, Recently deleted (auto-emptied after 30 days)
- Sort by date edited / created / title, debounced search with highlights, ⌘K / Ctrl+K command palette
- Multi-select with bulk pin / move / archive / delete; right-click (desktop) or long-press (touch) menus; swipe left to trash, right to archive
- Undo for delete and archive, version history (automatic snapshots + copies of conflicting edits from another device)
- Export a note as PDF, page images or one long image (share sheet on phones); export everything as Markdown (.zip) or JSON; import .md / .txt / .html / .json / .zip
- PWA: offline app shell, install button, “New note” app shortcut, Android share target (“Share → ded notes”), update prompt
- Light / Dark / Match system, remembers your last view and note

## 1. Firebase project

1. In the [Firebase Console](https://console.firebase.google.com/) create a project and add a **Web app**; copy its config.
2. **Authentication → Sign-in method**: enable **Google**.
3. **Authentication → Settings → Authorized domains**: add your Vercel domain(s) (e.g. `ded-notes.vercel.app`, any custom domain) and `localhost`.
4. **Firestore Database**: create a database in production mode.
5. Publish the rules **and** the index (needed for fast, paginated loading):
   - Console: paste `firestore.rules` into **Firestore → Rules** and publish. For the index, open the app once — if the index is missing the browser console logs a link that creates it in one click (the app keeps working with a slower query until then). Or create it under **Firestore → Indexes**: collection `notes`, fields `ownerId ↑`, `deleted ↑`, `updatedAt ↓`.
   - Or with the CLI: `npx firebase-tools deploy --only firestore:rules,firestore:indexes --project <your-project-id>`

## 2. Vercel

Add these **Environment Variables** in Vercel → Project → Settings (Production and Preview), then redeploy:

```
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID
```

Do **not** set `NEXT_PUBLIC_FIREBASE_EMULATORS` on Vercel (it is for local testing only).

### Sign-in on iPhone, iPad, Safari and installed apps (recommended)

Safari and iOS block the third-party storage that Firebase's default `*.firebaseapp.com` sign-in relies on, so sign-in can fail or loop there — especially in the home-screen app. The fix is to serve Firebase Auth from your own domain; this project already proxies `/__/auth/*` to Firebase (see `next.config.ts`). To turn it on:

1. Set `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` in Vercel to your production domain, e.g. `ded-notes.vercel.app` or `notes.example.com` (no `https://`).
2. In [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials), open the **Web client (auto created by Google Service)** OAuth client and add to **Authorized redirect URIs**: `https://<your-domain>/__/auth/handler`
3. Make sure the domain is in Firebase **Authorized domains** (step 1.3) and redeploy.

Preview deployments keep working with popup sign-in from the production auth domain.

Sign-in is not possible inside in-app browsers (Instagram, Facebook, LinkedIn…) — Google blocks it. The app detects this and asks the user to open the page in Safari/Chrome.

## 3. Local development

Requires Node.js 18.18+ (20 LTS or newer recommended).

```bash
cp .env.example .env.local   # fill in the Firebase web config
npm install
npm run dev
```

Open http://localhost:3000. The service worker only runs in production builds (`npm run build && npm start`).

Testing against the Firebase emulators (no real data touched):

```bash
npx firebase-tools emulators:start --only auth,firestore --project demo-ded
NEXT_PUBLIC_FIREBASE_EMULATORS=true NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-ded NEXT_PUBLIC_FIREBASE_API_KEY=demo NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-ded.firebaseapp.com NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=demo NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1 NEXT_PUBLIC_FIREBASE_APP_ID=1:1:web:1 npm run dev
```

## Installing the app

- **iPhone / iPad**: open in Safari → Share → **Add to Home Screen** (the app's account menu shows these steps).
- **Android, Windows, macOS, Linux, ChromeOS (Chrome / Edge)**: account menu → **Install app**, or the install icon in the address bar.
- **macOS Safari 17+**: File → **Add to Dock**.

## Keyboard shortcuts

| Action | Mac | Windows / Linux |
| --- | --- | --- |
| New note | ⌥⌘N | Ctrl+Alt+N |
| Search & commands | ⌘K | Ctrl+K |
| Search this list | / | / |
| Previous / next note | ↑ / ↓ | ↑ / ↓ |
| Save now | ⌘S | Ctrl+S |
| Toggle sidebar | ⌘\\ | Ctrl+\\ |
| Move note to trash | ⌘⌫ | Ctrl+Backspace |
| Add link (in a note) | ⌘K | Ctrl+K |
| Open link | ⌘-click | Ctrl-click |

(⌘N / Ctrl+N is reserved by Chrome and Edge for “new window”, so the app uses ⌥⌘N / Ctrl+Alt+N.)

## Data model

- `notes/{noteId}`: `ownerId`, `title`, `content` (Tiptap HTML), `folderId`, `pinned`, `pinnedOrder`, `archived`, `deleted`, `deletedAt`, `tags`, `createdAt`, `updatedAt`, `deviceId`, `versionedAt`
- `notes/{noteId}/versions/{versionId}`: `ownerId`, `title`, `content`, `savedAt`, `noteUpdatedAt`, `reason` (`auto` | `conflict` | `restore`) — up to 50 kept per note
- `folders/{folderId}`: `ownerId`, `name`, `sortOrder`, `createdAt`

The rules in `firestore.rules` enforce owner-only access, prevent changing ownership, validate field types and cap note size (~900 KB).

## Notes on sync and privacy

- Edits save ~0.6 s after you stop typing, and immediately when the tab/app is hidden or closed.
- Offline edits are stored on the device and sync when you reconnect (the status shows “Offline · saved on this device”).
- If the same note is edited on two devices at once, the last save wins for the note itself, but the other device's version is kept in **Version history** and you're told about it.
- Signing out clears the offline copy of your notes from that browser (use it on shared computers). If there are unsynced offline edits, you're warned first.
- Timestamps use each device's clock; a device with a badly wrong clock can make sort order look odd.
