import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test, before } from "node:test";
import { parse } from "jsonc-parser";
import { installOpencode, uninstallOpencode } from "../src/install/opencode.js";
import { findSkillsNamed, SKILL_MARKER } from "../src/install/skill.js";
import { clientSnippet, CLIENTS } from "../src/install/snippets.js";
import { tempDir } from "./helpers/env.js";

// Hermetic: skill duplicate scans look under ~/.claude, ~/.agents and ~/.config/opencode.
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
before(async () => {
  const home = await tempDir("imagegen-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

const COMMAND = ["node", "/opt/codex-imagegen-mcp/dist/src/cli.js", "serve"];

const JSONC = `{
  // my opencode config — comments must survive
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5.5",
  "mcp": {
    "other": { "type": "remote", "url": "https://example.com/mcp" }, // keep me
  },
}
`;

async function setup(file = "opencode.jsonc", contents = JSONC) {
  const root = await tempDir();
  const configDir = path.join(root, "config", "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (contents) await fs.writeFile(path.join(configDir, file), contents);
  return { root, configDir, file: path.join(configDir, file) };
}

const base = (configDir: string, root: string) => ({
  scope: "global" as const,
  projectDir: root,
  serverName: "imagegen",
  command: COMMAND,
  timeoutMs: 300_000,
  installSkill: true,
  dryRun: false,
  force: false,
  configDir,
});

describe("opencode installer", () => {
  test("adds the entry, preserves comments/other servers, backs up, installs the skill; idempotent", async () => {
    const { root, configDir, file } = await setup();
    const report = await installOpencode(base(configDir, root));
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /\/\/ my opencode config — comments must survive/);
    assert.match(text, /\/\/ keep me/);
    const cfg = parse(text, [], { allowTrailingComma: true });
    assert.deepEqual(cfg.mcp.imagegen, { type: "local", command: COMMAND, enabled: true, timeout: 300_000 });
    assert.equal(cfg.mcp.other.url, "https://example.com/mcp");
    assert.equal(await fs.readFile(`${file}.codex-imagegen-mcp.bak`, "utf8"), JSONC);
    const skillDir = path.join(configDir, "skills", "imagegen-mcp");
    assert.equal(report.skillDir, skillDir);
    await fs.access(path.join(skillDir, "SKILL.md"));
    await fs.access(path.join(skillDir, "references", "tools.md"));
    await fs.access(path.join(skillDir, SKILL_MARKER));

    const again = await installOpencode(base(configDir, root));
    assert.ok(again.steps.some((s) => s.action === "MCP entry already up to date"));
    assert.ok(again.steps.some((s) => s.action === "Skill unchanged"));
  });

  test("creates opencode.json when missing; dry-run writes nothing", async () => {
    const { root, configDir } = await setup("opencode.json", "");
    const dry = await installOpencode({ ...base(configDir, root), dryRun: true });
    assert.equal(dry.configFile, path.join(configDir, "opencode.json"));
    await assert.rejects(fs.access(dry.configFile));
    await installOpencode(base(configDir, root));
    const cfg = JSON.parse(await fs.readFile(path.join(configDir, "opencode.json"), "utf8"));
    assert.equal(cfg.$schema, "https://opencode.ai/config.json");
    assert.equal(cfg.mcp.imagegen.type, "local");
  });

  test("refuses to clobber a foreign server with the same name unless forced", async () => {
    const { root, configDir } = await setup("opencode.json", JSON.stringify({ mcp: { imagegen: { type: "local", command: ["python", "other.py"] } } }, null, 2));
    await assert.rejects(installOpencode(base(configDir, root)), /doesn't look like this one/);
    await installOpencode({ ...base(configDir, root), force: true });
  });

  test("leaves a user's own skill of the same name alone and warns about duplicates", async () => {
    const { root, configDir } = await setup();
    const userSkill = path.join(configDir, "skills", "imagegen-mcp");
    await fs.mkdir(userSkill, { recursive: true });
    await fs.writeFile(path.join(userSkill, "SKILL.md"), "---\nname: imagegen-mcp\ndescription: mine\n---\n");
    const report = await installOpencode(base(configDir, root));
    assert.ok(report.steps.some((s) => s.action === "Skill skipped"));
    assert.ok(report.warnings.some((w) => /not installed by codex-imagegen-mcp/.test(w)));
    assert.equal(await fs.readFile(path.join(userSkill, "SKILL.md"), "utf8"), "---\nname: imagegen-mcp\ndescription: mine\n---\n");
    const found = await findSkillsNamed("imagegen-mcp", [path.join(configDir, "skills")]);
    assert.deepEqual(found, [userSkill]);
  });

  test("project scope writes ./opencode.json and .opencode/skills", async () => {
    const root = await tempDir();
    const report = await installOpencode({ ...base(root, root), scope: "project", configDir: undefined });
    assert.equal(report.configFile, path.join(root, "opencode.json"));
    await fs.access(path.join(root, ".opencode", "skills", "imagegen-mcp", "SKILL.md"));
  });

  test("uninstall removes the entry and only our skill", async () => {
    const { root, configDir, file } = await setup();
    await installOpencode(base(configDir, root));
    const report = await uninstallOpencode({ scope: "global", projectDir: root, serverName: "imagegen", dryRun: false, keepSkill: false, configDir });
    assert.ok(report.steps.some((s) => s.action === "Removed skill"));
    const text = await fs.readFile(file, "utf8");
    const cfg = parse(text, [], { allowTrailingComma: true });
    assert.equal(cfg.mcp.imagegen, undefined);
    assert.ok(cfg.mcp.other);
    assert.match(text, /comments must survive/);
    await assert.rejects(fs.access(path.join(configDir, "skills", "imagegen-mcp")));
  });
});

describe("client snippets", () => {
  test("every client produces a snippet containing the command", () => {
    for (const client of CLIENTS) {
      const s = clientSnippet(client, "imagegen", COMMAND);
      assert.ok(s.body.includes("cli.js"), client);
      assert.ok(s.location.length > 0, client);
    }
    assert.match(clientSnippet("codex", "imagegen", COMMAND).body, /^\[mcp_servers\.imagegen\]/);
    assert.match(clientSnippet("claude-code", "imagegen", COMMAND).body, /^claude mcp add --scope user imagegen -- node /);
  });

  test("GUI clients get the absolute launch command for a global install", () => {
    const global = ["codex-imagegen-mcp", "serve"];
    const absolute = ["/usr/local/bin/node", "/usr/local/lib/node_modules/codex-imagegen-mcp/dist/src/cli.js", "serve"];
    const desktop = JSON.parse(clientSnippet("claude-desktop", "imagegen", global, absolute).body);
    assert.deepEqual(desktop.mcpServers.imagegen, { command: absolute[0], args: absolute.slice(1) });
    const windsurf = JSON.parse(clientSnippet("windsurf", "imagegen", global, absolute).body);
    assert.equal(windsurf.mcpServers.imagegen.command, absolute[0]);
    // Terminal clients keep the short command.
    const cursor = JSON.parse(clientSnippet("cursor", "imagegen", global, absolute).body);
    assert.deepEqual(cursor.mcpServers.imagegen, { command: "codex-imagegen-mcp", args: ["serve"] });
  });
});
