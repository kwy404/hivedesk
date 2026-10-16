// The lend link page. It reads the six words from the hash (#w=a-b-c-d-e-f),
// shows them and builds the --join command. Nothing leaves the page.
const V = window.V;
const m = /(?:^|[#&?])w=([A-Za-z-]+)/.exec(location.hash);
const words = m ? m[1].split('-').filter(Boolean).map((w) => w.toLowerCase()) : [];
const link = `https://kwy404.github.io/hivedesk/lend/#w=${words.join('-')}`;

const LEND = V.reactive({
  words: words.length === 6 ? words : [],
  command: `npx hivedesk --join "${link}"`,
  copied: false,
  async copy() {
    try {
      await navigator.clipboard.writeText(LEND.command);
      LEND.copied = true;
      setTimeout(() => { LEND.copied = false; }, 2000);
    } catch {
      LEND.copied = false;
    }
  },
});

Object.assign(V.config.globals, { LEND });
V.start();
