# Star Catcher

A small canvas game: move the paddle to catch the falling stars; a missed star costs a life.

## Play

Serve the folder with any static server (the hivedesk preview does it) and open `index.html`. Arrow keys or A and D move, P pauses, Enter restarts; on a phone, drag on the game. The game pauses by itself when the tab is hidden.

## Develop

- `npm test` plays the rules in `src/game.js` with node:test (Node 20 or newer).
- `src/game.js`: the rules as pure functions with a seeded random generator. `src/main.js`: the loop (requestAnimationFrame with the frame time), input and drawing.
- The best score is saved in this browser (localStorage), and the game still runs when storage is blocked.
