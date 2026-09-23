import { AuthManager, type SourceReport } from "./auth/manager.js";
import type { ImagesClient } from "./backend/images-client.js";
import { describeUsage, type UsageSnapshot } from "./backend/ratelimits.js";
import type { CredentialSource } from "./config.js";
import { toImagegenError } from "./errors.js";
import type { LoginOutcome, PendingLogin } from "./server/login-coordinator.js";
import { formatWhen } from "./util/format.js";
import { cliInvocation } from "./util/invocation.js";

export interface StatusReport {
  signedIn: boolean;
  active?: SourceReport;
  sources: SourceReport[];
  usage?: UsageSnapshot & { credentialSource: CredentialSource };
  usageError?: string;
  pendingLogin?: PendingLogin;
  lastLogin?: LoginOutcome;
}

export async function collectStatus(
  deps: { auth: AuthManager; images: ImagesClient },
  options: { checkUsage: boolean; signal?: AbortSignal; pendingLogin?: PendingLogin; lastLogin?: LoginOutcome },
): Promise<StatusReport> {
  const sources = await deps.auth.inspect();
  const active = AuthManager.activeSource(sources);
  const report: StatusReport = { signedIn: Boolean(active), sources };
  if (active) report.active = active;
  if (options.pendingLogin) report.pendingLogin = options.pendingLogin;
  if (options.lastLogin) report.lastLogin = options.lastLogin;
  if (active && options.checkUsage) {
    try {
      report.usage = await deps.images.getUsage(options.signal ? { signal: options.signal } : {});
    } catch (err) {
      report.usageError = toImagegenError(err).message;
    }
  }
  return report;
}

const STATE_MARK: Record<SourceReport["state"], string> = {
  ready: "✓",
  refreshable: "✓",
  missing: "·",
  expired: "✗",
  unusable: "✗",
  disabled: "-",
};

function identityLine(r: SourceReport): string {
  const parts: string[] = [];
  if (r.identity?.email) parts.push(r.identity.email);
  if (r.identity?.planType) parts.push(`ChatGPT ${r.identity.planType} plan`);
  if (r.identity?.accountId) parts.push(`account …${r.identity.accountId.slice(-6)}`);
  return parts.join(", ");
}

export function formatStatus(report: StatusReport, now = Date.now()): string {
  const lines: string[] = [];
  const invocation = cliInvocation();
  if (report.active) {
    const who = identityLine(report.active);
    lines.push(`Signed in: yes — using the ${report.active.label}${who ? ` (${who})` : ""}.`);
    if (report.active.expiresAt !== undefined) {
      const renew = report.active.source === "own" ? "renewed automatically" : "renewed by the app that owns it";
      lines.push(`Access token ${report.active.expiresAt > now ? "expires" : "expired"} ${formatWhen(report.active.expiresAt, now)} (${renew}).`);
    }
    if (report.active.identity?.planType === "free") {
      lines.push("Note: Codex image generation is not available on the ChatGPT Free plan.");
    }
  } else {
    lines.push("Signed in: no.");
    lines.push(`To sign in, run \`${invocation} login\` in a terminal (add --device on a headless machine), or call the sign_in tool.`);
  }
  if (report.usage) {
    const usageLines = describeUsage(report.usage, now);
    if (usageLines.length > 0) lines.push(`Usage: ${usageLines.join("; ")}.`);
  } else if (report.usageError) {
    lines.push(`Usage: unavailable (${report.usageError}).`);
  }
  if (report.pendingLogin) {
    const p = report.pendingLogin;
    lines.push(
      p.method === "device"
        ? `Sign-in in progress (device code): open ${p.url} and enter ${p.userCode ?? "the code"}.`
        : `Sign-in in progress (browser): ${p.url}`,
    );
  }
  if (report.lastLogin) lines.push(`Last sign-in attempt: ${report.lastLogin.ok ? "succeeded" : "failed"} — ${report.lastLogin.message}`);
  lines.push("Credential sources (checked in this order):");
  for (const s of report.sources) {
    const who = identityLine(s);
    const expiry = s.expiresAt !== undefined && (s.state === "ready" || s.state === "refreshable") ? `, token expires ${formatWhen(s.expiresAt, now)}` : "";
    lines.push(`  ${STATE_MARK[s.state]} ${s.label}: ${s.detail}${who ? ` — ${who}` : ""}${expiry} [${s.file}]`);
  }
  return lines.join("\n");
}
