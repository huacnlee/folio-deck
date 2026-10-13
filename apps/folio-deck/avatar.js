// Generated avatars in the style of the Folio artwork in forma/assets: a
// paper-coloured tile with one geometric motif. Everything is derived from the
// email address, so one correspondent always gets the same tile and different
// addresses get different ones. Geometry is plain data on a 64×64 grid; the
// view turns it into native paths.

// [ground, deep, light, ink] — the first six are the original artwork's.
export const avatarPalettes = [
  ['#eee3cf', '#b29b76', '#e1cfad', '#71614b'], ['#ede6d9', '#ad9c83', '#d8cbb5', '#7c6c56'],
  ['#f9e4da', '#d99f87', '#f8d1ba', '#aa6c59'], ['#e9e5da', '#a3a18b', '#dedccd', '#75785f'],
  ['#eee0d8', '#b89482', '#e2c9ba', '#85594a'], ['#faefd5', '#b9a376', '#eedbad', '#86703f'],
  ['#e3e9e2', '#8fa394', '#cfdcd1', '#4d6a5c'], ['#e2e6ec', '#8d98ab', '#ccd3de', '#536079'],
  ['#ece2e8', '#a88a9f', '#dccbd6', '#775370'], ['#efe4dc', '#c08e6c', '#ead2bf', '#8b5e3c'],
  ['#dde9e8', '#7fa5a2', '#c4dbd9', '#3f6663'], ['#e6e9d8', '#a3ab76', '#d6dcb8', '#5f6a36'],
  ['#f3e0e0', '#c98b8b', '#ecc9c9', '#8e4f4f'], ['#e4e2ef', '#9890b8', '#d0cce4', '#5a5285'],
  ['#dfe7ef', '#7d9cbc', '#c7d7e7', '#3f5f80'], ['#f2e6d4', '#c99a5b', '#ebd3ad', '#8a5a22'],
];

export function emailAddress(value) {
  const source = String(value || '').trim();
  return (source.match(/<([^<>]+)>/)?.[1] || source).trim().toLowerCase();
}

