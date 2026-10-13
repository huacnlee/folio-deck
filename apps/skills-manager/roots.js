// The agent folders this copy may manage. The committed file names none, so a
// checkout runs with Discover only; `node scripts/install.mjs` writes the
// installed copy's version of this file and the command grants it needs.

/** @type {{ id: string, label: string, path: string }[]} */
export const agentRoots = [];
/** Folders Import may read from, besides the agent folders. @type {string[]} */
export const importRoots = [];
/** The home directory, for showing paths as ~/… */
export const home = "";
/** gpui-shell's data home, where the app's data folder is found. */
export const dataHome = "";
