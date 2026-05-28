---
name: html-firebase-app
description: Use this skill whenever Jason wants to build a web app, internal tool, browser-based utility, dashboard, tracker, or any "small app I can use in a browser" — especially when the project will live on GitHub Pages with Firebase as the backend. Triggers on phrases like "build me a tool that...", "let's make a web app for...", "I need a simple app to...", "track X in a web interface", or any mention of GitHub Pages, Firebase, Firestore, or Google sign-in. Also triggers when the user hands over a spec document (e.g. Story_Bible_App_Spec, PegaWorld-style specs) for an HTML+Firebase project. Use this even when the user doesn't explicitly say "HTML" or "Firebase" — if the shape of the request is "a thing in a browser, multiple people use it, data persists," this is the right skill. This skill bakes in Jason's established defaults (vanilla HTML/CSS/JS, split files, plain CSS, Google sign-in, GitHub Pages deployment, Firestore with rules) so you don't have to rediscover them every project.
---

# HTML + Firebase + GitHub Pages App

This skill captures Jason's established pattern for building small-to-medium web apps. The pattern has been used for the PegaWorld event production app, the Star Trek Captain's Log companion, the propane GIS tool, wrestling TTRPG references, and many others. It's optimized for:

- **Fast deployment** — push to GitHub, GitHub Pages serves it, done
- **No build step** — vanilla HTML/CSS/JS that runs as-is in a browser
- **Real persistence** — Firestore handles data, Firebase Auth handles users
- **Multiple views from one backend** — admin views, presenter views, public views all reading the same Firestore data
- **Iteration without ceremony** — change a file, push, refresh

The defaults below exist because Jason has tried alternatives and these stuck. Don't change them without asking — the consistency across projects is itself valuable, because muscle memory carries between projects.

## Default Stack

These are the defaults. Pick differently only if there's a real reason and you've checked with Jason.

| Layer | Default | Why |
|---|---|---|
| Hosting | GitHub Pages | Free, simple, fast push-to-deploy |
| Frontend | Vanilla HTML/CSS/JS | No build step means GitHub Pages "just works" |
| File layout | Split (`index.html`, `app.js`, `style.css`) | Easier to scan and edit than one giant file |
| CSS | Plain CSS (no framework) | Jason has a feel for hand-written CSS and doesn't want Tailwind classes cluttering the markup |
| Database | Firestore | Real-time sync is the killer feature; pairs with Auth |
| Auth | Google sign-in via Firebase Auth | One provider, the one everyone already has |
| Config | Committed to repo, protected by Firestore rules | Web Firebase config is not a secret — see "Firebase Config" below |
| Module loading | Firebase via CDN, ES modules | Avoids npm/build entirely |

## What to Build (the conversation before the code)

Before writing any code, get clear answers to these. If the user handed you a spec doc, check it covers all of these — if it doesn't, ask, because guessing leads to rework.

1. **Views.** How many separate interfaces are there? (e.g. one admin view + one presenter view + one public view = 3 separate HTML files). Each view becomes its own `.html` file sharing the same Firestore backend.
2. **Data model.** What Firestore collections exist, what's in each document, what's the relationship between them? Draw this out as a quick sketch — it pays for itself the first time you have to debug a query.
3. **Who can write what.** Is this "any signed-in Google user can read/write" (simplest), "only specific emails can write" (event tools, internal tools), or "users only see/edit their own documents" (per-user apps)? This determines your Firestore rules.
4. **Real-time or fetch-once?** Lists that change while you watch (event sessions, leaderboards) want `onSnapshot`. Static reference data wants `getDocs`. Don't put `onSnapshot` on everything by reflex — listener leaks are a real pain.
5. **External integrations.** Does this need to call out to anything (Brightcove, Mapbox, an external API)? CORS matters. If the API doesn't support browser calls, you need a proxy, and GitHub Pages can't host one — so you'll need Cloud Functions or a separate service. Flag this early.

Lock these answers down before scaffolding. If you're building from a spec doc and any of the five are unclear, ask before you start writing files — it's much cheaper than refactoring.

## File Layout

For a single-view app:
```
project/
├── index.html
├── app.js
├── style.css
├── firebase-config.js
├── firestore.rules
├── README.md
└── DEPLOY.md
```

For a multi-view app:
```
project/
├── index.html          (landing or default view)
├── admin.html
├── presenter.html
├── js/
│   ├── admin.js
│   ├── presenter.js
│   └── shared.js       (auth, firebase init, shared helpers)
├── css/
│   ├── shared.css
│   ├── admin.css
│   └── presenter.css
├── firebase-config.js
├── firestore.rules
├── README.md
└── DEPLOY.md
```

The shared.js pattern is important — Firebase init and auth state belong in one place so every view behaves consistently.

## Firebase Config

The Firebase web config (apiKey, projectId, authDomain, etc.) is **not a secret**. Google's documentation explicitly says it's safe to commit. It identifies your Firebase project the same way a URL identifies a website. The actual security boundary is Firestore rules.

So: commit `firebase-config.js` directly. No `.env`, no gitignore dance, no example-file pattern. The config goes in the repo and Claude Code can paste it in when Jason provides the values.

