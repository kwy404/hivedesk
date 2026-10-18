# My Desktop App

A small desktop app on Neutralinojs: the screen is HTML, CSS and JavaScript in `resources/`, shown in a native window on Windows, macOS and Linux.

## Run it

- Tests: `npm test` (Node 20 or newer, nothing to install).
- First run: `npm run setup` downloads the Neutralinojs binaries and `resources/js/neutralino.js` (needs the network once).
- Then `npm start` opens the window. Opened in a plain browser, `resources/index.html` also works and saves to the browser instead of a file.
- `npm run build` writes the release binaries to `dist/`. Installers and code signing are separate steps per operating system and are not part of this project.

## Files

- `neutralino.config.json`: app id, window size and `nativeAllowList`, the only native calls the app may use. Add a call there before you use it; never allow `os.execCommand` unless the app must run programs.
- `resources/js/notes.js`: the logic, tested in `test/notes.test.js`.
- `resources/js/main.js`: the window, save (Ctrl+S) and export.
- Notes are saved as JSON in the user data folder (`os.getPath('data')`).
