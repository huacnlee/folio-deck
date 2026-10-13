import { set_theme } from "gpui-base";

/** The face for codes, tags and labels. */
export const monoFont = "Menlo";

/** Cool neutral surfaces with near-black ink, as in the Tendra concept. */
const colors = {
  background: "#f4f4f6",
  foreground: "#18181b",
  surface: "#ffffff",
  surface_foreground: "#18181b",
  primary: "#18181b",
  primary_foreground: "#ffffff",
  secondary: "#f7f7f8",
  secondary_foreground: "#27272a",
  muted: "#ececee",
  muted_foreground: "#71717a",
  accent: "#efeff1",
  accent_foreground: "#18181b",
  destructive: "#d23c3c",
  destructive_foreground: "#ffffff",
  border: "#e6e6e9",
  input: "#ffffff",
  ring: "#a1a1aa",
  selection: "#dfe5fb",
};

/**
 * Domain colours the semantic palette has no role for: one per pipeline stage,
 * one per tag tone and one per teammate.
 */
export const palette = {
  stage: {
    gonogo: "#a1a1aa",
    drafting: "#3f5fd8",
    review: "#c98a12",
    submitted: "#18181b",
    awarded: "#1f7a4d",
  },
  /** Unfilled ticks of a summary meter. */
  /** The main panel's hairline, lighter than `border` so the shadow carries the edge. */
  panelBorder: "#ececef",
  tick: "#e4e4e7",
  track: "#ececee",
  tone: {
    neutral: { bg: "#f4f4f5", border: "#e4e4e7", fg: "#52525b" },
    amber: { bg: "#fdf6e7", border: "#f1dcae", fg: "#93620b" },
    blue: { bg: "#eef2fe", border: "#cdd7fa", fg: "#3149b8" },
    green: { bg: "#edf8f1", border: "#c8e8d4", fg: "#1f7a4d" },
    red: { bg: "#fdf0f0", border: "#f5cccc", fg: "#c23535" },
    orange: { bg: "#fdf4e8", border: "#f3d9b3", fg: "#a8610b" },
  },
  people: {
    DO: { bg: "#eef0fb", fg: "#3d4a8a", ring: "#d9ddf3" },
    LS: { bg: "#f2eefb", fg: "#5d4597", ring: "#e0d8f3" },
    MK: { bg: "#f1f1f2", fg: "#52525b", ring: "#e1e1e4" },
    RJ: { bg: "#ecf6ef", fg: "#2f6b45", ring: "#d3e9da" },
  },
  live: "#1f9d55",
  alert: "#e5484d",
};

export function applyTheme() {
  set_theme({
    appearance: "light",
    tokens: {
      colors,
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 6, md: 8, lg: 12, xl: 16, full: 9999 },
      typography: { mono: monoFont, md: { size: 14 }, sm: { size: 13 }, xs: { size: 12 } },
    },
  });
}
