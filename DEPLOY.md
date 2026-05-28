# Deploying

## One-time Firebase setup (manual — console clicks)

1. Create a Firebase project at https://console.firebase.google.com/
2. **Authentication** → Get started → Sign-in method → enable **Google**
3. **Firestore Database** → Create database → start in **production mode** (we'll paste real rules in step 5)
4. **Project Settings** → Your apps → Add app → **Web** → register, then copy the `firebaseConfig` object into `firebase-config.js` in this repo
5. **Firestore Database** → Rules → paste the contents of `firestore.rules` → Publish

## GitHub Pages

1. Push this repo to GitHub (the repo will be `storybible2`).
2. Repo Settings → Pages → Source: **Deploy from a branch** → `main` → `/ (root)` → Save.
3. Wait ~1 minute. The site will be at `https://USERNAME.github.io/storybible2/`.
4. Back in Firebase Console → **Authentication** → Settings → **Authorized domains** → Add `USERNAME.github.io`. Without this, Google sign-in popup will fail silently.

## Local dev

```
python -m http.server 8000
```

Open http://localhost:8000. `localhost` is already an authorized Firebase Auth domain.

## Pitfalls

- **GitHub Pages caches aggressively.** Hard-refresh (Ctrl+Shift+R) after pushing.
- **Auth popup closes instantly?** You forgot to add the deployed domain to Firebase Auth's authorized domains.
- **Permission errors in console?** Firestore rules weren't published, or you're signed in as a different account than the doc owner.
- **Module paths.** All script/style paths are relative (`./js/...`) so they work under `/storybible2/`.
