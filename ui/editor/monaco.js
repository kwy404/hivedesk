// Loads the code editor component on demand from the copy the hivedesk server serves
// (ui/editor/vs/, made by scripts/vendor-monaco.mjs). Nothing comes from a CDN.

let loading = null;

export function loadMonaco() {
  if (globalThis.monaco?.editor) return Promise.resolve(globalThis.monaco);
  loading ??= new Promise((resolve, reject) => {
    const base = `${location.origin}/editor/`;
    globalThis.MonacoEnvironment = {
      getWorkerUrl() {
        const boot = `self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} }; importScripts(${JSON.stringify(`${base}vs/base/worker/workerMain.js`)});`;
        return URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
      },
    };
    const script = document.createElement('script');
    script.src = '/editor/vs/loader.js';
    script.onerror = () => reject(new Error('The editor files are missing (ui/editor/vs). Run: node scripts/vendor-monaco.mjs'));
    script.onload = () => {
      const req = globalThis.require;
      req.config({ paths: { vs: '/editor/vs' } });
      req(['vs/editor/editor.main'], () => {
        defineThemes(globalThis.monaco);
        resolve(globalThis.monaco);
      }, (err) => reject(err instanceof Error ? err : new Error(String(err))));
    };
    document.head.append(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The hivedesk themes: charcoal and honey, and a warm paper light theme. */
function defineThemes(monaco) {
  monaco.editor.defineTheme('hivedesk-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8C8172', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'FFB531' },
      { token: 'string', foreground: 'A8D08D' },
      { token: 'number', foreground: 'F29A6B' },
      { token: 'tag', foreground: 'FFD072' },
      { token: 'attribute.name', foreground: 'E0B97A' },
      { token: 'attribute.value', foreground: 'A8D08D' },
      { token: 'type', foreground: '8CC4F2' },
      { token: 'delimiter', foreground: 'CFC4B3' },
    ],
    colors: {
      'editor.background': '#141210',
      'editor.foreground': '#F2E9DA',
      'editorLineNumber.foreground': '#645B50',
      'editorLineNumber.activeForeground': '#FFD072',
      'editorCursor.foreground': '#FFB531',
      'editor.selectionBackground': '#FFB53133',
      'editor.inactiveSelectionBackground': '#FFB5311F',
      'editor.lineHighlightBackground': '#1F1B17',
      'editorIndentGuide.background1': '#27221D',
      'editorWidget.background': '#191613',
      'editorWidget.border': '#2F2923',
      'minimap.background': '#141210',
      'scrollbarSlider.background': '#F2E9DA1A',
      'diffEditor.insertedTextBackground': '#7FC98F22',
      'diffEditor.removedTextBackground': '#EF7D6B22',
    },
  });
  monaco.editor.defineTheme('hivedesk-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8C8172', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'A15C00' },
      { token: 'string', foreground: '3F7A2E' },
      { token: 'tag', foreground: '9A5B00' },
    ],
    colors: {
      'editor.background': '#FBF7F0',
      'editor.foreground': '#2B1D12',
      'editorLineNumber.foreground': '#B3A694',
      'editorCursor.foreground': '#C97A00',
      'editor.selectionBackground': '#F2A93B40',
      'editor.lineHighlightBackground': '#F3ECE1',
      'minimap.background': '#FBF7F0',
    },
  });
}
