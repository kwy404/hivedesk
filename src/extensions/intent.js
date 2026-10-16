// Spots "make a theme" and "make an extension" requests typed in the top bar, in the
// languages of the desktop. Up to two short words may sit between the verb and the noun
// ("crie um novo tema", "make a weather widget"), so a long build request that only
// mentions a theme further on stays a normal job.

const VERB = '(?:crie|cria|criar|fa[cç]a|faz|fazer|gere|gera|gerar|monte|desenhe|create|make|generate|design|build|write|crea|crear|haz|genera|cr[ée]e|cr[ée]ez|cr[ée]er|fais|erstelle|erstell|mach|mache|fai|作って|만들어|создай|сделай)';
const GAP = '(?:\\s+[^\\s]{1,8}){0,2}\\s+';
const END = '(?=$|[\\s,.:;!?])';

const THEME = new RegExp(`(?:^|\\s)${VERB}${GAP}(?:tema|theme|th[èe]me|thema|farbschema|тему|テーマ|테마|主题)${END}`, 'i');
const EXT = new RegExp(`(?:^|\\s)${VERB}${GAP}(?:extens[aã]o|extension|extensi[oó]n|erweiterung|estensione|plugin|plug-in|widget|worker|trabalhador|agente|agent|reviewer|revisor|расширение)${END}`, 'i');
const ROLE = /(worker|trabalhador|agente|agent|revisor|reviewer|papel|role|funcion[aá]rio|assistente|assistant|tradutor|translator)/i;

/** @returns {'theme' | 'extension' | null} */
export function detectIntent(text) {
  const s = ` ${String(text || '').trim()} `;
  if (s.length > 400) return null;
  if (THEME.test(s)) return 'theme';
  if (EXT.test(s)) return 'extension';
  return null;
}

const STOP = new Set(('crie cria criar faca faça faz fazer gere gera gerar monte desenhe create make generate design build write crea crear haz genera cree creer fais erstelle mach mache fai ' +
  'um uma uns umas o a os as de do da dos das que e em no na para pra com por ' +
  'an the that which who of for with to and in on new novo nova ' +
  'una el la los las del que con para por un ' +
  'extensao extensão extension extensión extensiones plugin widget worker trabalhador agente agent ' +
  'mostra mostre mostrar show shows display displays muestra mostrar affiche zeigt mostra mi me my meu minha').split(/\s+/));

/** A first guess at the extension from the request alone (the crew fills in the rest). */
export function guessSpec(text) {
  const raw = String(text || '').trim();
  const words = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const keep = words.filter((w) => !STOP.has(w) && w.length > 1).slice(0, 3);
  let id = keep.join('-').slice(0, 40).replace(/-+$/, '') || 'my-extension';
  if (!/^[a-z]/.test(id)) id = `ext-${id}`.slice(0, 40);
  if (id.length < 2) id = 'my-extension';
  // The display name keeps the accents of the request.
  const plain = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const orig = raw.replace(/[^p{L}p{N}s-]/gu, ' ').split(/s+/).filter((w) => keep.includes(plain(w)));
  const shown = orig.length === keep.length ? orig : keep;
  const name = shown.length ? shown.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'My extension';
  const kind = ROLE.test(raw) ? 'role' : 'widget';
  const domains = /(clima|weather|tempo|wetter|m[ée]t[ée]o|meteo|previs)/i.test(raw) ? ['api.open-meteo.com'] : [];
  return { id, name, kind, domains, goal: raw.slice(0, 300) };
}
