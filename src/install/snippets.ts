import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_SOURCE_DIR } from "../constants.js";

export const CLIENTS = ["opencode", "claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex", "gemini"] as const;
export type ClientId = (typeof CLIENTS)[number];

export interface Snippet {
  client: ClientId;
  title: string;
  /** Where the snippet goes. */
  location: string;
  body: string;
  notes: string[];
}

/**
 * GUI apps often start without the shell PATH, so they need an absolute `node`. Prefer a stable
 * symlink (e.g. /opt/homebrew/bin/node) over a versioned Cellar path that breaks on upgrade.
 */
export function stableNodePath(): string {
  const exec = process.execPath;
  let real = exec;
  try {
    real = fs.realpathSync(exec);
  } catch {
    /* keep */
  }
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      /* not present */
    }
  }
  return exec;
}

function withAbsoluteNode(command: readonly string[]): string[] {
  return command[0] === "node" ? [stableNodePath(), ...command.slice(1)] : [...command];
}

/**
 * The launch command for GUI apps, which may start without the shell PATH: an absolute node plus
 * the absolute CLI script. (A global install's `codex-imagegen-mcp` launcher is `#!/usr/bin/env
 * node`, which fails when node isn't on the GUI app's PATH.)
 */
export function absoluteServerCommand(script: string): string[] {
  return [stableNodePath(), script, "serve"];
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function claudeDesktopConfigPath(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

const SKILL_NOTE = (dir: string) => `Skill (optional but recommended): copy ${SKILL_SOURCE_DIR} to ${dir}`;

export function clientSnippet(client: ClientId, serverName: string, command: readonly string[], absoluteCommand?: readonly string[]): Snippet {
  const [cmd = "node", ...args] = command;
  const abs = absoluteCommand ? [...absoluteCommand] : withAbsoluteNode(command);
  const [absCmd = "node", ...absArgs] = abs;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  switch (client) {
    case "opencode":
      return {
        client,
        title: "opencode",
        location: "~/.config/opencode/opencode.json (or ./opencode.json for one project) — or just run: codex-imagegen-mcp install opencode",
        body: json({ mcp: { [serverName]: { type: "local", command: [...command], enabled: true, timeout: 300000 } } }),
        notes: [
          "timeout applies to every MCP request; progress notifications reset it, 300000 ms is a safe ceiling.",
          SKILL_NOTE("~/.config/opencode/skills/imagegen-mcp"),
        ],
      };
    case "claude-code":
      return {
        client,
        title: "Claude Code",
        location: "run in a terminal",
        body: `claude mcp add --scope user ${shellQuote(serverName)} -- ${command.map(shellQuote).join(" ")}`,
        notes: ["For long generations, start Claude Code with MCP_TOOL_TIMEOUT=300000.", SKILL_NOTE("~/.claude/skills/imagegen-mcp")],
      };
    case "claude-desktop":
      return {
        client,
        title: "Claude Desktop",
        location: claudeDesktopConfigPath(),
        body: json({ mcpServers: { [serverName]: { command: absCmd, args: absArgs } } }),
        notes: ["Restart Claude Desktop after editing. Absolute paths are used because GUI apps may not inherit your shell PATH."],
      };
    case "cursor":
      return {
        client,
        title: "Cursor",
        location: "~/.cursor/mcp.json (global) or .cursor/mcp.json (project)",
        body: json({ mcpServers: { [serverName]: { command: cmd, args } } }),
        notes: ["If Cursor cannot find node, replace \"node\" with the absolute path: " + stableNodePath()],
      };
    case "vscode":
      return {
        client,
        title: "VS Code (GitHub Copilot agent mode)",
        location: ".vscode/mcp.json in your workspace (or the user-level mcp.json via “MCP: Open User Configuration”)",
        body: json({ servers: { [serverName]: { type: "stdio", command: cmd, args } } }),
        notes: [],
      };
    case "windsurf":
      return {
        client,
        title: "Windsurf",
        location: "~/.codeium/windsurf/mcp_config.json",
        body: json({ mcpServers: { [serverName]: { command: absCmd, args: absArgs } } }),
        notes: [],
      };
    case "codex":
      return {
        client,
        title: "OpenAI Codex CLI / IDE",
        location: "~/.codex/config.toml",
        body: `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(cmd)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\ntool_timeout_sec = 300`,
        notes: ["Codex already has a built-in image_gen tool when signed in with ChatGPT; this is mainly useful for API-key Codex setups."],
      };
    case "gemini":
      return {
        client,
        title: "Gemini CLI",
        location: "~/.gemini/settings.json",
        body: json({ mcpServers: { [serverName]: { command: cmd, args, timeout: 300000 } } }),
        notes: [],
      };
  }
}
