import { describe, expect, it } from 'vitest';
import { redactHtml } from './redact';

describe('redactHtml: input values', () => {
  it.each([
    ['<input type="password" value="hunter2">'],
    ['<input value="hunter2" type="password">'],
    ["<input type='hidden' name='csrf' value='hunter2'>"],
    ['<input type=hidden value=hunter2>'],
    ['<input TYPE="Password" VALUE="hunter2" />'],
    ['<input type="hidden" value="a>hunter2">'],
    ['<input value="hunter2">'],
    ['<input type="text" name="api_key" value="hunter2">'],
    ['<input type="email" value="hunter2">'],
    // axe cuts long HTML off, so the tag may stop anywhere.
    ['<input type="password" value="hunter2'],
    ['<input value="hunter2" type="passw'],
    ['<input value=hunter2'],
    ['<input type="submit-ish" value="hunter2">'],
    // `value=` inside another attribute is not the value attribute.
    [`<input type="password" title="value='" value="'hunter2">`],
    [`<input type="password" title='value="' value='"hunter2'>`],
  ])('blanks the value in %s', (html) => {
    const out = redactHtml(html);
    expect(out).not.toContain('hunter2');
    expect(out).toMatch(/value=""/i);
  });

  it.each([
    ['<input type="submit" value="Sign in">'],
    ['<input type="button" value="Open menu">'],
    ["<input type='RESET' value='Start over'>"],
    ['<input value="Go" type="submit">'],
  ])('keeps the label on %s, which button-name needs', (html) => {
    expect(redactHtml(html)).toBe(html);
  });

  it('leaves values on other elements alone', () => {
    const html = '<button type="hidden" value="x">Go</button><li value="3">';
    expect(redactHtml(html)).toBe(html);
  });

  it('keeps everything else in an input tag, including its spacing', () => {
    expect(redactHtml('<input  id="pw"\n type="password"   value="hunter2" required />')).toBe(
      '<input  id="pw"\n type="password"   value="" required />',
    );
  });
});

describe('redactHtml: URLs', () => {
  it.each([
    ['<a href="/reset?token=abc123">Reset</a>', '<a href="/reset">Reset</a>'],
    ["<a href='https://x.test/p?a=1&b=2#top'>x</a>", "<a href='https://x.test/p'>x</a>"],
    ['<img src=/a.png?sig=abc123>', '<img src=/a.png>'],
    [
      '<img srcset="/a.png?k=abc123 1x, /b.png?k=abc123 2x">',
      '<img srcset="/a.png 1x, /b.png 2x">',
    ],
    ['<a href="/cb#access_token=abc123&x=1">x</a>', '<a href="/cb">x</a>'],
    ['<form action="/login?next=abc123">', '<form action="/login">'],
    ['<a href="/x?token=abc123', '<a href="/x'],
  ])('strips secrets from %s', (html, expected) => {
    expect(redactHtml(html)).toBe(expected);
  });

  it('keeps URLs with nothing to strip, and plain fragments like skip links', () => {
    const html = '<a href="#main">Skip</a><a href="/about">About</a>';
    expect(redactHtml(html)).toBe(html);
  });
});

describe('redactHtml: attribute names', () => {
  it.each([
    ['<div data-token="abc123">', '<div data-token="">'],
    ['<meta name="x" data-csrf-token=abc123>', '<meta name="x" data-csrf-token="">'],
    ['<div data-api-key=\'abc123\' class="a">', '<div data-api-key="" class="a">'],
    ['<div DATA-SESSION-ID="abc123">', '<div DATA-SESSION-ID="">'],
  ])('blanks %s', (html, expected) => {
    expect(redactHtml(html)).toBe(expected);
  });

  it('leaves ordinary attributes, including ARIA, alone', () => {
    const html =
      '<button class="btn" aria-label="Close" aria-keyshortcuts="Esc" tabindex="0" disabled>X</button>';
    expect(redactHtml(html)).toBe(html);
  });
});

describe('redactHtml: URLs, harder cases', () => {
  it.each([
    // A comma or space in the query used to end the strip early.
    ['<a href="/x?ids=1,2&token=SECRET"></a>', '<a href="/x"></a>'],
    ['<a href="/x?q=a b&token=SECRET"></a>', '<a href="/x"></a>'],
    ['<a href="/x?a=1#frag,SECRET=1">x</a>', '<a href="/x">x</a>'],
    ['<img srcset="/a.png?k=1,2&t=SECRET 1x, /b.png 2x">', '<img srcset="/a.png 1x, /b.png 2x">'],
    ['<img srcset="/a.png?t=SECRET, /b.png?t=SECRET 2x">', '<img srcset="/a.png /b.png 2x">'],
    // Credentials and path parameters.
    ['<a href="https://bob:SECRET@example.com/">x</a>', '<a href="https://example.com/">x</a>'],
    ['<a href="//bob:SECRET@example.com/x">x</a>', '<a href="//example.com/x">x</a>'],
    ['<a href="/x;jsessionid=SECRET">x</a>', '<a href="/x">x</a>'],
    ['<a href="/a;jsessionid=SECRET/b?x=1">x</a>', '<a href="/a/b">x</a>'],
    // An @ in the path isn't a credential.
    [
      '<a href="https://example.com/@casey/page">x</a>',
      '<a href="https://example.com/@casey/page">x</a>',
    ],
    // Payloads of data: and javascript: URLs.
    ['<img src="data:image/png;base64,SECRET">', '<img src="data:image/png">'],
    ['<a href="javascript:alert(SECRET)">x</a>', '<a href="javascript:">x</a>'],
    // URL-carrying attributes beyond the usual list.
    [
      '<image xlink:href="https://s3.test/a.png?X-Amz-Signature=SECRET">',
      '<image xlink:href="https://s3.test/a.png">',
    ],
    ['<link imagesrcset="/a.png?t=SECRET 1x">', '<link imagesrcset="/a.png 1x">'],
    [
      '<div style="background:url(/a.png?t=SECRET) red">',
      '<div style="background:url(/a.png) red">',
    ],
    [`<div style='background: url("/a.png?t=SECRET")'>`, `<div style='background: url("/a.png")'>`],
    [
      '<meta http-equiv="refresh" content="0;url=/x?t=SECRET">',
      '<meta http-equiv="refresh" content="0;url=/x">',
    ],
  ])('strips the secret from %s', (html, expected) => {
    const out = redactHtml(html);
    expect(out).not.toContain('SECRET');
    expect(out).toBe(expected);
  });
});

