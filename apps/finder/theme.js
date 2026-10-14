import { set_theme } from 'gpui-base';
import { DEFAULT, mix } from './lib/theme.js';

const alpha = (color, value) => color + Math.round(value * 255).toString(16).padStart(2, '0');

// Omarchy roles derived from the active palette. Interaction states are
// foreground-tinted alphas shared by every control, never accent fills.
export const tones = {};

export function applyPalette(palette = DEFAULT) {
  const light = parseInt(palette.background.slice(1, 3), 16) > 170;
  const fg = palette.foreground;
  Object.assign(tones, {
    background: palette.background,
    inset: palette.inset,
    foreground: fg,
    bright: palette.bright,
    secondary: mix(palette.background, fg, 0.75),
    accent: palette.accent,
    danger: palette.danger,
    normal: alpha(fg, 0.04),
    controlBorder: alpha(fg, 0.4),
    hover: alpha(fg, 0.08),
    selected: alpha(fg, 0.18),
    pressed: alpha(fg, 0.22),
    divider: alpha(fg, 0.12),
    scrim: '#00000099',
    clear: '#00000000',
  });
  set_theme({ appearance: light ? 'light' : 'dark', tokens: {
    colors: { background: palette.background, surface: palette.surface, foreground: fg,
      surface_foreground: fg, primary: palette.accent, primary_foreground: palette.background,
      secondary: palette.surface, secondary_foreground: fg, muted: palette.surface,
      muted_foreground: tones.secondary, accent: tones.selected, accent_foreground: palette.bright,
      border: tones.controlBorder, input: tones.controlBorder, ring: palette.accent, destructive: palette.danger,
      destructive_foreground: palette.background, selection: alpha(fg, 0.35) },
    radius: { none: 0, sm: 0, md: 0, lg: 0, xl: 0, full: 0 },
    spacing: { xxs: 2, xs: 3, sm: 4, md: 6, lg: 8, xl: 10, xxl: 12 },
  } });
}
