import { set_theme } from "gpui-base";
import { DEFAULT } from "./lib/theme.js";
export function applyPalette(palette = DEFAULT) {
  const light = parseInt(palette.background.slice(1, 3), 16) > 170;
  set_theme({
    appearance: light ? "light" : "dark",
    tokens: {
      colors: {
        background: palette.background,
        surface: palette.surface,
        foreground: palette.foreground,
        surface_foreground: palette.foreground,
        primary: palette.accent,
        primary_foreground: palette.background,
        secondary: palette.surface,
        secondary_foreground: palette.foreground,
        muted: palette.surface,
        muted_foreground: palette.foreground,
        accent: palette.selection,
        accent_foreground: palette.bright,
        border: palette.border,
        input: palette.border,
        ring: palette.accent,
        destructive: palette.danger,
        destructive_foreground: palette.background,
        selection: palette.selection,
      },
      radius: { none: 0, sm: 3, md: 6, lg: 8, xl: 12, full: 9999 },
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    },
  });
}

export const palette = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  text: "#272b35",
  muted: "#858994",
  border: "#e5e7ec",
  accent: "#7666c6",
  orange: "#c78343",
};
export const mapColors = [
  "#69abef", // blue
  "#b493ed", // violet
  "#53c5a4", // mint
  "#58c4db", // cyan
  "#859be5", // indigo
  "#e89abe", // rose
  "#93b4cd", // slate
  "#efbe60", // amber
];

export const tones = {"selection": "#ddd8f0", "danger": "#c35555", "success": "#5c998e", "activeSurface": "#ece8f7", "activeBorder": "#ddd6ef", "activeHover": "#e3dcf3", "quietSurface": "#f1f2f5", "breadcrumbCurrent": "#f1eef8", "breadcrumbHover": "#ece8f5", "separatorIcon": "#b8bdc7", "checkBorder": "#c9ced8", "onAccent": "#ffffff", "markedFill": "#ee9870", "selectedBorder": "#51429c", "reclaimPattern": "#77522110", "mapHeader": "#ffffff35", "mapMetadata": "#52627a", "markedText": "#904326", "markedBadge": "#fff4e8", "mapValue": "#425570", "mapSecondary": "#64758b", "segmentSurface": "#f0edf8", "segmentBorder": "#e5def4", "segmentText": "#837993", "segmentPressed": "#6959b5", "segmentHover": "#e7e1f3", "mapCanvas": "#edf0f4", "progressTrack": "#e6e9f2", "rowHover": "#f5f4f9", "suggestionTrack": "#f0eef5", "warningSurface": "#fff6e9", "warningBorder": "#efdfc4", "warningIcon": "#a77736", "warningText": "#886438", "warningHover": "#f5e7d2"};

// Close endpoints keep category color stable without a glossy light/dark sweep.
export const mapGradients = [
  ["#8bbced", "#7bb2e7"], ["#c4aceb", "#b99fe3"],
  ["#7cd3b8", "#6cc8aa"], ["#85d4e5", "#75cbdc"],
  ["#a3b4ec", "#96a9e3"], ["#edb3cf", "#e4a6c4"],
  ["#b0c9dc", "#a3bfd4"], ["#f1cd86", "#eac276"],
];
export const markedGradient = ["#f1b28d", "#eaa37e"];
export const motion = { duration: 180, easing: "ease-out" };

// Shared alignment spine for map contents, legend, and window status.
export const layout = { contentInset: 20, mapInset: 4, tileInset: 1 };

tones.mapBoundary = "#31415a30";
