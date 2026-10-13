import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUtf8, decodeUtf8 } from '../utf8.js';

const samples = ['', 'lease.pdf', '/Users/jason/Documents/租约 — signé.pdf', 'emoji 🖋️ and 𝄞', '\u0000\u007f\u0080߿ࠀ￿'];

test('encodeUtf8 matches TextEncoder', () => {
  for (const text of samples) assert.deepEqual(encodeUtf8(text), new TextEncoder().encode(text));
});

test('decodeUtf8 matches TextDecoder, including invalid bytes', () => {
  for (const text of samples) assert.equal(decodeUtf8(new TextEncoder().encode(text)), text);
  for (const bytes of [[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0x61, 0xf0, 0x9f, 0x92]]) {
    assert.equal(decodeUtf8(Uint8Array.from(bytes)), new TextDecoder().decode(Uint8Array.from(bytes)));
  }
  assert.equal(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
});
