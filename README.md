# Passiv desktop buddy

Passiv stays in the browser. This small app adds the buddy to the rest of the computer:

- **The buddy** is a small icon you can drag anywhere. It stays on top of every app, full-screen ones included, and never follows the cursor. Hover it for talk, chat and hide.
- **Sticky notes**: anything it writes lands on the front beside the icon. Notes stack to save space (hover to fan them out), some dismiss themselves, and any one can be dragged off or closed.
- **Type**: press Ctrl + Alt + Space (Mac ⌃⌥Space) and a small box opens in the middle of the screen. Enter sends, Esc closes.
- **Talk**: hold Ctrl + Alt (Mac ⌃⌥) and speak, or tap Ctrl + Alt + T to start and stop. The answer stays by the icon where it is. Ctrl + Alt + S hides or shows the buddy.
- **Needs a Passiv account**: until you're signed in the buddy stays hidden and the shortcuts only open sign-in. Signing out wipes what was stored here.
- **Your to-dos** sit on the front too: drag, tick off, or dismiss.
- Lives in the **menu bar** (Mac) or **system tray** (Windows). No Dock icon, no store.

## Security

- https only, host allowlists, links open only as https/mailto in your browser.
- Windows sandboxed, context-isolated, no Node access; every IPC message checks sender origin and is validated and size-limited.
- Notes are kept in memory only. Nothing typed is stored or sent except what you ask Passiv.
- Updates are downloaded only from the allowlisted host and installed only if their SHA-256 matches `sha256` in `buddyVersion.ts`. The release build prints the values.
- Not yet done: Apple notarization and Windows code signing (need your developer accounts).

## How updates work (all from Base44)

| What changed | What you do | When buddies get it |
| --- | --- | --- |
| How the buddy looks or behaves on screen (`public/buddy/layer.*`, then run `node scripts/buddy-assets.mjs` in Base44) | Publish in Base44 | Next time each buddy starts |
| The buddy's window, chat, brain, to-dos (`/buddy` page and the app) | Publish in Base44 | Next time each buddy starts |
| This app itself (keys, windows, menu) | Tag a new version here, then raise `latest` and paste the `sha256` values into `base44/shared/buddyVersion.ts` in Base44 and publish | Within a few hours: each buddy offers a one-click update |

Set `minimum` in `buddyVersion.ts` to force an update (the buddy opens its window and asks).

## First release

1. Put this folder in a GitHub repo (public, so people can download).
2. `git tag v0.3.3 && git push --tags`. GitHub builds the Mac and Windows installers and attaches them to a Release (about 10 minutes).
3. In Base44, open `base44/shared/buddyVersion.ts` and paste the three links:
   - `https://github.com/<you>/<repo>/releases/latest/download/Passiv-mac-arm64.dmg`
   - `https://github.com/<you>/<repo>/releases/latest/download/Passiv-mac-x64.dmg`
   - `https://github.com/<you>/<repo>/releases/latest/download/Passiv-Windows-Setup.exe`
4. Publish in Base44. ai.passiv.app/download now has a working download button.

Because the links say `latest`, you only paste them once.

## Run it yourself while working on it

```bash
npm install
npm start                      # against ai.passiv.app
PASSIV_URL="https://<preview>.base44.app" npm start   # against an unpublished preview
```

## Signing (later)

Builds are unsigned for now. The download page tells people the one extra click (Mac: System Settings → Privacy & Security → Open Anyway; Windows: More info → Run anyway). When you sign them, set `"signed": true` in `buddyVersion.ts` and those notes disappear.
- Mac: an Apple Developer ID ($99/year) for signing and notarization. Not the App Store.
- Windows: Microsoft Artifact Signing (formerly Trusted Signing) or a code-signing certificate. Not the Microsoft Store.

## Files

- `src/main.js`: the buddy window, the see-through layer on every screen, the cursor, the talk keys (uiohook-napi), the menu bar / tray, and update checks against Base44.
- `src/preload-app.js`, `src/preload-overlay.js`: the narrow bridges Passiv's pages get (and only Passiv's pages).
- The layer itself, the buddy window and the brain all live in the Base44 app: `public/buddy/` (served by the public `buddyFiles` function, because the app is private), `src/pages/BuddyHome.jsx`, `src/lib/desktop.js`.
