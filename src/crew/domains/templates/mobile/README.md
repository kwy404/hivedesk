# My App

An installable mobile web app (PWA) that works offline, with a Capacitor config so the same code can become an Android and an iOS app.

## Run it

- Tests: `npm test` (Node 20 or newer, no install needed).
- In a browser: serve the `www` folder (`npm run serve`) and open http://localhost:8080 on your phone or computer. Use "Install app" or "Add to Home Screen" to install it. Some browsers ask for PNG icons of 192 and 512 px before they offer to install; add them next to `icon.svg` and list them in `manifest.webmanifest`.

## Native Android and iOS builds

These steps need tools that are not part of this project:

1. `npm run cap:setup` installs Capacitor (needs the network once).
2. `npm run cap:android` creates the `android` folder and opens it in Android Studio, which builds and signs the APK or AAB.
3. `npm run cap:ios` does the same for Xcode; iOS builds only work on a Mac with Xcode.

After every change in `www`, run `npx cap sync` before building again.

## Files

- `www/index.html`, `www/style.css`, `www/app.js`: the screen.
- `www/store.js`: the data functions (tested in `test/store.test.js`).
- `www/sw.js`: the offline cache. `www/manifest.webmanifest`: name, icon and colors for the installed app.
- `capacitor.config.json`: the app id (`appId`, change it to your own reverse domain) and where the web files are.
