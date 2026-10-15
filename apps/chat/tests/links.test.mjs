import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, isWebUrl, shortUrl } from '../lib/links.js';

test('Markdown links keep their text, bare URLs get a short label', () => {
  const links = extractLinks('See [the **Rust** book](https://doc.rust-lang.org/book/ "Book") and https://www.example.com/a.');
  assert.deepEqual(links, [
    { url: 'https://doc.rust-lang.org/book/', label: 'the Rust book' },
    { url: 'https://www.example.com/a', label: 'example.com/a' },
  ]);
});

test('bare URLs stop at punctuation and unopened parentheses', () => {
  const urls = extractLinks('(see https://en.wikipedia.org/wiki/Thread_(computing)), or <https://a.dev/x>; https://b.dev/y?q=1!').map((link) => link.url);
  assert.deepEqual(urls, ['https://en.wikipedia.org/wiki/Thread_(computing)', 'https://a.dev/x', 'https://b.dev/y?q=1']);
});

test('code is skipped, other schemes are dropped and each URL appears once', () => {
  const text = 'Run `curl https://skip.dev` first.\n\n```sh\ncurl https://skip.dev/also\n```\n\n[mail](mailto:a@b.c) [one](https://x.dev) https://x.dev [file](file:///etc/passwd)';
  assert.deepEqual(extractLinks(text), [{ url: 'https://x.dev', label: 'one' }]);
  assert.deepEqual(extractLinks(''), []);
});

test('only http and https with a host open in the pane', () => {
  assert.equal(isWebUrl('https://gpui-kit.com'), true);
  assert.equal(isWebUrl('http://localhost:3000/x'), true);
  assert.equal(isWebUrl('https://'), false);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(shortUrl('https://www.example.com/'), 'example.com');
});
