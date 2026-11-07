# Ded Notes

A private, cross-platform notes PWA built with Next.js, Firebase Google Authentication and Cloud Firestore. One responsive app works in desktop and mobile browsers and can be installed on supported devices.

## Included

- Google sign-in
- Private per-user Firestore notes and folders
- Real-time updates across signed-in devices
- Firestore persistent local cache for offline reads/writes (browser support and storage policies apply)
- Rich-text editing: paragraphs, headings, bold, italic, bullet/numbered lists, checklists and links
- Search, pinned notes, folders, archive and trash
- Responsive custom interface with light/dark themes
- PWA manifest and install metadata

## 1. Create the Firebase project

1. Open [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Add a **Web app** and copy its Firebase configuration.
3. In **Authentication → Sign-in method**, enable **Google**.
4. In **Authentication → Settings → Authorized domains**, add your deployed domain (and `localhost` for local development).
5. In **Firestore Database**, create a database. Start in production mode.
6. Open **Firestore → Rules**, paste the contents of `firestore.rules`, and publish.

## 2. Configure the app

```bash
cp .env.example .env.local
```

Fill `.env.local` with the web app configuration from Firebase. The values are public client configuration, not admin credentials. Never put a service-account JSON or private server key in a `NEXT_PUBLIC_` variable.

## 3. Run locally

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## 4. Deploy

The app can be deployed to Vercel, Firebase App Hosting, or another platform that supports Next.js. Add the same `NEXT_PUBLIC_FIREBASE_*` variables to the hosting provider, deploy, then add the production domain to Firebase Authentication's authorized domains.

For a production PWA, serve over HTTPS. On iOS, open the site in Safari and use **Share → Add to Home Screen**. On Android/desktop Chrome or Edge, use the browser's **Install app** option when available.

## Data model

- `notes/{noteId}`: `ownerId`, `title`, `content` (TipTap HTML), `folderId`, `pinned`, `archived`, `deleted`, `tags`, `createdAt`, `updatedAt`.
- `folders/{folderId}`: `ownerId`, `name`, `createdAt`.

Every document is scoped to the Firebase Authentication UID. The included rules enforce owner-only access and prevent changing ownership on update.

## Important production notes

- Configure Firebase billing/quotas and review Firestore usage before broad use. This starter is intended for a personal workspace.
- Firestore offline persistence stores cached note content in the browser's local storage database. Use device-level screen locks and do not use a shared/public browser profile.
- Real-time synchronization is near-instant while online; offline edits are queued and synchronized when connectivity returns. If the same note is edited simultaneously on multiple devices, Firestore's last-write-wins behavior applies to the document. This initial version does not implement collaborative character-level merging or version history.
- Back up important notes periodically. A future iteration can add export/import, note version history, attachments and conflict recovery.
- The starter uses a browser Google popup flow. For strict production CSP, custom domains, or embedded webviews, review Firebase Auth's recommended redirect/popup configuration for the target environment.