describe('redactHtml: more attributes and names', () => {
  it.each([
    '<img data-src="https://s3.test/a.png?X-Amz-Signature=SECRET">',
    '<a data-href="/x?t=SECRET" data-url="/y?t=SECRET">x</a>',
    '<div data-jwt="SECRET" data-key="SECRET" data-sid="SECRET" data-bearer="SECRET">',
    '<div data-pwd="SECRET" data-pass="SECRET" data-sig="SECRET" data-email="a@SECRET.test">',
    '<button onclick="go(\'SECRET\')">x</button>',
    '<iframe srcdoc="<p>SECRET</p>"></iframe>',
    '<div jwt="SECRET" session-id="SECRET" x-api-key="SECRET">',
  ])('removes the secret from %s', (html) => {
    expect(redactHtml(html)).not.toContain('SECRET');
  });

  it.each([
    '<button name="csrf" value="SECRET">x</button>',
    '<param name="session" value="SECRET">',
    '<meta name="csrf-token" content="SECRET">',
    '<meta property="og:auth" content="SECRET">',
    '<input type="submit" name="token" value="SECRET">',
    '<button id="auth-code" value="SECRET">x</button>',
  ])('blanks the value or content when the name is sensitive: %s', (html) => {
    expect(redactHtml(html)).not.toContain('SECRET');
  });

  it('keeps value and content when the name is ordinary', () => {
    const html =
      '<button name="save" value="draft">Save</button><meta name="viewport" content="width=device-width">';
    expect(redactHtml(html)).toBe(html);
  });
});

describe('redactHtml: comments, raw text, and tags that do not parse', () => {
  it.each([
    '<!-- <a title=" --><input type="password" value="SECRET">',
    '<script>s=\'<a title="\'</script><input type="password" value="SECRET">',
    '<textarea><a title="</textarea><input value="SECRET">',
    '<style>a[title="</style><input type="password" value="SECRET">',
    // Axe's truncated source doesn't escape quotes in values.
    '<input title="" x=" value="SECRET" type="password">',
    '<input title="a"x=" value=SECRET type=password">',
    '<input title=a"b value="SECRET" type="password">',
  ])('does not leak from %s', (html) => {
    expect(redactHtml(html)).not.toContain('SECRET');
  });

  it('drops comments and script, style, and textarea bodies, keeping the tags', () => {
    expect(redactHtml('a<!-- SECRET -->b')).toBe('ab');
    expect(redactHtml('a<!-- SECRET')).toBe('a');
    expect(redactHtml('<script>var k="SECRET"</script><p>hi</p>')).toBe(
      '<script></script><p>hi</p>',
    );
    expect(redactHtml('<textarea name="n">SECRET</textarea>')).toBe(
      '<textarea name="n"></textarea>',
    );
    expect(redactHtml('<style>.a{color:red}</style>')).toBe('<style></style>');
    expect(redactHtml('<SCRIPT>SECRET</SCRIPT>')).toBe('<SCRIPT></SCRIPT>');
    expect(redactHtml('<script>SECRET')).toBe('<script>');
  });

  it('keeps only the name of a tag it cannot trust', () => {
    expect(redactHtml('<input title="" x=" value="SECRET" type="password">')).toBe('<input>');
  });

  it('does not mistake an ordinary quote or equals sign for a bad tag', () => {
    const html = '<a href="/x?a=b" title="it\'s fine" class=btn>x</a>';
    expect(redactHtml(html)).toBe('<a href="/x" title="it\'s fine" class=btn>x</a>');
  });
});

describe('redactHtml: parsing', () => {
  it('returns text with no tags unchanged', () => {
    expect(redactHtml('Price: 3 < 5 and 7 > 2')).toBe('Price: 3 < 5 and 7 > 2');
    expect(redactHtml('')).toBe('');
  });

  it('handles several tags, closing tags, and nested markup', () => {
    expect(
      redactHtml('<form><input type="password" value="hunter2"><a href="/x?t=1">go</a></form>'),
    ).toBe('<form><input type="password" value=""><a href="/x">go</a></form>');
  });

  it('terminates on malformed or cut-off tags', () => {
    for (const html of [
      '<',
      '<a',
      '<a ',
      '<a =',
      '<a ="',
      '<a b=',
      '<a b="',
      '<<<a<',
      '<input /',
    ]) {
      expect(typeof redactHtml(html)).toBe('string');
    }
  });

  it('stays fast on a long run of quotes and angle brackets', () => {
    const html = `<input ${'" \' = < '.repeat(20_000)}`;
    const start = Date.now();
    redactHtml(html);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
