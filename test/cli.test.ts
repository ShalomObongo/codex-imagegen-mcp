import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { seedOwnAuth, tempDir, testConfig, testEnv } from "./helpers/env.js";
import { startMockOpenAI, type MockOpenAI } from "./helpers/mock-openai.js";

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

let mock: MockOpenAI;
let root: string;
let env: NodeJS.ProcessEnv;

async function cli(args: string[], cwd = root): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, env, timeout: 30_000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

before(async () => {
  mock = await startMockOpenAI();
  root = await tempDir();
  const home = path.join(root, "userhome");
  // Windows needs SystemRoot & co. for networking in child processes; USERPROFILE is its HOME.
  const windows: NodeJS.ProcessEnv =
    process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: home }
      : {};
  env = { ...windows, PATH: process.env.PATH, HOME: home, ...testEnv(root, mock) };
  await seedOwnAuth(testConfig(root, mock), mock.issue({ email: "cli@example.com" }));
});

after(async () => {
  await mock.close();
});

describe("cli", () => {
  test("--version and help", async () => {
    assert.match((await cli(["--version"])).stdout, /^\d+\.\d+\.\d+/);
    const help = await cli(["help"]);
    assert.match(help.stdout, /install <tool…>/);
    const bad = await cli(["frobnicate"]);
    assert.equal(bad.code, 2);
  });

  test("status --json", async () => {
    const r = await cli(["status", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.signedIn, true);
    assert.equal(report.active.source, "own");
    assert.equal(report.usage.planType, "plus");
  });

  test("generate writes the file and prints its path", async () => {
    const r = await cli(["generate", "a", "tiny", "robot", "-o", "out/robot.png", "-a", "16:9"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /out[\\/]robot\.png/);
    await fs.access(path.join(root, "out", "robot.png"));
    const req = mock.requestsTo("/backend-api/codex/images/generations").at(-1);
    assert.equal(req?.json.prompt, "a tiny robot\n\nAspect ratio: 16:9, wide landscape (horizontal) canvas.");
    const jpg = await cli(["generate", "photo", "-o", "out/photo.jpg", "--json"]);
    const parsed = JSON.parse(jpg.stdout);
    assert.equal(parsed.saved[0].mimeType, "image/jpeg");
  });

  test("argument validation", async () => {
    assert.equal((await cli(["generate"])).code, 2);
    assert.equal((await cli(["generate", "x", "-a", "7:3"])).code, 2);
    assert.equal((await cli(["generate", "x", "-b", "transparent", "-o", "a.jpg"])).code, 1);
  });

  test("install: --list, --dry-run, apply, idempotent re-run, uninstall", async () => {
    // A PATH without the user's real tools, so no real `claude` (or other CLI) is ever run.
    const saved = env.PATH;
    env.PATH = path.dirname(process.execPath);
    try {
      const list = await cli(["install", "--list", "--json"]);
      assert.equal(list.code, 0, list.stderr);
      const tools = JSON.parse(list.stdout) as { id: string; installed: { global: boolean } }[];
      assert.ok(tools.some((t) => t.id === "cursor"));

      const dry = await cli(["install", "opencode", "cursor", "--dry-run"]);
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /Dry run: nothing was written/);
      assert.match(dry.stdout, /\+ create\s+~[\\/]\.cursor[\\/]mcp\.json/);
      await assert.rejects(fs.access(path.join(env.HOME!, ".cursor", "mcp.json")));

      const json = JSON.parse((await cli(["install", "cursor", "--dry-run", "--json", "--launch", "npx"])).stdout);
      assert.equal(json.launch.mode, "npx");
      assert.equal(json.changes[0].entry.type, "stdio");

      const run = await cli(["install", "opencode", "cursor"]);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /ChatGPT sign-in: /);
      assert.match(run.stdout, /Next steps/);
      const cursor = JSON.parse(await fs.readFile(path.join(env.HOME!, ".cursor", "mcp.json"), "utf8"));
      assert.deepEqual(cursor.mcpServers.imagegen.args.slice(-1), ["serve"]);
      assert.match((await cli(["install", "opencode", "cursor", "--dry-run"])).stdout, /up to date/);
      assert.ok(JSON.parse((await cli(["install", "--list", "--json"])).stdout).find((t: { id: string }) => t.id === "cursor").installed.global);

      const doctor = await cli(["doctor"]);
      assert.match(doctor.stdout, /✓ Cursor: /);

      const removed = await cli(["uninstall", "--all"]);
      assert.equal(removed.code, 0, removed.stderr);
      assert.match(removed.stdout, /- removed\s+~[\\/]\.cursor[\\/]mcp\.json/);
      assert.equal(JSON.parse(await fs.readFile(path.join(env.HOME!, ".cursor", "mcp.json"), "utf8")).mcpServers, undefined);
    } finally {
      env.PATH = saved;
    }
  });

  test("install argument errors and config snippets", async () => {
    const none = await cli(["install"]);
    assert.equal(none.code, 2, "no tools and no terminal: usage error instead of a hung prompt");
    assert.match(none.stderr, /install --list/);
    assert.equal((await cli(["install", "frobnicator"])).code, 2);
    assert.equal((await cli(["install", "cursor", "--launch", "teleport"])).code, 2);
    assert.equal((await cli(["install", "cursor", "--name", "bad name"])).code, 2);
    const c = await cli(["config", "cursor"]);
    assert.match(c.stdout, /"mcpServers"/);
    assert.match(c.stdout, /cli\.js/);
    assert.match((await cli(["config", "codex"])).stdout, /\[mcp_servers\.imagegen\]/);
    assert.match((await cli(["config", "vscode", "--project"])).stdout, /"servers"[\s\S]*npx/);
  });

  test("logout removes our credentials", async () => {
    const r = await cli(["logout"]);
    assert.match(r.stdout, /Signed out/);
    const s = await cli(["status", "--no-usage"]);
    assert.equal(s.code, 1);
    assert.match(s.stdout, /Signed in: no/);
  });
});
