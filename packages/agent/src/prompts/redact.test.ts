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

  it('blanks values on other elements, whose value is never a label', () => {
    expect(redactHtml('<button type="hidden" value="x">Go</button><li value="3">')).toBe(
      '<button type="hidden" value="">Go</button><li value="">',
    );
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
    ['<img srcset="/a.png?k=abc123 1x, /b.png?k=abc123 2x">', '<img srcset="">'],
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

  it('keeps a button label when its name is ordinary, and a viewport meta', () => {
    const html =
      '<input type="submit" name="save" value="Save"><meta name="viewport" content="width=device-width">';
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

describe('redactHtml: the allowlist', () => {
  it.each([
    '<a hx-get="/x?token=SECRET">x</a>',
    '<div ng-init="t=\'SECRET\'">',
    '<img longdesc="/x?t=SECRET">',
    '<x-card config="SECRET">',
    '<button value="SECRET">x</button>',
    '<data value="SECRET">x</data>',
    '<meta property="og:url" content="https://x.test/?t=SECRET">',
    '<meta name="description" content="SECRET">',
    '<img srcset="/a.png?t=SECRET 1x" imagesrcset="/b.png?t=SECRET">',
    '<a title="https://x.test/?token=SECRET">x</a>',
    '<a aria-label="https://x.test/?token=SECRET">x</a>',
    '<input placeholder="/reset?token=SECRET">',
  ])('leaves no secret in %s', (html) => {
    expect(redactHtml(html)).not.toContain('SECRET');
  });

  it('keeps the name of an attribute it blanks, so the element keeps its shape', () => {
    expect(redactHtml('<x-card config="SECRET" id="c1">')).toBe('<x-card config="" id="c1">');
  });

  it('keeps the attributes that rules and explanations are about', () => {
    const html =
      '<a href="/about" id="nav-1" class="link" role="button" tabindex="0" accesskey="s" aria-label="Open" ' +
      'aria-describedby="hint" lang="en" title="More" target="_blank" rel="noopener" download disabled>x</a>' +
      '<img src="/a.png" alt="A cat" width="10" height="10">' +
      '<label for="email">Email</label><input type="email" id="email" name="email" autocomplete="email">' +
      '<td colspan="2" headers="h1"><meta http-equiv="refresh" content="5">';
    expect(redactHtml(html)).toBe(html);
  });

  it('does not blank a button label because its id looks sensitive', () => {
    const html = '<input id="auth-btn" type="submit" value="Sign in">';
    expect(redactHtml(html)).toBe(html);
  });

  it('keeps accesskey, which the accesskeys rule is about', () => {
    expect(redactHtml('<a accesskey="s">Save</a>')).toBe('<a accesskey="s">Save</a>');
  });

  it('keeps ordinary question marks in text', () => {
    const html =
      '<button aria-label="Delete?" title="Are you sure? This cannot be undone">x</button>';
    expect(redactHtml(html)).toBe(html);
  });

  it('keeps a viewport meta and a refresh, cleaning the refresh URL', () => {
    expect(
      redactHtml('<meta name="viewport" content="width=device-width, user-scalable=no">'),
    ).toBe('<meta name="viewport" content="width=device-width, user-scalable=no">');
    expect(redactHtml('<meta http-equiv="refresh" content="0;url=/x?t=SECRET">')).toBe(
      '<meta http-equiv="refresh" content="0;url=/x">',
    );
  });
});

describe('redactHtml: URL edge cases', () => {
  it.each([
    ['<a href="/cb#a=1 access_token=SECRET">x</a>', '<a href="/cb">x</a>'],
    ['<a href="/cb#a b=SECRET">x</a>', '<a href="/cb">x</a>'],
    ['<a href=" https://bob:SECRET@example.com/">x</a>', '<a href="https://example.com/">x</a>'],
    ['<a href=" javascript:t=\'SECRET\'">x</a>', '<a href="javascript:">x</a>'],
    ['<a href="vbscript:msgbox(SECRET)">x</a>', '<a href="vbscript:">x</a>'],
    [
      '<a href="https://example.com/a?x=1&token=SECRET#frag">x</a>',
      '<a href="https://example.com/a">x</a>',
    ],
    ['<a href="/page#main">Skip</a>', '<a href="/page#main">Skip</a>'],
    ['<a href="#main">Skip</a>', '<a href="#main">Skip</a>'],
    ['<a href="/x#">Top</a>', '<a href="/x#">Top</a>'],
    [
      '<a title="see https://u:SECRET@x.test/p?t=1 now">x</a>',
      '<a title="see https://x.test/p now">x</a>',
    ],
    ['<a title="Reset: /reset?token=SECRET">x</a>', '<a title="Reset: /reset">x</a>'],
    ['<a title="?token=SECRET">x</a>', '<a title="">x</a>'],
  ])('%s', (html, expected) => {
    expect(redactHtml(html)).toBe(expected);
  });
});

describe('redactHtml: style', () => {
  it.each([
    [
      '<div style="background:url(/a.png?t=SECRET) red">',
      '<div style="background:url(/a.png) red">',
    ],
    [
      `<div style="background:url('/a(1).png?t=SECRET')">`,
      `<div style="background:url('/a(1).png')">`,
    ],
    [
      `<div style="background:image-set('/a.png?t=SECRET' 1x)">`,
      `<div style="background:image-set('/a.png' 1x)">`,
    ],
    [
      '<div style="background:url(data:image/png;base64,SECRET)">',
      '<div style="background:url(data:)">',
    ],
    [
      '<div style="background:url(//u:SECRET@x.test/a.png)">',
      '<div style="background:url(//x.test/a.png)">',
    ],
    ['<p style="color:#777;background:#fff">x</p>', '<p style="color:#777;background:#fff">x</p>'],
  ])('%s', (html, expected) => {
    expect(redactHtml(html)).toBe(expected);
  });
});

describe('redactHtml: more raw-text elements', () => {
  it.each([
    '<title><a title="</title><input x=" value="SECRET"></title>',
    '<xmp><a title="</xmp><input type="password" value="SECRET">',
    '<iframe><a title="</iframe><input type="password" value="SECRET">',
    '<noembed><a title="</noembed><input type="password" value="SECRET">',
    '<noframes><a title="</noframes><input type="password" value="SECRET">',
    '<noscript><a title="</noscript><input type="password" value="SECRET">',
  ])('does not leak from %s', (html) => {
    expect(redactHtml(html)).not.toContain('SECRET');
  });
});

describe('redactHtml: speed on hostile input', () => {
  const fast = (html: string) => {
    const start = Date.now();
    redactHtml(html);
    expect(Date.now() - start).toBeLessThan(500);
  };

  it.each([
    ['whitespace in a style url', `<div style="url(${' '.repeat(20_000)}">`],
    ['question marks in a title', `<a title="${'?'.repeat(20_000)}">`],
    ['question marks in an href', `<a href="${'?'.repeat(20_000)}">`],
    ['slashes and semicolons in an href', `<a href="${'//;'.repeat(6_000)}">`],
    ['hashes in an href', `<a href="${'#a'.repeat(10_000)}">`],
    ['@ signs in a style', `<div style="${'//a@'.repeat(5_000)}">`],
    ['semicolons in a style', `<div style="${'data:;'.repeat(4_000)}">`],
    ['long words in text', `<a aria-label="${'a/b?c '.repeat(3_000)}">`],
    ['open tags', '<a '.repeat(7_000)],
    ['comment openers', '<!--'.repeat(5_000)],
  ])('stays fast: %s', (_name, html) => fast(html));
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
