// @ts-check
import { set_theme } from "gpui-base";

/** The face for ticket ids and section labels. */
export const monoFont = "Menlo";

/** @typedef {"dark" | "light"} Mode */

const dark = {
  background: "#18181b",
  foreground: "#ededef",
  surface: "#212124",
  surface_foreground: "#ededef",
  primary: "#fcd34d",
  primary_foreground: "#1c1a12",
  secondary: "#1d1d20",
  secondary_foreground: "#d4d4d8",
  muted: "#2a2a2e",
  muted_foreground: "#9b9ba3",
  accent: "#2b2b2f",
  accent_foreground: "#ededef",
  destructive: "#f0506e",
  destructive_foreground: "#ffffff",
  border: "#2c2c2f",
  input: "#1d1d20",
  ring: "#4b4b52",
  selection: "#3a3f55",
};

const light = {
  background: "#f6f6f7",
  foreground: "#18181b",
  surface: "#ffffff",
  surface_foreground: "#18181b",
  primary: "#fcd34d",
  primary_foreground: "#1c1a12",
  secondary: "#f1f1f3",
  secondary_foreground: "#27272a",
  muted: "#ececef",
  muted_foreground: "#71717a",
  accent: "#ebebee",
  accent_foreground: "#18181b",
  destructive: "#d93653",
  destructive_foreground: "#ffffff",
  border: "#e4e4e7",
  input: "#ffffff",
  ring: "#b4b4bb",
  selection: "#dfe5fb",
};

/**
 * Domain colours the semantic palette has no role for, and the layers of a
 * raised surface. Filled in by `applyTheme`, so read them at the use site,
 * never copy them.
 */
export const tone = {
  red: "#f0506e",
  orange: "#f5a524",
  pink: "#fb7185",
  /** Brand-coloured text and marks that must read on the surface. */
  ink: "#fcd34d",
  blue: "#38bdf8",
  green: "#2fbf71",
  /** The dim layer behind a dialog or sheet. */
  scrim: "#00000099",
  /** A raised surface (column, tile, active row) and what sits sunk in it. */
  raise: "#1f1f23",
  well: "#18181b",
  /** The three lines around a raised surface: outer ring, edge, lit top edge. */
  ring: "#0d0d0f",
  edge: "#2c2c2f",
  sheen: "#3b3b3e",
  /** Edge of a card sunk in a raised surface, and its lit top. */
  cardEdge: "#323234",
  cardSheen: "#3a3a3d",
  /** The faint halo around a card inside a raised surface. */
  cardRing: "#232327",
  /** Gloss of a neutral button, top to bottom. */
  glossTop: "#2e2e31",
  glossBottom: "#1d1d20",
  /** Gloss of the primary button, top to bottom. */
  primaryTop: "#f7da74",
  primaryBottom: "#fdcd12",
  /** Status pill colours: the dot, its text, the fill and the edge. */
  warning: { dot: "#ff8905", fg: "#ffb35c", bg: "#33160f", edge: "#5a200d" },
  breached: { dot: "#ff637e", fg: "#ff94a6", bg: "#390d1a", edge: "#660a28" },
  neutral: { dot: "#d4d4d8", fg: "#ededef", bg: "#27272a", edge: "#3c3c42" },
};

const toneByMode = {
  dark: { ...tone },
  light: {
    red: "#d93653", orange: "#d97706", pink: "#e11d74", ink: "#a16207", blue: "#0284c7", green: "#16a34a",
    scrim: "#18181b40",
    raise: "#f1f1f3", well: "#ffffff",
    ring: "#dcdce0", edge: "#e4e4e7", sheen: "#ffffff",
    cardEdge: "#e4e4e7", cardSheen: "#ffffff", cardRing: "#ececef",
    glossTop: "#ffffff", glossBottom: "#f1f1f3",
    primaryTop: "#fde68a", primaryBottom: "#facc15",
    warning: { dot: "#ea7a0c", fg: "#b45309", bg: "#fff4e5", edge: "#fbd7a8" },
    breached: { dot: "#e11d48", fg: "#be123c", bg: "#fff0f3", edge: "#fecdd6" },
    neutral: { dot: "#71717a", fg: "#3f3f46", bg: "#f4f4f5", edge: "#e4e4e7" },
  },
};

/**
 * Blends two `#rrggbb` colours: `t` of the way from `a` to `b`.
 * @param {string} a @param {string} b @param {number} t @returns {`#${string}`}
 */
export function mix(a, b, t) {
  const channel = (/** @type {string} */ hex, /** @type {number} */ i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, "0"));
  return `#${out.join("")}`;
}

/** @param {Mode} mode */
export function applyTheme(mode) {
  Object.assign(tone, toneByMode[mode]);
  set_theme({
    appearance: mode,
    tokens: {
      colors: /** @type {any} */ (mode === "dark" ? dark : light),
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 6, md: 8, lg: 12, xl: 16, full: 9999 },
      typography: { mono: monoFont, md: { size: 14 }, sm: { size: 13 }, xs: { size: 12 } },
    },
  });
}
