import { set_theme } from 'gpui-base';
import { DEFAULT } from './lib/theme.js';
export function applyPalette(palette = DEFAULT) {
  const light = parseInt(palette.background.slice(1, 3), 16) > 170;
  set_theme({ appearance: light ? 'light' : 'dark', tokens: {
    colors: { background: palette.background, surface: palette.surface, foreground: palette.foreground,
      surface_foreground: palette.foreground, primary: palette.accent, primary_foreground: palette.background,
      secondary: palette.surface, secondary_foreground: palette.foreground, muted: palette.surface,
      muted_foreground: palette.foreground, accent: palette.selection, accent_foreground: palette.bright,
      border: palette.border, input: palette.border, ring: palette.accent, destructive: palette.danger,
      destructive_foreground: palette.background, selection: palette.selection },
    radius: { none: 0, sm: 0, md: 0, lg: 0, xl: 0, full: 0 },
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  } });
}
