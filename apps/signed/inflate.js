// @ts-check
// RFC 1950/1951 inflate in plain JavaScript, so PDF streams decode the same
// way in gpui-shell and in node. Stored, fixed and dynamic Huffman blocks.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table: counts per length and symbols in code order. */
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (const length of lengths) counts[length] += 1;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i += 1) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    if (lengths[symbol]) symbols[offsets[lengths[symbol]]++] = symbol;
  }
  return { counts, symbols };
}

let fixed = null;
function fixedTables() {
  if (!fixed) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
    fixed = { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
  }
  return fixed;
}

/**
 * Inflates `data`. With `zlib` (the default) a two-byte zlib header is
 * expected and skipped; raw deflate otherwise. Stops quietly at the end of the
 * input, so a stream truncated by a damaged PDF still yields what it held.
 * @param {Uint8Array} data
 * @param {{ zlib?: boolean }} [options]
 * @returns {Uint8Array}
 */
export function inflate(data, { zlib = true } = {}) {
  let pos = 0;
  if (zlib) {
    if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) throw new Error("not a zlib stream");
    pos = 2;
  }
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let outLen = 0;

  const need = (n) => {
    while (bitCount < n) {
      if (pos >= data.length) throw new RangeError("end of input");
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
  };
  const bits = (n) => {
    if (n === 0) return 0;
    need(n);
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = (table) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= bits(1);
      const count = table.counts[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("invalid Huffman code");
  };
  const grow = (extra) => {
    if (outLen + extra <= out.length) return;
    const next = new Uint8Array(Math.max(out.length * 2, outLen + extra));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCount = 0;
        if (pos + 4 > data.length) throw new RangeError("end of input");
        const len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        const chunk = data.subarray(pos, Math.min(data.length, pos + len));
        grow(chunk.length);
        out.set(chunk, outLen);
        outLen += chunk.length;
        pos += len;
        continue;
      }
      let lit, dist;
      if (type === 1) ({ lit, dist } = fixedTables());
      else if (type === 2) {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i += 1) clen[CLEN_ORDER[i]] = bits(3);
        const clTable = huffman(clen);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clTable);
          if (sym < 16) lengths[i++] = sym;
          else {
            let repeat, value = 0;
            if (sym === 16) { if (!i) throw new Error("repeat with no previous length"); value = lengths[i - 1]; repeat = 3 + bits(2); }
            else if (sym === 17) repeat = 3 + bits(3);
            else repeat = 11 + bits(7);
            while (repeat-- && i < lengths.length) lengths[i++] = value;
          }
        }
        lit = huffman(lengths.subarray(0, hlit));
        dist = huffman(lengths.subarray(hlit));
      } else throw new Error("invalid block type");

      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          grow(1);
          out[outLen++] = sym;
        } else if (sym === 256) break;
        else {
          const li = sym - 257;
          if (li >= 29) throw new Error("invalid length symbol");
          const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
          const di = decode(dist);
          if (di >= 30) throw new Error("invalid distance symbol");
          const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
          if (distance > outLen) throw new Error("distance too far back");
          grow(length);
          for (let i = 0; i < length; i += 1) out[outLen + i] = out[outLen - distance + i];
          outLen += length;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError) || outLen === 0) throw error;
  }
  return out.slice(0, outLen);
}
