import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { PACKAGE_ROOT, SKILL_NAME } from "../src/constants.js";
import type { InstallContext } from "../src/install/context.js";
import type { Runtime } from "../src/install/launch.js";
import { plainTheme } from "../src/install/theme.js";
import { installWizard, uninstallWizard, type Prompter, type WizardEnv } from "../src/install/wizard.js";
import { tempDir } from "./helpers/env.js";

const RUNTIME: Runtime = { node: process.execPath, script: path.join(PACKAGE_ROOT, "dist", "src", "cli.js"), ephemeral: false, warnings: [] };

type Answer = unknown | ((options: any) => unknown);

/** A Prompter that answers from a script and records everything shown. */
function scripted(answers: Answer[]) {
  const log: string[] = [];
  const ask = async (kind: string, o: { message: string }) => {
    log.push(`${kind}: ${o.message}`);
    if (answers.length === 0) throw new Error(`Unexpected prompt: ${o.message}`);
    const a = answers.shift();
    return typeof a === "function" ? (a as (o: unknown) => unknown)(o) : a;
  };
  const prompter: Prompter = {
    intro: (m) => log.push(`intro: ${m}`),
    outro: (m) => log.push(`outro: ${m}`),
    cancel: (m) => log.push(`cancel: ${m}`),
    note: (m, t) => log.push(`note[${t}]: ${m}`),
    info: (m) => log.push(`info: ${m}`),
    success: (m) => log.push(`success: ${m}`),
    warn: (m) => log.push(`warn: ${m}`),
    error: (m) => log.push(`error: ${m}`),
    message: (m) => log.push(`message: ${m}`),
    spinner: () => ({ start: (m) => log.push(`spinner: ${m}`), stop: (m) => log.push(`spinner done: ${m}`), message: () => undefined }),
    groupMultiselect: (o) => ask("groupMultiselect", o) as never,
    multiselect: (o) => ask("multiselect", o) as never,
    select: (o) => ask("select", o) as never,
    confirm: (o) => ask("confirm", o) as never,
  };
  return { prompter, log, remaining: () => answers.length };
}

async function sandbox() {
  const home = await tempDir("imagegen-wizard-");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "opencode.exe" : "opencode"), "", { mode: 0o755 });
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const ctx: InstallContext = {
    platform: process.platform,
    home,
    cwd: path.join(home, "project"),
    env: { PATH: bin, PATHEXT: ".EXE", XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") },
  };
  return { home, ctx };
}

function env(ctx: InstallContext, prompter: Prompter, signedIn = false, signIns: string[] = []): WizardEnv {
  return {
    ui: prompter,
    ctx,
    runtime: () => RUNTIME,
    theme: plainTheme,
    serverName: "imagegen",
    timeoutMs: 300_000,
    env: {},
    credentials: async () => (signedIn ? { ready: true, label: "own sign-in, me@example.com" } : { ready: false }),
    signIn: async (method) => {
      signIns.push(method);
      return "Signed in as me@example.com.";
    },
    cli: "codex-imagegen-mcp",
    claudeCli: null,
  };
}

const readJson = async (file: string) => parseJsonc(await fs.readFile(file, "utf8"), [], { allowTrailingComma: true });

