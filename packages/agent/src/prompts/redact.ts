// Keeps secrets in page HTML out of prompts (#7). Axe reports an element's
// HTML as it is on the live page, so it can hold session tokens in URLs, CSRF
// values in hidden inputs, or a typed password. This is a stopgap for M1: the
// secret scanner that redacts repo files before they reach a prompt (#21)
// covers the rest in M3.
//
// It fails closed: what it doesn't recognize is removed, not passed through.
// It reads start tags with a small tokenizer rather than regexes, because
// quotes decide where an attribute ends and axe cuts long HTML off, so a tag
// can stop anywhere. A tag that doesn't parse cleanly keeps only its name,
// since axe's truncated source doesn't escape quotes and the attribute
// boundaries can't be trusted. Comments and script, style, and textarea
// bodies are dropped, so text inside them can't be mistaken for a tag.
//
// What it can't catch: a token in the path (`/reset/SECRET`), the value of an
// `<option>`, and secrets in text content.

/** Input types whose `value` is the visible label, which rules like `button-name` need. */
const VISIBLE_VALUE_TYPES = new Set(['submit', 'button', 'reset']);

/** Elements whose bodies are dropped: text in them isn't markup, and may hold anything. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea']);

/** Attributes that hold a URL. Others are caught by name (`xlink:href`, `imagesrcset`). */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'ping',
  'background',
  'manifest',
]);
const URL_ATTRIBUTE_NAME = /(?:src|srcset|href|url|action|poster)$/;

/**
 * Names that suggest a secret or personal data. Matched against attribute
 * names and against an element's `name`, `id` and `property`, so
 * `<button name="csrf" value="...">` is caught too. A little over-redaction
 * (`author`) costs an explanation nothing.
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
    'email',
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
 * parameters like `;jsessionid=`, fragments like `#access_token=...`, and the
 * payload of `data:` and `javascript:` URLs.
 */
function stripUrlSecrets(url: string): string {
  return url
    .replace(/^(data:[^;,]*|javascript:)[\s\S]*$/i, '$1')
    .replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#@\s]*@/i, '$1')
    .replace(/\?[\s\S]*$/, '')
    .replace(/;[^/?#]*/g, '')
    .replace(/#[^\s]*[=&][^\s]*/, '');
}

/**
 * `srcset` is candidates separated by commas, each a URL and maybe a
 * descriptor. A comma can be part of a URL, so clean each whitespace-separated
 * piece; a candidate cut short loses its trailing comma, which doesn't matter.
 */
function stripSrcsetSecrets(srcset: string): string {
  return srcset
    .split(/(\s+)/)
    .map((piece) => (isSpace(piece[0]) ? piece : stripUrlSecrets(piece)))
    .join('');
}

/** Cleans every `url(...)` in a style declaration. */
function stripStyleUrls(style: string): string {
  return style.replace(
    /url\(\s*(["']?)([^"')]*)\1\s*\)/gi,
    (_m, q: string, url: string) => `url(${q}${stripUrlSecrets(url)}${q})`,
  );
}

const isUrlAttribute = (name: string) => URL_ATTRIBUTES.has(name) || URL_ATTRIBUTE_NAME.test(name);

/** The attribute as it should be written, or undefined to keep it as it was. */
function redactAttribute(
  attr: Attribute,
  tag: StartTag,
  context: { keepInputValue: boolean; sensitiveElement: boolean },
): string | undefined {
  if (attr.value === null) return undefined;
  const name = attr.name.toLowerCase();
  const blank = `${attr.name}=""`;
  const rewrite = (value: string) =>
    value === attr.value
      ? undefined
      : `${attr.name}=${attr.quote}${value}${attr.closed ? attr.quote : ''}`;

  // Handlers and srcdoc hold code and whole documents; data-* holds whatever
  // the app put there, and no explanation depends on it.
  if (/^on[a-z]+$/.test(name) || name === 'srcdoc' || name.startsWith('data-')) return blank;
  if (SENSITIVE_NAME.test(name)) return blank;
  if ((name === 'value' || name === 'content') && context.sensitiveElement) return blank;
  // An allowlist: an input with no type, an odd one, or one whose type was
  // cut off is blanked, so a password can't slip through as "unknown".
  if (name === 'value' && tag.tagName === 'input' && !context.keepInputValue) return blank;

  if (name === 'srcset' || name === 'imagesrcset') return rewrite(stripSrcsetSecrets(attr.value));
  if (isUrlAttribute(name)) return rewrite(stripUrlSecrets(attr.value));
  if (name === 'style') return rewrite(stripStyleUrls(attr.value));
  // `<meta http-equiv="refresh" content="0;url=/x?t=...">`
  if (name === 'content' && tag.tagName === 'meta' && /url\s*=/i.test(attr.value)) {
    return rewrite(
      attr.value.replace(
        /(url\s*=\s*)([\s\S]*)$/i,
        (_m, p: string, u: string) => p + stripUrlSecrets(u),
      ),
    );
  }
  return undefined;
}

function redactStartTag(tag: StartTag): string {
  // Dropping every attribute, the tail too: where the tag really ends is a guess.
  if (tag.malformed) return `${tag.head}>`;

  const attr = (name: string) => tag.attributes.find((a) => a.name.toLowerCase() === name);
  const type = tag.tagName === 'input' ? attr('type') : undefined;
  const sensitiveElement = tag.attributes.some(
    (a) =>
      ['name', 'id', 'property'].includes(a.name.toLowerCase()) &&
      a.value !== null &&
      SENSITIVE_NAME.test(a.value),
  );
  const keepInputValue =
    type?.value != null && type.closed && VISIBLE_VALUE_TYPES.has(type.value.trim().toLowerCase());

  const attributes = tag.attributes
    .map((a) => a.lead + (redactAttribute(a, tag, { keepInputValue, sensitiveElement }) ?? a.raw))
    .join('');
  return `${tag.head}${attributes}${tag.tail}`;
}

/**
 * Removes likely secrets from HTML: the `value` of every input except
 * buttons, every `data-*` and `on*` value, attributes and elements whose
 * names look secret (`token`, `csrf`, `session`), and credentials, query
 * strings, and path parameters in URLs. Comments and script, style, and
 * textarea bodies are dropped. Other text content is left alone.
 */
export function redactHtml(html: string): string {
  const n = html.length;
  let lower: string | undefined;
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
      out += '<';
      i = lt + 1;
      continue;
    }

    const tag = readStartTag(html, lt);
    out += redactStartTag(tag);
    i = tag.end;

    if (RAW_TEXT_ELEMENTS.has(tag.tagName) && !tag.tail.endsWith('/>')) {
      lower ??= html.toLowerCase();
      const close = lower.indexOf(`</${tag.tagName}`, i);
      i = close === -1 ? n : close;
    }
  }
  return out;
}
