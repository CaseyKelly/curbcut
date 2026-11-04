// Keeps secrets in page HTML out of prompts (#7). Axe reports an element's
// HTML as it is on the live page, so it can hold session tokens in URLs, CSRF
// values in hidden inputs, or a typed password. This is a stopgap for M1: the
// secret scanner that redacts repo files before they reach a prompt (#21)
// covers the rest in M3.
//
// It reads start tags with a small tokenizer rather than regexes, because
// quotes decide where an attribute ends (`title="value='"` is one attribute),
// and axe cuts long HTML off, so a tag can stop anywhere.

/** Input types whose `value` is the visible label, which rules like `button-name` need. */
const VISIBLE_VALUE_TYPES = new Set(['submit', 'button', 'reset']);

/** Attributes that hold a URL, whose query string can carry a token. */
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
]);

/** Attribute names that suggest the value is a secret, like `data-token` or `csrf`. */
const SENSITIVE_NAME =
  /api[-_]?key|access[-_]?key|private[-_]?key|secret|token|passw|csrf|xsrf|nonce|auth|session|credential|signature/i;

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
        }
      } else {
        const valueStart = j;
        while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
        value = html.slice(valueStart, j);
      }
      i = j;
    }
    attributes.push({ lead, raw: html.slice(nameStart, i), name, value, quote, closed });
  }

  return { head, tagName: head.slice(1).toLowerCase(), attributes, tail, end: i };
}

/** Drops query strings, and fragments that look like `#access_token=...`. */
function stripUrlSecrets(url: string): string {
  return url.replace(/\?[^#\s,]*/g, '').replace(/#(?=[^\s,]*[=&])[^\s,]*/g, '');
}

/** The attribute as it should be written, or undefined to keep it as it was. */
function redactAttribute(attr: Attribute, tag: StartTag, keepInputValue: boolean) {
  if (attr.value === null) return undefined;
  const name = attr.name.toLowerCase();
  const blank = `${attr.name}=""`;

  if (SENSITIVE_NAME.test(name)) return blank;
  // An allowlist: an input with no type, an odd one, or one whose type was
  // cut off is blanked, so a password can't slip through as "unknown".
  if (name === 'value' && tag.tagName === 'input' && !keepInputValue) return blank;

  if (URL_ATTRIBUTES.has(name)) {
    const stripped = stripUrlSecrets(attr.value);
    if (stripped === attr.value) return undefined;
    return `${attr.name}=${attr.quote}${stripped}${attr.closed ? attr.quote : ''}`;
  }
  return undefined;
}

function redactStartTag(tag: StartTag): string {
  const type =
    tag.tagName === 'input'
      ? tag.attributes.find((a) => a.name.toLowerCase() === 'type')
      : undefined;
  const keepInputValue =
    type?.value != null && type.closed && VISIBLE_VALUE_TYPES.has(type.value.trim().toLowerCase());

  const attributes = tag.attributes
    .map((attr) => attr.lead + (redactAttribute(attr, tag, keepInputValue) ?? attr.raw))
    .join('');
  return `${tag.head}${attributes}${tag.tail}`;
}

/**
 * Removes likely secrets from HTML: the `value` of every input except
 * buttons, any attribute whose name looks secret (`data-token`, `csrf`), and
 * query strings in URL attributes. Text content is left alone.
 */
export function redactHtml(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (!/[a-z]/i.test(html.charAt(lt + 1))) {
      out += '<';
      i = lt + 1;
      continue;
    }
    const tag = readStartTag(html, lt);
    out += redactStartTag(tag);
    i = tag.end;
  }
  return out;
}
