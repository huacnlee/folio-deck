// Runtime paths; no generated configuration or external installer is needed.
import { homedir } from "os";
import { rootsForHome } from "./lib/agents.js";
export const home = homedir();
export const agentRoots = rootsForHome(home);
export const importRoots = [`${home}/Downloads`];
