import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { expandHome } from "../config.js";
import { SKILL_NAME } from "../constants.js";
import { ImagegenError } from "../errors.js";
import { pathExists, writeFileAtomic } from "../util/fs.js";
import { isRecord } from "../util/http.js";
import { findSkillsNamed, installSkillDir, opencodeSkillRoots, removeSkillDir } from "./skill.js";

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg ? expandHome(xdg) : path.join(os.homedir(), ".config"), "opencode");
}

/** opencode reads opencode.jsonc or opencode.json; prefer whichever exists. */
export async function resolveOpencodeConfigFile(dir: string): Promise<{ file: string; exists: boolean }> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(dir, name);
    if (await pathExists(file)) return { file, exists: true };
  }
  return { file: path.join(dir, "opencode.json"), exists: false };
}

export interface OpencodeInstallOptions {
  scope: "global" | "project";
  projectDir: string;
  serverName: string;
  command: string[];
  environment?: Record<string, string>;
  /** opencode applies this to every MCP request, including tool calls (progress resets it). */
  timeoutMs: number;
  installSkill: boolean;
  dryRun: boolean;
  force: boolean;
  configDir?: string;
}

export interface InstallStep {
  action: string;
  path: string;
}

export interface InstallReport {
  configFile: string;
  entry: Record<string, unknown>;
  steps: InstallStep[];
  warnings: string[];
  skillDir?: string;
}

function detectFormatting(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indented = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indented?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indented ? Math.min(8, indented.length) : 2, eol };
}

function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ImagegenError("invalid_input", `Cannot parse ${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}. Fix the file and retry.`);
  }
  if (value !== undefined && !isRecord(value)) throw new ImagegenError("invalid_input", `${file} does not contain a JSON object.`);
  return (value as Record<string, unknown> | undefined) ?? {};
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function writeConfig(file: string, text: string, existed: boolean): Promise<void> {
  const mode = existed ? ((await fs.stat(file)).mode & 0o777) : 0o644;
  await writeFileAtomic(file, text, mode);
}

/**
 * Add (or update) the MCP server entry in opencode.json[c] — preserving comments and formatting —
 * and install the bundled skill where opencode discovers it.
 */
export async function installOpencode(o: OpencodeInstallOptions): Promise<InstallReport> {
  const configDir = o.scope === "global" ? (o.configDir ?? opencodeConfigDir()) : o.projectDir;
  const { file, exists } = await resolveOpencodeConfigFile(configDir);
  const original = exists ? await fs.readFile(file, "utf8") : `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
  const config = parseConfig(original, file);
  const entry: Record<string, unknown> = { type: "local", command: o.command, enabled: true, timeout: o.timeoutMs };
  if (o.environment && Object.keys(o.environment).length > 0) entry.environment = o.environment;

  const report: InstallReport = { configFile: file, entry, steps: [], warnings: [] };
  const mcp = isRecord(config.mcp) ? config.mcp : {};
  const current = mcp[o.serverName];
  if (current !== undefined && sameJson(current, entry)) {
    report.steps.push({ action: "MCP entry already up to date", path: file });
  } else {
    if (current !== undefined && !o.force) {
      const cmd = isRecord(current) && Array.isArray(current.command) ? current.command.join(" ") : "";
      if (!cmd.includes("codex-imagegen-mcp") && !cmd.includes("cli.js")) {
        throw new ImagegenError(
          "invalid_input",
          `${file} already has an MCP server named "${o.serverName}" that doesn't look like this one (${cmd || "unknown command"}). Use --name to pick another name, or --force to replace it.`,
        );
      }
    }
    const edits = modify(original, ["mcp", o.serverName], entry, { formattingOptions: detectFormatting(original) });
    const updated = applyEdits(original, edits);
    parseConfig(updated, file); // sanity check before writing
    if (!o.dryRun) {
      if (exists) {
        const backup = `${file}.codex-imagegen-mcp.bak`;
        await fs.copyFile(file, backup);
        report.steps.push({ action: "Backed up config", path: backup });
      }
      await writeConfig(file, updated, exists);
    }
    report.steps.push({ action: `${current === undefined ? "Added" : "Updated"} MCP server "${o.serverName}"`, path: file });
  }
  for (const [name, value] of Object.entries(mcp)) {
    if (name === o.serverName || !isRecord(value) || !Array.isArray(value.command)) continue;
    if (value.command.join(" ").includes("codex-imagegen-mcp")) {
      report.warnings.push(`Another MCP entry "${name}" also runs codex-imagegen-mcp; remove it to avoid duplicate tools.`);
    }
  }

  if (o.installSkill) {
    const skillDir =
      o.scope === "global" ? path.join(configDir, "skills", SKILL_NAME) : path.join(o.projectDir, ".opencode", "skills", SKILL_NAME);
    const result = await installSkillDir(skillDir, { force: o.force, dryRun: o.dryRun });
    report.skillDir = skillDir;
    report.steps.push({ action: `Skill ${result.action}`, path: skillDir });
    if (result.warning) report.warnings.push(result.warning);
    const roots = opencodeSkillRoots(o.scope === "global" ? configDir : opencodeConfigDir(), o.scope === "project" ? o.projectDir : undefined);
    const others = (await findSkillsNamed(SKILL_NAME, roots)).filter((d) => path.resolve(d) !== path.resolve(skillDir));
    for (const other of others) {
      report.warnings.push(
        `Another skill named "${SKILL_NAME}" exists at ${other}. opencode picks one of duplicate skills unpredictably — remove or rename it.`,
      );
    }
  }
  return report;
}

export async function uninstallOpencode(o: Pick<OpencodeInstallOptions, "scope" | "projectDir" | "serverName" | "dryRun" | "configDir"> & { keepSkill: boolean }): Promise<InstallReport> {
  const configDir = o.scope === "global" ? (o.configDir ?? opencodeConfigDir()) : o.projectDir;
  const { file, exists } = await resolveOpencodeConfigFile(configDir);
  const report: InstallReport = { configFile: file, entry: {}, steps: [], warnings: [] };
  if (exists) {
    const original = await fs.readFile(file, "utf8");
    const config = parseConfig(original, file);
    if (isRecord(config.mcp) && config.mcp[o.serverName] !== undefined) {
      const updated = applyEdits(original, modify(original, ["mcp", o.serverName], undefined, { formattingOptions: detectFormatting(original) }));
      if (!o.dryRun) {
        await fs.copyFile(file, `${file}.codex-imagegen-mcp.bak`);
        await writeConfig(file, updated, true);
      }
      report.steps.push({ action: `Removed MCP server "${o.serverName}"`, path: file });
    } else {
      report.steps.push({ action: `No MCP server named "${o.serverName}"`, path: file });
    }
  } else {
    report.steps.push({ action: "No opencode config found", path: file });
  }
  if (!o.keepSkill) {
    const skillDir =
      o.scope === "global" ? path.join(configDir, "skills", SKILL_NAME) : path.join(o.projectDir, ".opencode", "skills", SKILL_NAME);
    const r = await removeSkillDir(skillDir, { dryRun: o.dryRun });
    report.steps.push({ action: r === "removed" ? "Removed skill" : r === "not-ours" ? "Skill not installed by us; left untouched" : "No skill installed", path: skillDir });
  }
  return report;
}
