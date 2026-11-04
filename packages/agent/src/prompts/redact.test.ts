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
    ["<a href='https://x.test/p?a=1&b=2#top'>x</a>", "<a href='https://x.test/p#top'>x</a>"],
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
