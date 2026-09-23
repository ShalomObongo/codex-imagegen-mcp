import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { PACKAGE_ROOT, SKILL_NAME } from "../src/constants.js";
import { findClient, type Detection } from "../src/install/clients.js";
import type { InstallContext, Scope } from "../src/install/context.js";
import { resolveLaunch, type LaunchMode, type Runtime } from "../src/install/launch.js";
import { applyPlan, BACKUP_SUFFIX, planInstall, planUninstall, type ConfigChange, type InstallOptions, type Plan } from "../src/install/plan.js";
import { SKILL_MARKER } from "../src/install/skills.js";
import { tempDir } from "./helpers/env.js";

const RUNTIME: Runtime = { node: process.execPath, script: path.join(PACKAGE_ROOT, "dist", "src", "cli.js"), ephemeral: false, warnings: [] };
const POSIX = process.platform !== "win32";

async function sandbox(extraEnv: Record<string, string> = {}) {
  const home = await tempDir("imagegen-install-");
  const cwd = path.join(home, "project");
  await fs.mkdir(cwd, { recursive: true });
  const ctx: InstallContext = {
    platform: process.platform,
    home,
    cwd,
    env: {
      PATH: path.join(home, "bin"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      CODEX_IMAGEGEN_HOME: path.join(home, "data"),
      ...extraEnv,
    },
  };
  return { home, cwd, ctx };
}

function options(ctx: InstallContext, ids: string[], extra: Partial<InstallOptions> & { mode?: LaunchMode } = {}): InstallOptions {
  const scope: Scope = extra.scope ?? "global";
  const { mode, ...rest } = extra;
  return {
    ctx,
    scope,
    clients: ids.map((id) => findClient(id)!),
    serverName: "imagegen",
    launch: resolveLaunch({ mode: mode ?? (scope === "project" ? "npx" : "node"), scope }, ctx, RUNTIME),
    runtime: RUNTIME,
    timeoutMs: 300_000,
    mcp: true,
    skill: true,
    force: false,
    detections: new Map<string, Detection>(),
    claudeCli: null,
    ...rest,
  };
}

const configs = (plan: Plan) => plan.changes.filter((c): c is ConfigChange => c.kind === "config");
const actionOf = (plan: Plan, id: string) => configs(plan).find((c) => c.clients.some((cl) => cl.id === id))?.action;
const readJson = async (file: string) => parseJsonc(await fs.readFile(file, "utf8"), [], { allowTrailingComma: true });
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function write(file: string, text: string, mode?: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, mode === undefined ? undefined : { mode });
}

const OPENCODE_JSONC = `{
  // my opencode config — comments must survive
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "other": { "type": "remote", "url": "https://example.com/mcp" }, // keep me
  },
}
`;

