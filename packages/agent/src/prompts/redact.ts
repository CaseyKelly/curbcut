// Keeps secrets in page HTML out of prompts (#7). Axe reports an element's
// HTML as it is on the live page, so it can hold session tokens in URLs, CSRF
// values in hidden inputs, or a typed password. This is a stopgap for M1: the
// secret scanner that redacts repo files before they reach a prompt (#21)
// covers the rest in M3.
//
// It works from an allowlist, so what it doesn't recognize is removed: an
// attribute keeps its value only if it's on the list of attributes that
// accessibility rules and explanations are about (`id`, `class`, `role`,
// `aria-*`, `alt`, `href`, and so on). Every other attribute keeps its name
// and loses its value. Kept URLs and text lose query strings, credentials,
// and the like.
//
// It reads start tags with a small tokenizer rather than regexes, because
// quotes decide where an attribute ends and axe cuts long HTML off, so a tag
// can stop anywhere. A tag that doesn't parse cleanly keeps only its name,
// since axe's truncated source doesn't escape quotes and the attribute
// boundaries can't be trusted. Comments, and the bodies of elements whose
// content isn't markup, are dropped, so text in them can't pass for a tag.
//
// What it can't catch: text content; a secret in the value of `id`, `class`,
// `name`, or another plain attribute; a token in a URL path (`/reset/SECRET`)
// or a plain fragment (`#SECRET`); a password containing `/` or `@` in a URL;
// and a secret in free text in `title` or `aria-label` that isn't shaped like
// a URL (`x.test/p;jsessionid=SECRET` with no scheme or leading slash).

/** Input types whose `value` is the visible label, which rules like `button-name` need. */
const VISIBLE_VALUE_TYPES = new Set(['submit', 'button', 'reset']);

/** Elements whose bodies are dropped: text in them isn't markup, and may hold anything. */
const RAW_TEXT_ELEMENTS = new Set(
  'script style textarea title xmp iframe noembed noframes noscript'.split(' '),
);

/** Attributes whose value is a URL. */
const URL_ATTRIBUTES = new Set(
  'href src action formaction poster cite ping background manifest data xlink:href'.split(' '),
);

/** Attributes whose value is text people read; `aria-*` is too. */
const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'placeholder', 'label', 'summary', 'abbr']);

/** Attributes whose value is plain, and what rules and explanations are about. */
const PLAIN_ATTRIBUTES = new Set(
  'id class role lang xml:lang dir tabindex usemap type name for form scope headers colspan rowspan accesskey autocomplete inputmode width height charset http-equiv rel target method enctype media sizes loading min max step maxlength minlength size rows cols wrap open start reversed span kind srclang hreflang decoding crossorigin referrerpolicy translate spellcheck draggable contenteditable viewbox xmlns focusable'.split(
    ' ',
  ),
);

/**
 * Names that suggest a secret. Only used on a button's `name`, to decide
 * whether its label can stay: `<input type="submit" name="csrf" value="...">`.
 */
const SENSITIVE_NAME = new RegExp(
  [
    'api[-_]?key',
    'access[-_]?key',
    'private[-_]?key',
    '(?:^|[-_:])key(?:$|[-_])',
    'secret',
    'token',
    'passw',
    '(?:^|[-_:])pass(?:$|[-_])',
    'pwd',
    'csrf',
    'xsrf',
    'nonce',
    'auth',
    'session',
    '(?:^|[-_:])sid(?:$|[-_])',
    'jwt',
    'bearer',
    'credential',
    'signature',
    '(?:^|[-_:])sig(?:$|[-_])',
  ].join('|'),
  'i',
);

interface Attribute {
  /** The whitespace before it. */
  lead: string;
  /** Name, `=`, and value, exactly as written. */
  raw: string;
  name: string;
  value: string | null;
  quote: '"' | "'" | '';
  /** False when the HTML ended inside the quotes. */
  closed: boolean;
}

