import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { availableClients, CLIENT_REGISTRY, findClient, SKILL_ROOTS, skillRootDir, type ClientDefinition } from "../src/install/clients.js";
import type { InstallContext, Scope } from "../src/install/context.js";
import { Detector, NOT_DETECTED } from "../src/install/detect.js";
import { adaptLaunch, npxSpec, pinnedEnvironment, resolveLaunch, stableNodePath, type Runtime } from "../src/install/launch.js";
import { tempDir } from "./helpers/env.js";

const mac: InstallContext = { platform: "darwin", home: "/Users/me", cwd: "/Users/me/app", env: {} };
const linux: InstallContext = { platform: "linux", home: "/home/me", cwd: "/home/me/app", env: {} };
const win: InstallContext = { platform: "win32", home: "C:\\Users\\me", cwd: "C:\\src\\app", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } };

const client = (id: string): ClientDefinition => {
  const c = findClient(id);
  assert.ok(c, id);
  return c;
};
const files = (id: string, ctx: InstallContext, scope: Scope = "global") => client(id).configs(ctx, scope, NOT_DETECTED).flatMap((s) => s.files);

const RUNTIME: Runtime = { node: "/usr/local/bin/node", script: "/opt/pkg/dist/src/cli.js", ephemeral: false, warnings: [] };
const LAUNCH = { command: "/usr/local/bin/node", args: ["/opt/pkg/dist/src/cli.js", "serve"], env: {} };

