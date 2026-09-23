import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AuthManager } from "./auth/manager.js";
import { describeUsage } from "./backend/ratelimits.js";
import { OAUTH_CALLBACK_PORTS, SKILL_NAME, SKILL_SOURCE_DIR } from "./constants.js";
import { toImagegenError } from "./errors.js";
import { opencodeConfigDir, resolveOpencodeConfigFile } from "./install/opencode.js";
import { findSkillsNamed, opencodeSkillRoots } from "./install/skill.js";
import type { ServerDeps } from "./server/context.js";
import { ensureDir, pathExists } from "./util/fs.js";
import { isRecord } from "./util/http.js";
import { parse as parseJsonc } from "jsonc-parser";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function onPath(cmd: string): Promise<string | undefined> {
  if (path.isAbsolute(cmd)) return (await pathExists(cmd)) ? cmd : undefined;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function runDoctor(deps: ServerDeps, options: { serverName: string; projectDir: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js", status: major >= 22 ? "ok" : "fail", detail: `v${process.versions.node}${major >= 22 ? "" : " (need >= 22)"}` });

  try {
    await ensureDir(deps.config.home);
    const probe = path.join(deps.config.home, `.doctor-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.rm(probe);
    checks.push({ name: "Data directory", status: "ok", detail: deps.config.home });
  } catch (err) {
    checks.push({ name: "Data directory", status: "fail", detail: `${deps.config.home} is not writable (${toImagegenError(err).message})` });
  }

  checks.push({
    name: "Bundled skill",
    status: (await pathExists(path.join(SKILL_SOURCE_DIR, "SKILL.md"))) ? "ok" : "fail",
    detail: SKILL_SOURCE_DIR,
  });

  const sources = await deps.auth.inspect();
  const active = AuthManager.activeSource(sources);
  checks.push({
    name: "Credentials",
    status: active ? "ok" : "fail",
    detail: active
      ? `using the ${active.label}${active.identity?.email ? ` (${active.identity.email}${active.identity.planType ? `, ${active.identity.planType}` : ""})` : ""}`
      : `not signed in — ${sources.map((s) => `${s.label}: ${s.detail}`).join("; ")}`,
  });
  if (active?.identity?.planType === "free") {
    checks.push({ name: "Plan", status: "warn", detail: "ChatGPT Free plans do not include Codex image generation." });
  }
  if (active) {
    try {
      const usage = await deps.images.getUsage();
      const lines = describeUsage(usage);
      checks.push({ name: "ChatGPT backend", status: usage.limitReached ? "warn" : "ok", detail: `reachable${usage.planType ? `, plan ${usage.planType}` : ""}${lines.length ? `; ${lines.join("; ")}` : ""}` });
    } catch (err) {
      checks.push({ name: "ChatGPT backend", status: "fail", detail: toImagegenError(err).message });
    }
  }

  const free = await Promise.all(OAUTH_CALLBACK_PORTS.map(portFree));
  checks.push({
    name: "Sign-in callback ports",
    status: free.some(Boolean) ? "ok" : "warn",
    detail: OAUTH_CALLBACK_PORTS.map((p, i) => `${p} ${free[i] ? "free" : "busy"}`).join(", ") + (free.some(Boolean) ? "" : " — browser login will fail; use `login --device`"),
  });

  const configDir = opencodeConfigDir();
  const { file, exists } = await resolveOpencodeConfigFile(configDir);
  if (!exists) {
    checks.push({ name: "opencode config", status: "warn", detail: `${file} not found (run \`install opencode\` if you use opencode)` });
  } else {
    let entry: unknown;
    try {
      const cfg: unknown = parseJsonc(await fs.readFile(file, "utf8"), [], { allowTrailingComma: true });
      entry = isRecord(cfg) && isRecord(cfg.mcp) ? cfg.mcp[options.serverName] : undefined;
    } catch {
      entry = undefined;
    }
    if (!isRecord(entry)) {
      checks.push({ name: "opencode MCP entry", status: "warn", detail: `no "${options.serverName}" server in ${file} (run \`install opencode\`)` });
    } else {
      const command = Array.isArray(entry.command) ? entry.command.map(String) : [];
      const exe = command[0] ? await onPath(command[0]) : undefined;
      const script = command.find((c) => c.endsWith("cli.js"));
      const scriptOk = script ? await pathExists(script) : true;
      const enabled = entry.enabled !== false;
      checks.push({
        name: "opencode MCP entry",
        status: exe && scriptOk && enabled ? "ok" : "fail",
        detail: `${command.join(" ")}${exe ? "" : " — executable not found on PATH"}${scriptOk ? "" : " — script missing"}${enabled ? "" : " — disabled"}`,
      });
    }
    const skills = await findSkillsNamed(SKILL_NAME, opencodeSkillRoots(configDir, options.projectDir));
    checks.push({
      name: "opencode skill",
      status: skills.length === 1 ? "ok" : "warn",
      detail:
        skills.length === 0
          ? "no imagegen skill found (run `install opencode`)"
          : skills.length === 1
            ? skills[0]!
            : `${skills.length} skills named imagegen (opencode picks one unpredictably): ${skills.join(", ")}`,
    });
  }
  return checks;
}