interface StartTag {
  /** `<` and the tag name, as written. */
  head: string;
  tagName: string;
  attributes: Attribute[];
  /** What follows the last attribute: whitespace, then `>` or `/>`, or nothing if cut off. */
  tail: string;
  /** Index just past the tag. */
  end: number;
  /** The attributes can't be trusted, so none are kept. */
  malformed: boolean;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Reads the start tag that begins at `start` (a `<` followed by a letter). Always makes progress. */
function readStartTag(html: string, start: number): StartTag {
  const n = html.length;
  let i = start + 1;
  while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  const head = html.slice(start, i);
  const attributes: Attribute[] = [];
  let tail = '';
  let malformed = false;

  for (;;) {
    const leadStart = i;
    // A `/` that doesn't close the tag is skipped like whitespace, as browsers do.
    while (i < n && (isSpace(html[i]) || (html[i] === '/' && html[i + 1] !== '>'))) i++;
    const lead = html.slice(leadStart, i);
    if (i >= n) {
      tail = lead;
      break;
    }
    if (html[i] === '>') {
      tail = `${lead}>`;
      i++;
      break;
    }
    if (html[i] === '/') {
      tail = `${lead}/>`;
      i += 2;
      break;
    }

    const nameStart = i;
    // The first character is always part of the name, even a stray `=`.
    i++;
    while (i < n && !isSpace(html[i]) && !'=/>'.includes(html[i]!)) i++;
    const name = html.slice(nameStart, i);
    if (/["'<]/.test(name)) malformed = true;

    let j = i;
    while (isSpace(html[j])) j++;
    let value: string | null = null;
    let quote: Attribute['quote'] = '';
    let closed = true;
    if (html[j] === '=') {
      j++;
      while (isSpace(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        quote = q;
        const close = html.indexOf(q, j + 1);
        if (close === -1) {
          value = html.slice(j + 1);
          closed = false;
          j = n;
        } else {
          value = html.slice(j + 1, close);
          j = close + 1;
          // `a="b"c` is an error browsers recover from, and what it means
          // depends on quotes axe may not have escaped.
          const next = html[j];
          if (next !== undefined && !isSpace(next) && next !== '/' && next !== '>') {
            malformed = true;
          }
        }
      } else {
        const valueStart = j;
        while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
        value = html.slice(valueStart, j);
        if (/["'<`]/.test(value)) malformed = true;
      }
      i = j;
    }
    attributes.push({ lead, raw: html.slice(nameStart, i), name, value, quote, closed });
  }

  return { head, tagName: head.slice(1).toLowerCase(), attributes, tail, end: i, malformed };
}

/**
 * One URL without what can carry a secret: credentials, the query string, path
 * parameters like `;jsessionid=`, any fragment but a plain id (`#main`), and
 * the payload of `data:`, `javascript:` and `vbscript:` URLs. Every step is a
 * linear scan, since this can see up to 20,000 characters.
 */
function scrubUrl(url: string): string {
  return (
    url
      .trim()
      .replace(/^(data:[^;,]*|javascript:|vbscript:)[\s\S]*$/i, '$1')
      .replace(/\/\/[^/?#@\s]*@/g, '//')
      .replace(/\?[\s\S]*$/, '')
      // Not the `;` that ends an entity like `&amp;`.
      .replace(/(?<!&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+));[^/?#]*/gi, '')
      // Not the `#` of a numeric entity like `&#38;`.
      .replace(/(?<!&)#(?![\w-]*$)[\s\S]*$/, '')
  );
}

/** Whether a word in free text looks like a URL, so "Delete?" stays and `/x?token=1` goes. */
function looksLikeUrl(word: string): boolean {
  if (
    word.includes('://') ||
    word.startsWith('/') ||
    /^(?:data|javascript|vbscript):/i.test(word)
  ) {
    return true;
  }
  const query = word.indexOf('?');
  if (query !== -1 && word.indexOf('=', query) !== -1) return true;
  const hash = word.indexOf('#');
  return hash !== -1 && /[=&]/.test(word.slice(hash));
}

/** Text people read, such as `title` and `aria-label`: URL-shaped words are scrubbed. */
function scrubText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((piece) => (looksLikeUrl(piece) ? scrubUrl(piece) : piece))
    .join('');
}

/**
 * What a URL in a style declaration runs through: everything up to the `)` or
 * the closing quote. Attribute values are written with entities, so the quote
 * can be `&quot;` and the `&` in a query is `&amp;`; neither ends the URL.
 */
const STYLE_URL_BODY = '(?:&(?!quot;|#34;|#39;|apos;)|[^&)"\'])*';

/** A style declaration: `url(...)` can sit anywhere in it, in several forms. */
function scrubStyle(style: string): string {
  return style
    .replace(new RegExp(`data:[^;,)"'&]*[;,]${STYLE_URL_BODY}`, 'gi'), 'data:')
    .replace(/\/\/[^/?#@\s)"'&]*@/g, '//')
    .replace(new RegExp(`\\?${STYLE_URL_BODY}`, 'g'), '');
}

/** The attribute as it should be written, or undefined to keep it as it was. */
function redactAttribute(
  attr: Attribute,
  tag: StartTag,
  context: { keepInputValue: boolean; attribute: (name: string) => Attribute | undefined },
): string | undefined {
  if (attr.value === null) return undefined;
  const name = attr.name.toLowerCase();
  const blank = `${attr.name}=""`;
  const rewrite = (value: string) =>
    value === attr.value
      ? undefined
      : `${attr.name}=${attr.quote}${value}${attr.closed ? attr.quote : ''}`;

  // Only a button's label is a value worth keeping: it's the button's name.
  if (name === 'value')
    return tag.tagName === 'input' && context.keepInputValue ? undefined : blank;

  if (name === 'content' && tag.tagName === 'meta') {
    // The viewport (zoom rules) and refresh (the `meta-refresh` rule) are the
    // meta content that rules are about.
    if (context.attribute('name')?.value?.trim().toLowerCase() === 'viewport') return undefined;
    if (context.attribute('http-equiv')?.value?.trim().toLowerCase() === 'refresh') {
      // `0;url=/x`, `0; url=/x`, or a bare `0; /x`: the URL is whatever follows the delay.
      return rewrite(
        attr.value.replace(
          /^([^;,]*[;,]\s*(?:url\s*=\s*)?)([\s\S]*)$/i,
          (_m, p: string, u: string) => p + scrubUrl(u),
        ),
      );
    }
    return blank;
  }

  if (URL_ATTRIBUTES.has(name)) return rewrite(scrubUrl(attr.value));
  if (name === 'style') return rewrite(scrubStyle(attr.value));
  if (TEXT_ATTRIBUTES.has(name) || name.startsWith('aria-')) return rewrite(scrubText(attr.value));
  if (PLAIN_ATTRIBUTES.has(name)) return undefined;
  // Everything else: handlers, `data-*`, srcdoc, framework attributes, custom
  // elements' config. The name stays, so the element's shape does.
  return blank;
}

function redactStartTag(tag: StartTag): string {
  // Dropping every attribute, the tail too: where the tag really ends is a guess.
  if (tag.malformed) return `${tag.head}>`;

  const attribute = (name: string) => tag.attributes.find((a) => a.name.toLowerCase() === name);
  const type = tag.tagName === 'input' ? attribute('type') : undefined;
  const buttonName = attribute('name')?.value ?? '';
  const keepInputValue =
    type?.value != null &&
    type.closed &&
    VISIBLE_VALUE_TYPES.has(type.value.trim().toLowerCase()) &&
    !SENSITIVE_NAME.test(buttonName);

  const attributes = tag.attributes
    .map((a) => a.lead + (redactAttribute(a, tag, { keepInputValue, attribute }) ?? a.raw))
    .join('');
  return `${tag.head}${attributes}${tag.tail}`;
}

/**
 * Removes likely secrets from HTML. An attribute keeps its value only if it's
 * on the allowlist; kept URLs and text lose credentials, query strings, and
 * the like. The `value` of an input is kept only on buttons. Comments and the
 * bodies of script, style, textarea, title, and a few other elements are
 * dropped. Text content is left alone.
 */
export function redactHtml(html: string): string {
  const n = html.length;
  let lower: string | undefined;
  /** An SVG `<title>` is an ordinary element with text people read, not raw text. */
  let inSvg = false;
  let out = '';
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (!/[a-z]/i.test(html.charAt(lt + 1))) {
      if (/^<\/svg\b/i.test(html.slice(lt, lt + 7))) inSvg = false;
      out += '<';
      i = lt + 1;
      continue;
    }

    const tag = readStartTag(html, lt);
    out += redactStartTag(tag);
    i = tag.end;
    if (tag.tagName === 'svg' && !tag.tail.endsWith('/>')) inSvg = true;

    const rawText = RAW_TEXT_ELEMENTS.has(tag.tagName) && !(inSvg && tag.tagName === 'title');
    if (rawText && !tag.tail.endsWith('/>')) {
      // ASCII only: `toLowerCase` changes the length of some letters (`İ`), and
      // the offsets here are into `html`.
      lower ??= html.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const close = lower.indexOf(`</${tag.tagName}`, i);
      i = close === -1 ? n : close;
    }
  }
  return out;
}
