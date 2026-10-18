// Loads the code editor component on demand from the copy the hivedesk server serves
// (ui/editor/vs/, made by scripts/vendor-monaco.mjs). Nothing comes from a CDN.
// The JavaScript and TypeScript language service (diagnostics, go to definition, symbols,
// rename) is the editor's own TypeScript worker, vendored apart in ui/editor/vendor/ts/
// because the copy in vs/ keeps a small stub in its place.

import { editorTheme } from '/workbench/theme.js';

let loading = null;
const TS_PATH = '/editor/vendor/ts';

// The editor cancels pending work (a diff, a hover) by rejecting it with a "Canceled" error;
// that is normal and must not reach the page as an unhandled error.
addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'Canceled' || e.reason?.message === 'Canceled') e.preventDefault();
});

export function loadMonaco() {
  if (globalThis.monaco?.editor) return Promise.resolve(globalThis.monaco);
  loading ??= new Promise((resolve, reject) => {
    const base = `${location.origin}/editor/`;
    const ts = `${location.origin}${TS_PATH}`;
    globalThis.MonacoEnvironment = {
      getWorkerUrl() {
        // The worker's loader maps the TypeScript service to the vendored copy, like the page does.
        const boot = `self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} }; importScripts(${JSON.stringify(`${base}vs/base/worker/workerMain.js`)}); require.config({ paths: { 'vs/language/typescript': ${JSON.stringify(ts)} } });`;
        return URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
      },
    };
    const script = document.createElement('script');
    script.src = '/editor/vs/loader.js';
    script.onerror = () => reject(new Error('The editor files are missing (ui/editor/vs). Run: node scripts/vendor-monaco.mjs'));
    script.onload = () => {
      const req = globalThis.require;
      req.config({ paths: { vs: '/editor/vs', 'vs/language/typescript': ts } });
      req(['vs/editor/editor.main'], () => {
        defineThemes(globalThis.monaco);
        setupLanguages(globalThis.monaco);
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

/** Project wide JavaScript and TypeScript: modules resolve between the files fed as models. */
function setupLanguages(monaco) {
  const tsl = monaco.languages.typescript;
  if (!tsl?.typescriptDefaults) return;
  const opts = {
    target: tsl.ScriptTarget.ESNext,
    module: tsl.ModuleKind.ESNext,
    moduleResolution: tsl.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    jsx: tsl.JsxEmit.Preserve,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    lib: ['esnext', 'dom', 'dom.iterable'],
  };
  tsl.typescriptDefaults.setCompilerOptions(opts);
  tsl.javascriptDefaults.setCompilerOptions(opts);
  tsl.typescriptDefaults.setEagerModelSync(true);
  tsl.javascriptDefaults.setEagerModelSync(true);
}

/** The theme that follows the desktop (ui/themes), defined again whenever the desktop theme changes. */
export function defineDeskTheme(monaco, theme) {
  monaco.editor.defineTheme('hivedesk-desk', editorTheme(theme));
}

/** The hivedesk themes: charcoal and honey, and a warm paper light theme. */
function defineThemes(monaco) {
  monaco.editor.defineTheme('hivedesk-dark', editorTheme(null));
  monaco.editor.defineTheme('hivedesk-light', editorTheme({
    scheme: 'light',
    colors: {
      bg: '#F6F0E6', bg2: '#FBF7F0', panel: '#F3ECE1', panel2: '#EBE2D4', panel3: '#E2D7C6', panel4: '#D6C9B5', line: '#2B1D12',
      text: '#2B1D12', text2: '#4A3A2B', muted: '#7A6A58', faint: '#9C8D7A',
      accent: '#C97A00', accent2: '#A15C00', accentInk: '#FFFFFF', ok: '#3F7A2E', warn: '#9A6A00', bad: '#B24A3A', info: '#2F6A9E',
    },
  }));
  defineDeskTheme(monaco, null);
}