// FNV-1a, then a murmur3 finalizer so every bit range is well mixed.
function hash(value) {
  let h = Array.from(value).reduce((h, char) => Math.imul(h ^ char.codePointAt(0), 16777619), 2166136261);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const circle = (cx, cy, r) => [['M', cx + r, cy], ['A', r, cx - r, cy], ['A', r, cx + r, cy], ['Z']];
// A vertical pill: rx equals half the width, as in the original artwork.
const pill = (x, y, w, h) => { const r = w / 2; return [['M', x, y + r], ['A', r, x + w, y + r], ['L', x + w, y + h - r], ['A', r, x, y + h - r], ['Z']]; };
const polygon = points => [['M', ...points[0]], ...points.slice(1).map(p => ['L', ...p]), ['Z']];
const fill = (color, ops) => ({ color, ops });
const stroke = (color, width, ops) => ({ color, width, ops });

const star = (points, outer, inner) => polygon(Array.from({ length: points * 2 }, (_, i) => {
  const angle = Math.PI * i / points - Math.PI / 2, r = i % 2 ? inner : outer;
  return [32 + r * Math.cos(angle), 32 + r * Math.sin(angle)];
}));

// Each motif is one of the original tiles; `v` (0..3) picks a variant that
// changes its silhouette, so tiles differ even where rotation would not.
const motifs = [
  ([, deep, light, ink], v) => [fill(deep, circle(32, 32, 19)), fill(light, v & 1 ? circle(41, 23, 9) : circle(40, 25, 13)),
    v & 2 ? fill(ink, circle(26, 38, 5)) : stroke(ink, 5, [['M', 13, 48], ['L', 47, 14]])],
  ([, deep, light, ink], v) => [...(v & 1
    ? [fill(deep, pill(10, 15, 18, 34)), fill(light, pill(23, 15, 18, 34)), fill(ink, pill(36, 15, 18, 34))]
    : [fill(deep, pill(12, 15, 26, 34)), fill(light, pill(27, 15, 26, 34))]),
    ...(v & 2 ? [] : [stroke(ink, 4, [['M', v & 1 ? 32 : 26, 15], ['L', v & 1 ? 32 : 26, 49]])])],
  ([, deep, light, ink], v) => [fill(deep, polygon([[32, 9], [54, 49], [10, 49]])),
    ...(v & 1 ? [fill(light, polygon([[32, 25], [44, 45], [20, 45]]))] : [fill(light, circle(32, 34, 12))]),
    fill(ink, circle(32, v & 1 ? 39 : 34, v & 2 ? 3 : 5))],
  ([, deep, light, ink], v) => [fill(deep, circle(32, 32, 19)), stroke(light, v & 1 ? 5 : 8, [['M', 13, 32], ['L', 51, 32], ['M', 32, 13], ['L', 32, 51]]),
    fill(ink, circle(32, 32, 6)), ...(v & 2 ? [fill(light, circle(32, 32, 2.5))] : [])],
  ([, deep, light, ink], v) => [fill(deep, v & 1 ? star(8, 22, 12) : star(4, 22, 8)), fill(v & 2 ? ink : light, circle(32, 32, v & 1 ? 8 : 7))],
  (palette, v) => {
    const order = [[3, 1, 2], [2, 1, 3], [1, 3, 2], [3, 2, 1]][v];
    return [[12, 24, 17], [27, 39, 17], [42, 52, 23]].map(([x0, x1, top], i) => fill(palette[order[i]], polygon([[x0, 47], [x0, top], [x1, top], [x1, 47]])));
  },
  ([, deep, light, ink], v) => [fill(light, v & 1 ? circle(32, 32, 20) : circle(24, 32, 15)), fill(deep, v & 1 ? circle(38, 32, 12) : circle(40, 32, 15)),
    v & 2 ? fill(ink, circle(v & 1 ? 40 : 32, 32, 4)) : stroke(ink, 4, [['M', 32, 17], ['L', 32, 47]])],
];

// Mirror, then rotate the 64×64 grid about its centre in 45° steps. Arcs run
// clockwise (SVG sweep 1) on screen; mirroring reverses that, rotation keeps it.
function transform(layers, mirror, eighths) {
  const angle = eighths * Math.PI / 4, cos = Math.cos(angle), sin = Math.sin(angle);
  const round = value => Math.round(value * 100) / 100;
  const point = (x, y) => {
    if (mirror) x = 64 - x;
    return [round(32 + (x - 32) * cos - (y - 32) * sin), round(32 + (x - 32) * sin + (y - 32) * cos)];
  };
  return layers.map(layer => ({ ...layer, ops: layer.ops.map(op => op[0] === 'Z' ? op : op[0] === 'A' ? ['A', op[1], ...point(op[2], op[3]), !mirror] : [op[0], ...point(op[1], op[2])]) }));
}

/** The avatar for an address (or a "Name <address>" header) as plain data. */
export function avatarFor(sender) {
  const h = hash(emailAddress(sender) || '?');
  const palette = avatarPalettes[h % avatarPalettes.length];
  const motif = Math.floor(h / avatarPalettes.length) % motifs.length;
  let rest = Math.floor(h / (avatarPalettes.length * motifs.length));
  const take = count => { const value = rest % count; rest = Math.floor(rest / count); return value; };
  const variant = take(4), mirror = take(2) === 1, swap = take(2) === 1;
  // The triangle and bars only turn in quarters, so they never stand on a corner.
  const eighths = motif === 2 || motif === 5 ? take(4) * 2 : take(8);
  const colors = swap ? [palette[0], palette[2], palette[1], palette[3]] : palette;
  const layers = transform(motifs[motif](colors, variant), mirror, eighths);
  return { ground: palette[0], motif, layers };
}
