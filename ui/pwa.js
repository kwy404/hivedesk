// Registers the service worker so the browser can install hivedesk as an app (Start menu or Dock).
// The installed app still needs the local server: run "npx hivedesk" first.
if ('serviceWorker' in navigator && location.hostname === '127.0.0.1') {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