describe("client registry", () => {
  test("every client is complete and ids are unique", () => {
    const ids = new Set<string>();
    for (const c of CLIENT_REGISTRY) {
      assert.ok(!ids.has(c.id), c.id);
      ids.add(c.id);
      assert.ok(c.label && c.restart && c.scopes.length > 0, c.id);
      const entry = c.entry(LAUNCH, { serverName: "imagegen", timeoutMs: 300_000 });
      assert.match(JSON.stringify(entry), /cli\.js/, c.id);
      for (const scope of c.scopes) {
        for (const id of c.skills(mac, scope)) assert.ok(id in SKILL_ROOTS, `${c.id} ${id}`);
        if (!c.manual && !c.detect.extensions) assert.ok(c.configs(mac, scope, NOT_DETECTED).length > 0, `${c.id} ${scope}`);
      }
    }
    assert.ok(CLIENT_REGISTRY.length >= 20);
    assert.equal(findClient("claude")?.id, "claude-code");
    assert.equal(findClient("Roo")?.id, "zoo");
    assert.equal(findClient("nope"), undefined);
    assert.ok(!availableClients(mac).some((c) => c.id === "visual-studio"));
    assert.ok(availableClients(win).some((c) => c.id === "visual-studio"));
  });

  test("config paths per OS", () => {
    assert.deepEqual(files("opencode", mac), ["/Users/me/.config/opencode/opencode.jsonc", "/Users/me/.config/opencode/opencode.json"]);
    assert.deepEqual(files("opencode", { ...linux, env: { XDG_CONFIG_HOME: "/xdg" } }), ["/xdg/opencode/opencode.jsonc", "/xdg/opencode/opencode.json"]);
    assert.deepEqual(files("opencode", mac, "project"), ["/Users/me/app/opencode.jsonc", "/Users/me/app/opencode.json"]);
    assert.deepEqual(files("claude-code", mac), ["/Users/me/.claude.json"]);
    assert.deepEqual(files("claude-code", { ...mac, env: { CLAUDE_CONFIG_DIR: "/cfg/claude" } }), ["/cfg/claude/.claude.json"]);
    assert.deepEqual(files("claude-code", mac, "project"), ["/Users/me/app/.mcp.json"]);
    assert.deepEqual(files("codex", { ...linux, env: { CODEX_HOME: "/opt/codex" } }), ["/opt/codex/config.toml"]);
    assert.deepEqual(files("vscode", mac), ["/Users/me/Library/Application Support/Code/User/mcp.json"]);
    assert.deepEqual(files("vscode-insiders", linux), ["/home/me/.config/Code - Insiders/User/mcp.json"]);
    assert.deepEqual(files("vscode", win), ["C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json"]);
    assert.deepEqual(files("claude-desktop", win), ["C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json"]);
    assert.deepEqual(files("zed", mac), ["/Users/me/.config/zed/settings.json"]);
    assert.deepEqual(files("zed", win), ["C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json"]);
    assert.deepEqual(files("goose", win), ["C:\\Users\\me\\AppData\\Roaming\\Block\\goose\\config\\config.yaml"]);
    assert.deepEqual(files("devin", linux), ["/home/me/.config/devin/mcp_config.json"]);
    assert.deepEqual(files("devin", win), ["C:\\Users\\me\\AppData\\Roaming\\devin\\mcp_config.json"]);
    assert.deepEqual(files("copilot", { ...mac, env: { COPILOT_HOME: "/c" } }), ["/c/mcp-config.json"]);
    assert.deepEqual(files("copilot", mac, "project"), ["/Users/me/app/.github/mcp.json"]);
    assert.deepEqual(files("kilo", win), ["C:\\Users\\me\\.config\\kilo\\kilo.jsonc", "C:\\Users\\me\\.config\\kilo\\kilo.json"]);
    // Cline resolves its home from HOME first, even on Windows.
    assert.deepEqual(files("cline", { ...win, env: { ...win.env, HOME: "D:\\home" } }), ["D:\\home\\.cline\\data\\settings\\cline_mcp_settings.json"]);
  });

  test("entries use each client's schema and timeout unit", () => {
    const o = { serverName: "imagegen", timeoutMs: 300_000 };
    const withEnv = { ...LAUNCH, env: { CODEX_HOME: "/c" } };
    assert.deepEqual(client("opencode").entry(withEnv, o), { type: "local", command: [LAUNCH.command, ...LAUNCH.args], enabled: true, timeout: 300_000, environment: { CODEX_HOME: "/c" } });
    assert.deepEqual(client("codex").entry(LAUNCH, o), { command: LAUNCH.command, args: LAUNCH.args, startup_timeout_sec: 60, tool_timeout_sec: 300 });
    assert.deepEqual(client("copilot").entry(LAUNCH, o), { type: "local", command: LAUNCH.command, args: LAUNCH.args, tools: ["*"], timeout: 300_000 });
    assert.equal(client("zed").entry(LAUNCH, o).timeout, 300);
    assert.equal(client("cline").entry(LAUNCH, o).timeout, 300);
    assert.equal(client("zoo").entry(LAUNCH, o).timeout, 300);
    assert.equal(client("droid").entry(LAUNCH, o).timeout, 300_000);
    assert.deepEqual(client("vscode").entry(LAUNCH, o), { type: "stdio", command: LAUNCH.command, args: LAUNCH.args });
    assert.deepEqual(client("claude-code").entry(LAUNCH, o), { type: "stdio", command: LAUNCH.command, args: LAUNCH.args, env: {} });
    const goose = client("goose").entry(withEnv, o);
    assert.equal(goose.cmd, LAUNCH.command);
    assert.deepEqual(goose.envs, { CODEX_HOME: "/c" });
    assert.equal(goose.timeout, 300);
    assert.equal(client("gemini").entry(LAUNCH, o).timeout, undefined);
  });

  test("skill folders", () => {
    assert.deepEqual(client("claude-code").skills(mac, "global"), ["claude"]);
    assert.equal(skillRootDir("claude", { ...mac, env: { CLAUDE_CONFIG_DIR: "/cfg" } }, "global"), "/cfg/skills");
    assert.deepEqual(client("copilot").skills({ ...mac, env: { COPILOT_HOME: "/c" } }, "global"), ["copilot"]);
    assert.equal(skillRootDir("agents", win, "global"), "C:\\Users\\me\\.agents\\skills");
    assert.equal(skillRootDir("antigravity", mac, "project"), undefined);
  });
});

