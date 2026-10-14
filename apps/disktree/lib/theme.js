export const DEFAULT = {
  background: "#1a1b26",
  surface: "#24283b",
  inset: "#13141c",
  foreground: "#a9b1d6",
  bright: "#c0caf5",
  accent: "#7aa2f7",
  selection: "#292e42",
  border: "#414868",
  danger: "#f7768e",
  warning: "#e0af68",
  success: "#9ece6a",
};
export function parsePalette(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([\w-]+)\s*=\s*["'](#?[0-9a-fA-F]{6})["']/.exec(line);
    if (match) values[match[1]] = "#" + match[2].replace(/^#/, "");
  }
  if (!values.background || !values.foreground)
    throw new Error("Theme needs background and foreground.");
  return {
    ...DEFAULT,
    ...values,
    surface: values.surface ?? values.color0 ?? DEFAULT.surface,
    accent: values.accent ?? values.color4 ?? DEFAULT.accent,
    border: values.border ?? values.color8 ?? DEFAULT.border,
    bright: values.bright ?? values.color15 ?? values.foreground,
    danger: values.color1 ?? DEFAULT.danger,
    success: values.color2 ?? DEFAULT.success,
    warning: values.color3 ?? DEFAULT.warning,
  };
}
export async function systemPalette(fs, home) {
  const current = `${home}/.local/state/omarchy/current`;
  let root = current;
  try {
    await fs.stat(current);
  } catch {
    root = `${home}/.config/omarchy/current`;
  }
  try {
    return parsePalette(await fs.readFile(`${root}/theme/colors.toml`, "utf8"));
  } catch {
    return DEFAULT;
  }
}