describe("install wizard", () => {
  test("pre-selects detected tools, installs, offers sign-in and prints next steps", async () => {
    const { home, ctx } = await sandbox();
    const signIns: string[] = [];
    const { prompter, log, remaining } = scripted([
      (o: { options: Record<string, { value: string; label: string; hint?: string }[]>; initialValues: string[] }) => {
        // Apps under /Applications may be detected too, depending on the machine.
        assert.ok(o.initialValues.includes("opencode") && o.initialValues.includes("cursor"));
        assert.ok(!o.initialValues.includes("codex"), "Codex is never pre-selected");
        const all = Object.values(o.options).flat();
        assert.equal(all.find((x) => x.value === "cursor")!.label, "Cursor");
        assert.match(all.find((x) => x.value === "cursor")!.hint ?? "", /^found /);
        assert.match(all.find((x) => x.value === "codex")!.hint ?? "", /built-in image generation/);
        assert.ok(Object.keys(o.options).includes("Terminal agents"));
        return ["opencode", "cursor"];
      },
      "global", // scope
      true, // skill
      "auto", // launch
      true, // apply
      "device", // sign in now, with a device code
    ]);
    const code = await installWizard(env(ctx, prompter, false, signIns));
    assert.equal(code, 0, log.join("\n"));
    assert.equal(remaining(), 0);
    assert.deepEqual(signIns, ["device"]);
    assert.ok((await readJson(path.join(home, ".config", "opencode", "opencode.json"))).mcp.imagegen);
    assert.ok((await readJson(path.join(home, ".cursor", "mcp.json"))).mcpServers.imagegen);
    await fs.access(path.join(home, ".agents", "skills", SKILL_NAME, "SKILL.md"));
    assert.ok(log.some((l) => l.startsWith("note[Review]") && l.includes("~/.cursor/mcp.json".replace(/\//g, path.sep))));
    assert.ok(log.some((l) => l.startsWith("note[Next steps]") && l.includes("Restart Cursor")));
    assert.ok(log.some((l) => l === "success: Signed in as me@example.com."));
  });

  test("cancelling at the first prompt changes nothing", async () => {
    const { home, ctx } = await sandbox();
    const { prompter, log } = scripted([Symbol("cancel")]);
    assert.equal(await installWizard(env(ctx, prompter)), 130);
    assert.ok(log.includes("cancel: Cancelled. Nothing was changed."));
    await assert.rejects(fs.access(path.join(home, ".cursor", "mcp.json")));
  });

  test("offers to replace a different server with the same name; up-to-date runs skip the apply step", async () => {
    const { home, ctx } = await sandbox();
    const file = path.join(home, ".cursor", "mcp.json");
    await fs.writeFile(file, JSON.stringify({ mcpServers: { imagegen: { command: "python", args: ["x.py"] } } }));
    const first = scripted([["cursor"], "global", false, "auto", true, true, "later"]);
    assert.equal(await installWizard(env(ctx, first.prompter)), 0, first.log.join("\n"));
    assert.ok(first.log.some((l) => l.startsWith('confirm: Some tools already have a different server named "imagegen"')));
    assert.equal((await readJson(file)).mcpServers.imagegen.command, RUNTIME.node);

    const again = scripted([["cursor"], "global", false, "auto"]);
    assert.equal(await installWizard(env(ctx, again.prompter, true)), 0, again.log.join("\n"));
    assert.ok(again.log.includes("success: Everything is already up to date."));
    assert.ok(again.log.some((l) => l.startsWith("success: ChatGPT sign-in: own sign-in")));
  });
});

describe("uninstall wizard", () => {
  test("lists only tools that have imagegen and removes the chosen ones", async () => {
    const { home, ctx } = await sandbox();
    const install = scripted([["opencode", "cursor"], "global", true, "auto", true, "later"]);
    await installWizard(env(ctx, install.prompter));
    const { prompter, log } = scripted([
      (o: { options: { value: string }[] }) => {
        assert.deepEqual(o.options.map((x) => x.value).sort(), ["cursor", "opencode"]);
        return ["cursor"];
      },
      true, // remove unused skill copies
      true, // confirm
    ]);
    assert.equal(await uninstallWizard(env(ctx, prompter)), 0, log.join("\n"));
    assert.equal((await readJson(path.join(home, ".cursor", "mcp.json"))).mcpServers?.imagegen, undefined);
    assert.ok((await readJson(path.join(home, ".config", "opencode", "opencode.json"))).mcp.imagegen);
    await fs.access(path.join(home, ".agents", "skills", SKILL_NAME, "SKILL.md")); // OpenCode still uses it
  });
});
