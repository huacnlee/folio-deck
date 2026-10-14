// Default user-level locations, verified against vercel-labs/skills/src/agents.ts.
// The shared .agents directory also serves Cline, Pi, Zed and other agents.
export const AGENT_DIRECTORIES = [
  {"id": "claude", "label": "Claude", "directory": ".claude/skills"},
  {"id": "codex", "label": "Codex", "directory": ".codex/skills"},
  {"id": "agents", "label": "Agents", "directory": ".agents/skills"},
  {"id": "cursor", "label": "Cursor", "directory": ".cursor/skills"},
  {"id": "gemini", "label": "Gemini CLI", "directory": ".gemini/skills"},
  {"id": "antigravity", "label": "Antigravity", "directory": ".gemini/antigravity/skills"},
  {"id": "copilot", "label": "GitHub Copilot", "directory": ".copilot/skills"},
  {"id": "opencode", "label": "OpenCode", "directory": ".config/opencode/skills"},
  {"id": "amp", "label": "Amp / shared", "directory": ".config/agents/skills"},
  {"id": "goose", "label": "Goose", "directory": ".config/goose/skills"},
  {"id": "continue", "label": "Continue", "directory": ".continue/skills"},
  {"id": "roo", "label": "Roo Code", "directory": ".roo/skills"},
  {"id": "kilo", "label": "Kilo Code", "directory": ".kilo/skills"},
  {"id": "kiro", "label": "Kiro CLI", "directory": ".kiro/skills"},
  {"id": "factory", "label": "Droid", "directory": ".factory/skills"},
  {"id": "windsurf", "label": "Windsurf", "directory": ".codeium/windsurf/skills"},
  {"id": "qwen", "label": "Qwen Code", "directory": ".qwen/skills"},
  {"id": "trae", "label": "Trae", "directory": ".trae/skills"},
  {"id": "openhands", "label": "OpenHands", "directory": ".openhands/skills"},
  {"id": "openclaw", "label": "OpenClaw", "directory": ".openclaw/skills"},
];

export function rootsForHome(home) {
  return AGENT_DIRECTORIES.map(({ id, label, directory }) => ({ id, label, path: `${home}/${directory}` }));
}
