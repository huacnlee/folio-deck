import { set_theme } from "gpui-base";

/** Night-navy surfaces with a bright marine blue accent, as in the OceanView concept. */
const colors = {
  background: "#0a1120",
  foreground: "#e6ecf7",
  surface: "#0e182b",
  surface_foreground: "#e6ecf7",
  primary: "#2f6bff",
  primary_foreground: "#ffffff",
  secondary: "#121e34",
  secondary_foreground: "#d5def0",
  muted: "#16233b",
  muted_foreground: "#8796b3",
  accent: "#13284d",
  accent_foreground: "#ffffff",
  destructive: "#ef4444",
  destructive_foreground: "#ffffff",
  border: "#1c2a44",
  input: "#0c1628",
  ring: "#3b6fe0",
  selection: "#1d3f80",
};

/** Domain colours the semantic palette has no role for. */
export const palette = {
  sidebar: "#0b1324",
  card: "#0d1729",
  cardBorder: "#1b2942",
  navActive: "#163a7a",
  navActiveBorder: "#2a59b8",
  link: "#4f8bff",
  online: "#22c55e",
  amber: "#f5a524",
  red: "#ef4444",
  blue: "#3b82f6",
  track: "#1b2840",
  fuel: "#22c55e",
  consumption: "#2f6bff",
  sea: { top: "#0a2a5e", bottom: "#061a40" },
  land: "#070e1b",
  landEdge: "#4f7fc4",
  surf: "#4a78b8",
  route: "#4f86ff",
  label: "#0c1a33e6",
  labelBorder: "#2f5598",
};

export function applyTheme() {
  set_theme({
    appearance: "dark",
    tokens: {
      colors,
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 6, md: 8, lg: 10, xl: 14, full: 9999 },
      typography: { md: { size: 14 }, sm: { size: 13 }, xs: { size: 12 } },
    },
  });
}