describe("install engine", () => {
  test("installs into several clients at once, and a second run changes nothing", async () => {
    const { ctx, home } = await sandbox();
    const opencodeFile = path.join(home, ".config", "opencode", "opencode.jsonc");
    await write(opencodeFile, OPENCODE_JSONC);
    const ids = ["opencode", "cursor", "claude-code", "codex", "goose", "vscode"];
    const plan = await planInstall(options(ctx, ids));
    assert.equal(actionOf(plan, "opencode"), "add");
    for (const id of ids.slice(1)) assert.equal(actionOf(plan, id), "create", id);

    const results = await applyPlan(plan);
    assert.deepEqual(results.filter((r) => !r.ok), []);

    const text = await fs.readFile(opencodeFile, "utf8");
    assert.match(text, /comments must survive/);
    assert.match(text, /keep me/);
    const oc = parseJsonc(text, [], { allowTrailingComma: true });
    assert.deepEqual(oc.mcp.imagegen.command, [RUNTIME.node, RUNTIME.script, "serve"]);
    assert.equal(oc.mcp.imagegen.timeout, 300_000);
    assert.equal(oc.mcp.imagegen.environment.CODEX_IMAGEGEN_HOME, path.join(home, "data"), "pinned data dir");
    assert.equal(await fs.readFile(`${opencodeFile}${BACKUP_SUFFIX}`, "utf8"), OPENCODE_JSONC);

    assert.equal((await readJson(path.join(home, ".cursor", "mcp.json"))).mcpServers.imagegen.type, "stdio");
    assert.equal((await readJson(path.join(home, ".claude.json"))).mcpServers.imagegen.command, RUNTIME.node);
    const codex = parseToml(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(codex.mcp_servers.imagegen.tool_timeout_sec, 300);
    const goose = parseYaml(await fs.readFile(path.join(home, ".config", "goose", "config.yaml"), "utf8"));
    assert.equal(goose.extensions.imagegen.cmd, RUNTIME.node);

    // Claude Code only reads ~/.claude/skills; the rest share ~/.agents/skills.
    const skillDirs = plan.changes.filter((c) => c.kind === "skill").map((c) => c.kind === "skill" && c.dir);
    assert.deepEqual(skillDirs.sort(), [path.join(home, ".agents", "skills", SKILL_NAME), path.join(home, ".claude", "skills", SKILL_NAME)].sort());
    for (const dir of skillDirs) {
      await fs.access(path.join(dir as string, "SKILL.md"));
      await fs.access(path.join(dir as string, SKILL_MARKER));
    }

    const again = await planInstall(options(ctx, ids));
    assert.deepEqual([...new Set(again.changes.map((c) => c.action))], ["unchanged"]);
  });

  test("an entry that runs something else is a conflict unless forced", async () => {
    const { ctx, home } = await sandbox();
    const file = path.join(home, ".cursor", "mcp.json");
    await write(file, JSON.stringify({ mcpServers: { imagegen: { command: "python", args: ["other.py"] } } }, null, 2));
    const plan = await planInstall(options(ctx, ["cursor"], { skill: false }));
    assert.equal(actionOf(plan, "cursor"), "conflict");
    const results = await applyPlan(plan);
    assert.equal(results[0]?.ok, false);
    assert.equal((await readJson(file)).mcpServers.imagegen.command, "python", "untouched");

    const forced = await planInstall(options(ctx, ["cursor"], { skill: false, force: true }));
    assert.equal(actionOf(forced, "cursor"), "replace");
    await applyPlan(forced);
    assert.equal((await readJson(file)).mcpServers.imagegen.command, RUNTIME.node);
    // Our own older entry (different launch) is updated without --force.
    const npx = await planInstall(options(ctx, ["cursor"], { skill: false, mode: "npx" }));
    assert.equal(actionOf(npx, "cursor"), "update");
  });

  test("broken configs are reported and skipped; other clients are still installed", async () => {
    const { ctx, home } = await sandbox();
    await write(path.join(home, ".gemini", "settings.json"), '{ "mcpServers": { ');
    const plan = await planInstall(options(ctx, ["gemini", "droid"], { skill: false }));
    assert.equal(actionOf(plan, "gemini"), "error");
    assert.match(configs(plan)[0]?.reason ?? "", /can't parse/);
    const results = await applyPlan(plan);
    assert.deepEqual(results.map((r) => r.ok), [false, true]);
    assert.equal(await fs.readFile(path.join(home, ".gemini", "settings.json"), "utf8"), '{ "mcpServers": { ');
  });

  test("migrates skill copies from earlier releases and leaves the user's own skills alone", async () => {
    const { ctx, home } = await sandbox();
    const legacy = path.join(home, ".config", "opencode", "skills", "imagegen");
    await write(path.join(legacy, "SKILL.md"), "---\nname: imagegen\n---\n");
    await write(path.join(legacy, SKILL_MARKER), "{}");
    const mine = path.join(home, ".claude", "skills", "imagegen");
    await write(path.join(mine, "SKILL.md"), "---\nname: imagegen\ndescription: mine\n---\n");
    const plan = await planInstall(options(ctx, ["opencode"]));
    assert.deepEqual(plan.changes.filter((c) => c.kind === "legacy-skill").map((c) => c.kind === "legacy-skill" && c.dir), [legacy]);
    await applyPlan(plan);
    assert.equal(await exists(legacy), false);
    assert.equal(await exists(path.join(mine, "SKILL.md")), true);
    assert.equal(await exists(path.join(home, ".agents", "skills", SKILL_NAME, "SKILL.md")), true);
  });

  test("a folder holding someone else's skill of the same name is not used", async () => {
    const { ctx, home } = await sandbox();
    const foreign = path.join(home, ".agents", "skills", SKILL_NAME);
    await write(path.join(foreign, "SKILL.md"), `---\nname: ${SKILL_NAME}\ndescription: not ours\n---\n`);
    const plan = await planInstall(options(ctx, ["opencode"]));
    const skill = plan.changes.find((c) => c.kind === "skill");
    assert.equal(skill?.kind === "skill" && skill.dir, path.join(home, ".claude", "skills", SKILL_NAME), "falls back to another folder opencode reads");
    assert.ok(plan.warnings.some((w) => w.includes("another skill named")));
    const onlyGemini = await planInstall(options(ctx, ["gemini"]));
    assert.ok(onlyGemini.warnings.some((w) => w.includes("No skill for Gemini CLI")));
    assert.equal(onlyGemini.changes.some((c) => c.kind === "skill"), false);
  });

  test("uninstall removes only our entries, and keeps skill copies other clients still use", async () => {
    const { ctx, home } = await sandbox();
    await applyPlan(await planInstall(options(ctx, ["opencode", "claude-code", "cursor"])));
    await write(path.join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { imagegen: { command: "python", args: ["x.py"] } } }));
    const skill = path.join(home, ".claude", "skills", SKILL_NAME);
    assert.ok(await exists(skill));

    const base = { ctx, scope: "global" as const, serverName: "imagegen", skill: true, force: false, detections: new Map<string, Detection>(), claudeCli: null };
    const partial = await planUninstall({ ...base, clients: [findClient("claude-code")!, findClient("gemini")!] });
    assert.equal(actionOf(partial, "claude-code"), "remove");
    assert.equal(actionOf(partial, "gemini"), "conflict");
    const kept = partial.changes.find((c) => c.kind === "skill");
    assert.equal(kept?.action, "keep", "OpenCode and Cursor still read ~/.claude/skills");
    await applyPlan(partial);
    assert.equal((await readJson(path.join(home, ".claude.json"))).mcpServers.imagegen, undefined);
    assert.equal((await readJson(path.join(home, ".gemini", "settings.json"))).mcpServers.imagegen.command, "python");
    assert.ok(await exists(skill));

    const rest = await planUninstall({ ...base, clients: [findClient("opencode")!, findClient("cursor")!] });
    await applyPlan(rest);
    assert.equal(await exists(skill), false);
    assert.equal((await readJson(path.join(home, ".cursor", "mcp.json"))).mcpServers.imagegen, undefined);
  });

  test("project scope: npx, no machine-specific env, shared files written once", async () => {
    const { ctx, cwd } = await sandbox({ CODEX_HOME: "/somewhere/codex" });
    const plan = await planInstall(options(ctx, ["vscode", "vscode-insiders", "claude-code", "opencode"], { scope: "project" }));
    const vscode = configs(plan).find((c) => c.file.endsWith(path.join(".vscode", "mcp.json")));
    assert.deepEqual(vscode?.clients.map((c) => c.id), ["vscode", "vscode-insiders"]);
    await applyPlan(plan);
    const entry = (await readJson(path.join(cwd, ".vscode", "mcp.json"))).servers.imagegen;
    assert.equal(entry.env, undefined);
    assert.deepEqual(entry.args.slice(0, 1), process.platform === "win32" ? ["/c"] : ["-y"]);
    assert.ok((await readJson(path.join(cwd, ".mcp.json"))).mcpServers.imagegen);
    assert.ok((await readJson(path.join(cwd, "opencode.json"))).mcp.imagegen);
    // All four read .claude/skills in a project, so one copy covers them.
    assert.ok(await exists(path.join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md")));
    assert.equal(await exists(path.join(cwd, ".agents", "skills", SKILL_NAME)), false);
  });

  test("extension clients: skipped when the extension isn't installed, written per editor when it is", async () => {
    const { ctx, home } = await sandbox();
    const none = await planInstall(options(ctx, ["zoo"], { skill: false }));
    assert.equal(actionOf(none, "zoo"), "skip");
    const zoo = findClient("zoo")!;
    const detection: Detection = { found: true, evidence: [], hosts: [{ host: { id: "vscode", label: "VS Code", extensionsDir: () => "", userData: () => path.join(home, "Code") }, extensionId: "zoocodeorganization.zoo-code" }] };
    const plan = await planInstall(options(ctx, ["zoo"], { skill: false, detections: new Map([[zoo.id, detection]]) }));
    await applyPlan(plan);
    const file = path.join(home, "Code", "User", "globalStorage", "zoocodeorganization.zoo-code", "settings", "mcp_settings.json");
    assert.equal((await readJson(file)).mcpServers.imagegen.timeout, 300);
  });

  test("Claude Desktop gets an uploadable skill zip; JetBrains AI gets a snippet", async () => {
    const { ctx, home } = await sandbox();
    const plan = await planInstall(options(ctx, ["claude-desktop", "jetbrains-ai"]));
    const manual = plan.changes.find((c) => c.kind === "manual");
    assert.ok(manual?.kind === "manual" && JSON.parse(manual.snippet).mcpServers.imagegen.command === RUNTIME.node);
    await applyPlan(plan);
    const zip = await fs.readFile(path.join(home, "data", `${SKILL_NAME}-skill.zip`));
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    assert.ok(zip.includes(Buffer.from(`${SKILL_NAME}/SKILL.md`)));
    assert.equal(plan.changes.some((c) => c.kind === "skill"), false, "no local skill folder for Claude Desktop");
  });

  test("symlinked configs stay symlinks and file modes are preserved", { skip: !POSIX }, async () => {
    const { ctx, home } = await sandbox();
    const real = path.join(home, "dotfiles", "mcp.json");
    await write(real, '{ "mcpServers": {} }\n', 0o600);
    await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
    await fs.symlink(real, path.join(home, ".cursor", "mcp.json"));
    await applyPlan(await planInstall(options(ctx, ["cursor"], { skill: false })));
    assert.ok((await fs.lstat(path.join(home, ".cursor", "mcp.json"))).isSymbolicLink());
    assert.ok((await readJson(real)).mcpServers.imagegen);
    assert.equal((await fs.stat(real)).mode & 0o777, 0o600);
  });

  test("Claude Code's user config goes through `claude mcp` when the CLI is available", { skip: !POSIX }, async () => {
    const { ctx, home } = await sandbox();
    const fake = path.join(home, "bin", "claude");
    await write(
      fake,
      `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = process.env.CLAUDE_CONFIG_DIR || process.env.HOME;
const file = path.join(dir, ".claude.json");
fs.appendFileSync(path.join(dir, "claude-calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const [, sub, , , name, json] = process.argv.slice(2);
cfg.mcpServers = cfg.mcpServers || {};
if (sub === "add-json") { if (cfg.mcpServers[name]) process.exit(1); cfg.mcpServers[name] = JSON.parse(json); }
if (sub === "remove") { if (!cfg.mcpServers[name]) process.exit(1); delete cfg.mcpServers[name]; }
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
`,
      0o755,
    );
    ctx.env.HOME = home;
    const plan = await planInstall(options(ctx, ["claude-code"], { skill: false, claudeCli: fake }));
    const [result] = await applyPlan(plan);
    assert.equal(result?.outcome, "created via claude mcp");
    await applyPlan(await planInstall(options(ctx, ["claude-code"], { skill: false, claudeCli: fake, mode: "npx" })));
    const calls = (await fs.readFile(path.join(home, "claude-calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c: string[]) => c.slice(0, 4).join(" ")), ["mcp add-json --scope user", "mcp remove --scope user", "mcp add-json --scope user"]);
    assert.deepEqual((await readJson(path.join(home, ".claude.json"))).mcpServers.imagegen.args.slice(0, 1), ["-y"]);
  });
});
