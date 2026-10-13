import { set_theme } from "gpui-base";

/** Soft greys and near-black ink, as in the concept. */
const colors = {
  background: "#e6e6e6",
  foreground: "#1c1c1c",
  surface: "#ffffff",
  surface_foreground: "#1c1c1c",
  primary: "#2b2b2b",
  primary_foreground: "#ffffff",
  secondary: "#f7f7f7",
  secondary_foreground: "#2b2b2b",
  muted: "#f3f3f3",
  muted_foreground: "#777777",
  accent: "#f1f1f1",
  accent_foreground: "#1c1c1c",
  destructive: "#d33a32",
  destructive_foreground: "#ffffff",
  border: "#e7e7e7",
  input: "#e3e3e3",
  ring: "#a3a3a3",
  selection: "#dfe6fb",
};

/** Colours the semantic palette has no role for. */
export const palette = {
  rail: "#f6f6f6",
  railActive: "#ffffff",
  brand: "#d6f53d",
  brandInk: "#1c1c1c",
  segment: "#f2f2f2",
  subtle: "#9a9a9a",
  success: "#2f8f4e",
  warning: "#b8710f",
  /** One mark per author or agent folder. */
  marks: {
    Anthropic: { bg: "#d97757", fg: "#ffffff", letter: "A" },
    OpenAI: { bg: "#1c1c1c", fg: "#ffffff", letter: "O" },
    Vercel: { bg: "#000000", fg: "#ffffff", letter: "▲" },
    Claude: { bg: "#d97757", fg: "#ffffff", letter: "C" },
    Codex: { bg: "#1c1c1c", fg: "#ffffff", letter: "X" },
    Agents: { bg: "#4f5bd5", fg: "#ffffff", letter: "A" },
  },
};

export function applyTheme() {
  set_theme({
    appearance: "light",
    tokens: {
      colors,
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 6, md: 8, lg: 10, xl: 14, full: 9999 },
      typography: { md: { size: 14 }, sm: { size: 13 }, xs: { size: 12 } },
    },
  });
}
