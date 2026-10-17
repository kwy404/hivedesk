// The checks. Plain text matching (the sandbox has no DOM), good enough for hand written pages.

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const metaContent = (html, key, value) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if ((attr(m[0], key) || '').toLowerCase() === value) return attr(m[0], 'content');
  return null;
};

/** @returns {{ score: number, issues: string[], passed: string[] }} */
export function checkPage(html) {
  const issues = [];
  const passed = [];
  const check = (ok, good, bad, weight = 1) => { if (ok) passed.push(good); else issues.push(bad); return ok ? 0 : weight; };
  let lost = 0;

  const htmlTag = (html.match(/<html\b[^>]*>/i) || [''])[0];
  lost += check(!!attr(htmlTag, 'lang'), 'The page sets its language', 'Add a lang attribute to <html>, for example lang="en"');
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  lost += check(!!title, 'The page has a title', 'Add a <title> to the <head>', 3);
  if (title) lost += check(title.length >= 10 && title.length <= 65, `The title has a good length (${title.length} characters)`, `Make the title 10 to 65 characters long (now ${title.length})`);
  const desc = metaContent(html, 'name', 'description');
  lost += check(!!desc, 'The page has a meta description', 'Add <meta name="description" content="..."> with one or two sentences', 2);
  if (desc) lost += check(desc.length >= 50 && desc.length <= 160, `The description has a good length (${desc.length} characters)`, `Make the description 50 to 160 characters long (now ${desc.length})`);
  lost += check(/<meta\b[^>]*name=["']?viewport/i.test(html), 'The page sets a viewport for phones', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">', 2);
  const h1 = (html.match(/<h1\b/gi) || []).length;
  lost += check(h1 === 1, 'The page has exactly one <h1>', h1 ? `Use one <h1> per page (found ${h1})` : 'Add one <h1> with the main topic of the page', 2);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => attr(t, 'alt') === null).length;
  lost += check(noAlt === 0, imgs.length ? 'Every image has alt text' : 'No images to describe', `Add alt text to ${noAlt} image${noAlt === 1 ? '' : 's'} (alt="" for decoration)`, 2);
  lost += check(!!metaContent(html, 'property', 'og:title'), 'Link previews have a title (og:title)', 'Add <meta property="og:title" content="..."> for link previews');
  lost += check(!!metaContent(html, 'property', 'og:description') || !!metaContent(html, 'property', 'og:image'), 'Link previews have a description or image', 'Add og:description and og:image for link previews');
  const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  const vague = links.filter((m) => /^(click here|here|read more|more|link)$/i.test(strip(m[1]))).length;
  lost += check(vague === 0, 'Link texts say where they go', `Rewrite ${vague} vague link text${vague === 1 ? '' : 's'} like "click here"`);
  const words = strip(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')).split(' ').filter(Boolean).length;
  lost += check(words >= 80, `The page has enough text (${words} words)`, `Add more readable text (${words} words now, 80 or more is better)`);

  const max = 21;
  return { score: Math.max(0, Math.round(100 * (1 - lost / max))), issues, passed };
}