describe("launch commands", () => {
  test("npx ranges", () => {
    assert.equal(npxSpec("0.2.0"), "codex-imagegen-mcp@0.2");
    assert.equal(npxSpec("1.4.2"), "codex-imagegen-mcp@1");
    assert.equal(npxSpec("0.3.0-rc.1"), "codex-imagegen-mcp@0.3.0-rc.1");
  });

  test("auto picks absolute node for global installs and npx for projects or npx runs", () => {
    assert.equal(resolveLaunch({ mode: "auto", scope: "global" }, mac, RUNTIME).mode, "node");
    assert.deepEqual(resolveLaunch({ mode: "auto", scope: "global" }, mac, RUNTIME).argv, [RUNTIME.node, RUNTIME.script, "serve"]);
    assert.equal(resolveLaunch({ mode: "auto", scope: "project" }, mac, RUNTIME).mode, "npx");
    assert.equal(resolveLaunch({ mode: "auto", scope: "global" }, mac, { ...RUNTIME, ephemeral: true }).mode, "npx");
    assert.throws(() => resolveLaunch({ mode: "node", scope: "global" }, mac, { ...RUNTIME, ephemeral: true }), /npx cache/);
    assert.deepEqual(resolveLaunch({ mode: "custom", scope: "global", command: ["my-wrapper", "serve"] }, mac, RUNTIME).argv, ["my-wrapper", "serve"]);
  });

  test("pinned environment only for global installs, only when set", () => {
    const ctx = { ...linux, env: { CODEX_HOME: "/data/codex", XDG_DATA_HOME: "relative/ignored", CODEX_IMAGEGEN_CREDENTIALS: "own", UNRELATED: "x" } };
    assert.deepEqual(pinnedEnvironment(ctx), { CODEX_HOME: "/data/codex", CODEX_IMAGEGEN_CREDENTIALS: "own" });
    assert.deepEqual(resolveLaunch({ mode: "npx", scope: "project" }, ctx, RUNTIME).env, {});
    assert.deepEqual(resolveLaunch({ mode: "npx", scope: "global", env: { EXTRA: "1" } }, ctx, RUNTIME).env, { CODEX_HOME: "/data/codex", CODEX_IMAGEGEN_CREDENTIALS: "own", EXTRA: "1" });
  });

  test("per-client adjustments: cmd /c on Windows, absolute npx + PATH for GUI apps", () => {
    const npx = resolveLaunch({ mode: "npx", scope: "global" }, win, RUNTIME);
    assert.deepEqual(adaptLaunch(npx, { gui: false, scope: "global" }, win, RUNTIME), { command: "cmd", args: ["/c", "npx", "-y", npxSpec(), "serve"], env: {} });
    const gui = adaptLaunch(resolveLaunch({ mode: "npx", scope: "global" }, mac, RUNTIME), { gui: true, scope: "global" }, mac, RUNTIME);
    assert.equal(gui.env.PATH, "/usr/local/bin:/usr/bin:/bin");
    const project = adaptLaunch(resolveLaunch({ mode: "npx", scope: "project" }, mac, RUNTIME), { gui: true, scope: "project" }, mac, RUNTIME);
    assert.deepEqual(project, { command: "npx", args: ["-y", npxSpec(), "serve"], env: {} });
    const node = adaptLaunch(resolveLaunch({ mode: "node", scope: "global" }, win, RUNTIME), { gui: true, scope: "global" }, win, RUNTIME);
    assert.equal(node.command, RUNTIME.node);
  });

  test("stable node path prefers the PATH symlink over the resolved binary", { skip: process.platform === "win32" }, async () => {
    const dir = await tempDir();
    await fs.symlink(process.execPath, path.join(dir, "node"));
    const ctx: InstallContext = { platform: process.platform, home: dir, cwd: dir, env: { PATH: `/nonexistent:${dir}` } };
    assert.equal(stableNodePath(ctx).node, path.join(dir, "node"));
    const nvm = stableNodePath({ ...ctx, env: { PATH: "" } }, "/Users/me/.nvm/versions/node/v24.1.0/bin/node");
    assert.match(nvm.warnings[0] ?? "", /nvm/);
  });
});

describe("detection", () => {
  test("binaries on PATH, config dirs and editor extensions", async () => {
    const home = await tempDir();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin, { recursive: true });
    const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
    await fs.writeFile(path.join(bin, exe), "", { mode: 0o755 });
    await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
    const ext = path.join(home, ".vscode", "extensions");
    await fs.mkdir(ext, { recursive: true });
    await fs.writeFile(
      path.join(ext, "extensions.json"),
      JSON.stringify([
        { identifier: { id: "saoudrizwan.claude-dev" }, relativeLocation: "saoudrizwan.claude-dev-4.1.20" },
        { identifier: { id: "rooveterinaryinc.roo-cline" }, relativeLocation: "rooveterinaryinc.roo-cline-3.54.0" },
      ]),
    );
    await fs.writeFile(path.join(ext, ".obsolete"), JSON.stringify({ "rooveterinaryinc.roo-cline-3.54.0": true }));
    const ctx: InstallContext = { platform: process.platform, home, cwd: home, env: { PATH: bin, PATHEXT: ".EXE;.CMD", XDG_CONFIG_HOME: path.join(home, ".config") } };
    const found = await new Detector(ctx).detectAll(CLIENT_REGISTRY);
    assert.deepEqual(found.get("opencode")?.evidence, ["opencode on PATH"]);
    assert.ok(found.get("cursor")?.found);
    assert.equal(found.get("cline")?.hosts[0]?.host.id, "vscode");
    assert.equal(found.get("zoo")?.found, false, "obsolete (uninstalled) extensions don't count");
    assert.equal(found.get("gemini")?.found, false);
    // Cline then writes both its shared settings and the VS Code globalStorage copy.
    assert.equal(client("cline").configs(ctx, "global", found.get("cline")!).length, 2);
  });
});
