// @ts-check
// The app follows the host's own light or dark theme; these are only the
// colours that sit on the white sheet of paper, which stays white in both.

export const palette = {
  paper: "#ffffff",
  paperInk: "#111114",
  placeholder: "#e8e8ec",
  /** The one accent: the save action, selection and the document badge. */
  accent: "#2563eb",
  accentHover: "#1d4ed8",
  accentSoft: "#2563eb1f",
  selection: "#3b82f6",
  selectionSoft: "#3b82f633",
  thumbBar: "#c4c4ca",
  /** Ink colours offered in the signature pad. */
  inks: ["#1f2a6b", "#111114", "#1d4ed8"],
};

export const fonts = {
  serif: "Times New Roman",
  sans: "Helvetica",
  mono: "Menlo",
};

/** Stroke weights offered in the signature pad, in pad pixels. */
export const weights = [
  { id: "thin", label: "Thin", px: 1.6 },
  { id: "medium", label: "Medium", px: 2.6 },
  { id: "bold", label: "Bold", px: 3.8 },
];
