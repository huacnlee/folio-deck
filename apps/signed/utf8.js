// gpui-shell's QuickJS runtime has no TextEncoder or TextDecoder, so UTF-8 is
// converted by hand. Invalid sequences decode to U+FFFD, as TextDecoder does.

/** @param {string} text */
export function encodeUtf8(text) {
  const out = [];
  for (const char of text) {
    const code = /** @type {number} */ (char.codePointAt(0));
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/**
 * The WHATWG decoder: each maximal invalid subpart becomes one U+FFFD.
 * @param {Uint8Array} bytes
 */
export function decodeUtf8(bytes) {
  let text = "";
  let code = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  // Skip a byte-order mark.
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (needed === 0) {
      i += 1;
      if (byte < 0x80) text += String.fromCharCode(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; code = byte & 31; }
      else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2; code = byte & 15;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3; code = byte & 7;
      } else text += "�";
      continue;
    }
    if (byte < lower || byte > upper) {
      // Reprocess this byte as the start of the next sequence.
      text += "�";
      code = needed = seen = 0; lower = 0x80; upper = 0xbf;
      continue;
    }
    i += 1;
    lower = 0x80; upper = 0xbf;
    code = (code << 6) | (byte & 63);
    seen += 1;
    if (seen === needed) {
      text += String.fromCodePoint(code);
      code = needed = seen = 0;
    }
  }
  if (needed) text += "�";
  return text;
}