```javascript
// firebase-config.js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "project-name.firebaseapp.com",
  projectId: "project-name",
  storageBucket: "project-name.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

**Caveat to flag to Jason:** if the app will ever hold data from external users he doesn't know, revisit Firebase App Check. For internal tools, event apps, and personal projects, strict Firestore rules are enough.

## Firestore Rules — Required

Every project gets a `firestore.rules` file in the repo. This is non-negotiable. The default "test mode" rules Firebase suggests are open to the world for 30 days and then lock everyone out. That has bitten Jason before.

Start from one of these patterns based on the answer to question 3 above:

**Pattern A — Any signed-in Google user can read/write** (simplest, fine for personal tools):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

**Pattern B — Specific allowlisted emails can write, anyone signed in can read** (event tools, team tools):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.token.email in [
        'jason@example.com',
        'teammate@example.com'
      ];
    }
  }
}
```

**Pattern C — Users only access their own documents** (per-user apps):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /shared/{document=**} {
      allow read: if request.auth != null;
    }
  }
}
```

Tell Jason he needs to paste these into the Firebase console under Firestore → Rules → Publish. The `firestore.rules` file in the repo is the source of truth — the console is the deployment target. (Yes, this is annoying. The Firebase CLI can deploy them automatically with `firebase deploy --only firestore:rules`, but that adds a tooling dependency. For most projects it's not worth it.)

## Auth Pattern

Use Firebase Auth with Google as the only provider. The flow:

```javascript
// shared.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.x.x/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.x.x/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export function signIn() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}
```

Every page that does anything authenticated should:
1. Call `onAuthChange` on load
2. Show a sign-in button if no user
3. Show app UI + sign-out button if signed in

Don't render the app UI before auth state is known — flickering between "signed out" and "signed in" looks terrible and causes weird race conditions with Firestore listeners.

## Firestore Patterns

Use the modular SDK from CDN, not the compat library:
```javascript
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc }
  from "https://www.gstatic.com/firebasejs/10.x.x/firebase-firestore.js";
```

**Listener hygiene.** Every `onSnapshot` returns an unsubscribe function. Store it. Call it when the user signs out or navigates away. Leaked listeners are the #1 source of mystery bugs in this stack.

```javascript
let unsubscribeSessions = null;

function subscribeToSessions() {
  if (unsubscribeSessions) unsubscribeSessions(); // clean up first
  unsubscribeSessions = onSnapshot(collection(db, "sessions"), (snapshot) => {
    // render
  });
}

// On sign-out:
if (unsubscribeSessions) {
  unsubscribeSessions();
  unsubscribeSessions = null;
}
```

**Document IDs.** Let Firestore auto-generate IDs (`addDoc`) unless you have a specific reason to use a custom ID. Custom IDs are good for "one document per user" (use `auth.currentUser.uid`) and for things that need stable URLs.

**Don't over-fetch.** If you only need 20 documents, use `query(...,  limit(20))`. Firestore charges per read.

## GitHub Pages Deployment

The deployment story is dead simple but has a few gotchas. Generate a `DEPLOY.md` like this:

```markdown
# Deploying

1. Push to GitHub. The repo must be public, or you need GitHub Pro for private Pages.
2. In repo Settings → Pages, set source to "Deploy from a branch" → `main` → `/ (root)`.
3. Wait ~1 minute. Site lives at `https://USERNAME.github.io/REPO-NAME/`.
4. Add that URL to Firebase Auth's authorized domains:
   Firebase Console → Authentication → Settings → Authorized domains → Add domain.
   Without this, Google sign-in popup will fail silently.
5. Paste the Firestore rules from `firestore.rules` into:
   Firebase Console → Firestore Database → Rules → Publish.
```

## Common pitfalls (the silly little bugs)

These are things that have caught Jason or similar projects before. Worth checking before declaring "done":

- **GitHub Pages aggressive caching.** Changes can take a few minutes to appear, and sometimes a hard refresh (Cmd+Shift+R) is needed. If something looks broken after a push, wait 60 seconds and hard refresh before debugging.
- **Auth domain not authorized.** Sign-in popup opens, immediately closes, no error visible. Check authorized domains in Firebase Auth settings.
- **Test-mode rules expired.** Database silently stops accepting writes 30 days after project creation if you stayed on test rules. Always publish real rules.
- **CORS on external APIs.** Browser calls to non-CORS-enabled APIs fail with an opaque error. GitHub Pages can't proxy. If you need a proxy, that's a Cloud Function or a separate small service.
- **`onSnapshot` after sign-out.** Listener keeps firing, throws permission errors in console, sometimes triggers UI bugs. Always unsubscribe on sign-out.
- **Module script paths.** GitHub Pages serves from `/REPO-NAME/`, not `/`. Relative paths (`./app.js`) work; absolute paths (`/app.js`) break. Always use relative.
- **Firebase SDK version drift.** If you copy code from one project to another and the SDK versions don't match, weird things happen. Pin the version in CDN URLs.

## Handoff Checklist

Before telling Jason "it's ready to push," verify:

- [ ] `index.html` (and any other view HTMLs) load without console errors
- [ ] Google sign-in works
- [ ] Sign-out works
- [ ] At least one read and one write from Firestore work end-to-end
- [ ] `firestore.rules` exists in the repo and matches what's needed
- [ ] `DEPLOY.md` exists and is accurate for this project
- [ ] `README.md` explains what the app does and lists the views
- [ ] All `onSnapshot` calls have a matching unsubscribe path
- [ ] No absolute paths in `<script src=...>` or `<link href=...>`
- [ ] Firebase config is filled in (not placeholder values)

Tell Jason the three manual steps he needs to do himself:
1. Create the Firebase project + enable Google sign-in + enable Firestore
2. Paste the rules into the Firebase console
3. After deploying, add the GitHub Pages URL to authorized domains

The skill can't do these for him — they're console clicks in Firebase. But they should be the only manual things.
