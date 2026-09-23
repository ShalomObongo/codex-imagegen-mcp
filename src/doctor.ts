import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AuthManager } from "./auth/manager.js";
import { describeUsage } from "./backend/ratelimits.js";
import { LEGACY_SKILL_NAMES, OAUTH_CALLBACK_PORTS, SKILL_NAME, SKILL_SOURCE_DIR } from "./constants.js";
import { toImagegenError } from "./errors.js";
import { availableClients, SKILL_ROOTS, skillRootDir, type SkillRootId } from "./install/clients.js";
import { currentContext, tildify, which, type InstallContext, type Scope } from "./install/context.js";
import { Detector, NOT_DETECTED } from "./install/detect.js";
import { formatCommand } from "./install/launch.js";
import { entryArgv, entryDisabled, isOurEntry, readConfig } from "./install/plan.js";
import { findSkillsNamed, isOurSkill } from "./install/skills.js";
import type { ServerDeps } from "./server/context.js";
import { ensureDir, pathExists } from "./util/fs.js";

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

async function executableExists(cmd: string, ctx: InstallContext): Promise<boolean> {
  return path.isAbsolute(cmd) ? pathExists(cmd) : which(ctx, cmd) !== undefined;
}

/** One check per tool (and scope) that has our server configured, plus the skill copies. */
async function installationChecks(serverName: string, ctx: InstallContext): Promise<Check[]> {
  const checks: Check[] = [];
  const show = (file: string) => tildify(file, { home: ctx.home, platform: ctx.platform });
  const clients = availableClients(ctx);
  const detections = await new Detector(ctx).detectAll(clients);
  let configured = 0;
  for (const scope of ["global", "project"] as Scope[]) {
    for (const client of clients) {
      if (client.manual || !client.scopes.includes(scope)) continue;
      for (const spec of client.configs(ctx, scope, detections.get(client.id) ?? NOT_DETECTED)) {
        const state = await readConfig(spec, serverName);
        const name = `${client.label}${scope === "project" ? " (this project)" : ""}${spec.label ? ` · ${spec.label}` : ""}`;
        if (state.error) {
          checks.push({ name, status: "warn", detail: state.error });
          continue;
        }
        if (state.current === undefined) continue;
        if (!isOurEntry(state.current)) {
          checks.push({ name, status: "warn", detail: `"${serverName}" in ${show(state.file)} runs something else` });
          continue;
        }
        configured++;
        const argv = entryArgv(state.current);
        const problems: string[] = [];
        if (!argv[0] || !(await executableExists(argv[0], ctx))) problems.push(`${argv[0] ?? "command"} not found`);
        for (const script of argv.filter((a) => a.endsWith("cli.js"))) if (!(await pathExists(script))) problems.push(`${script} is missing`);
        if (entryDisabled(state.current)) problems.push("disabled");
        checks.push({
          name,
          status: problems.length === 0 ? "ok" : "fail",
          detail: `${show(state.file)}: ${formatCommand(argv)}${problems.length ? ` (${problems.join("; ")}; run \`install ${client.id}\` again)` : ""}`,
        });
      }
    }
  }
  if (configured === 0) checks.push({ name: "MCP clients", status: "warn", detail: "not installed in any tool yet (run `codex-imagegen-mcp install`)" });

  const roots = (scope: Scope) => (Object.keys(SKILL_ROOTS) as SkillRootId[]).map((id) => skillRootDir(id, ctx, scope)).filter((d): d is string => d !== undefined);
  const all = [...roots("global"), ...roots("project")];
  const copies = await findSkillsNamed(SKILL_NAME, all);
  const legacy: string[] = [];
  for (const root of all) for (const old of LEGACY_SKILL_NAMES) if (await isOurSkill(path.join(root, old))) legacy.push(path.join(root, old));
  if (copies.length > 0) checks.push({ name: "Agent Skill", status: "ok", detail: copies.map(show).join(", ") });
  else if (configured > 0) checks.push({ name: "Agent Skill", status: "warn", detail: `no ${SKILL_NAME} skill installed (run \`install\` again without --no-skill)` });
  if (legacy.length > 0) {
    checks.push({ name: "Old skill copies", status: "warn", detail: `${legacy.map(show).join(", ")} (from an earlier release; \`install\` replaces them)` });
  }
  return checks;
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

  checks.push(...(await installationChecks(options.serverName, { ...currentContext(), cwd: options.projectDir })));
  return checks;
}
