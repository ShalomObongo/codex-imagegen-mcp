import { formatWhen } from "../util/format.js";
import { isRecord, num, str } from "../util/http.js";

/** One usage window (e.g. the 5-hour or weekly Codex window). Times are epoch seconds. */
export interface RateWindow {
  usedPercent?: number;
  windowMinutes?: number;
  resetAt?: number;
  resetAfterSeconds?: number;
}

export interface LimitSnapshot {
  name?: string;
  primary?: RateWindow;
  secondary?: RateWindow;
}

/** Parsed from response headers such as `x-codex-primary-used-percent` / `x-image-gen-secondary-reset-at`. */
export interface RateLimitSnapshot {
  planType?: string;
  activeLimit?: string;
  limits: Record<string, LimitSnapshot>;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
}

const WINDOW_HEADER = /^x-([a-z0-9-]+?)-(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/;
const WINDOW_FIELD: Record<string, keyof RateWindow> = {
  "used-percent": "usedPercent",
  "window-minutes": "windowMinutes",
  "reset-at": "resetAt",
  "reset-after-seconds": "resetAfterSeconds",
};

function bool(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return undefined;
}

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = { limits: {} };
  let found = false;
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    const m = WINDOW_HEADER.exec(name);
    if (m) {
      const [, id, which, field] = m as unknown as [string, string, "primary" | "secondary", string];
      const n = num(value);
      const prop = WINDOW_FIELD[field];
      if (n === undefined || !prop) return;
      const limit = (snapshot.limits[id] ??= {});
      const window = (limit[which] ??= {});
      window[prop] = n;
      found = true;
      return;
    }
    const limitName = /^x-([a-z0-9-]+?)-limit-name$/.exec(name);
    if (limitName?.[1] && value) {
      (snapshot.limits[limitName[1]] ??= {}).name = value;
      found = true;
    }
  });
  const plan = headers.get("x-codex-plan-type");
  if (plan) snapshot.planType = plan;
  const active = headers.get("x-codex-active-limit");
  if (active) snapshot.activeLimit = active;
  const hasCredits = bool(headers.get("x-codex-credits-has-credits"));
  const unlimited = bool(headers.get("x-codex-credits-unlimited"));
  const balance = headers.get("x-codex-credits-balance");
  if (hasCredits !== undefined || unlimited !== undefined || balance) {
    snapshot.credits = {};
    if (hasCredits !== undefined) snapshot.credits.hasCredits = hasCredits;
    if (unlimited !== undefined) snapshot.credits.unlimited = unlimited;
    if (balance) snapshot.credits.balance = balance;
  }
  return found || plan || active ? snapshot : undefined;
}

/** Latest reset time (epoch seconds) among windows that are exhausted. */
export function exhaustedResetAt(snapshot: RateLimitSnapshot | undefined): number | undefined {
  if (!snapshot) return undefined;
  let latest: number | undefined;
  for (const limit of Object.values(snapshot.limits)) {
    for (const w of [limit.primary, limit.secondary]) {
      if (w?.usedPercent !== undefined && w.usedPercent >= 100 && w.resetAt !== undefined) {
        latest = latest === undefined ? w.resetAt : Math.max(latest, w.resetAt);
      }
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// GET /backend-api/wham/usage — the quota endpoint the Codex apps use for their usage display.
// ---------------------------------------------------------------------------------------------

export interface UsageWindow {
  usedPercent?: number;
  windowSeconds?: number;
  resetAt?: number;
  resetAfterSeconds?: number;
}

export interface UsageLimit {
  name: string;
  limitReached?: boolean;
  primary?: UsageWindow;
  secondary?: UsageWindow;
}

export interface UsageSnapshot {
  planType?: string;
  allowed?: boolean;
  limitReached?: boolean;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  additional: UsageLimit[];
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  limitReachedType?: string;
}

function parseWindow(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const w: UsageWindow = {};
  const used = num(raw.used_percent);
  if (used !== undefined) w.usedPercent = used;
  const secs = num(raw.limit_window_seconds);
  if (secs !== undefined) w.windowSeconds = secs;
  const resetAt = num(raw.reset_at);
  if (resetAt !== undefined) w.resetAt = resetAt;
  const after = num(raw.reset_after_seconds);
  if (after !== undefined) w.resetAfterSeconds = after;
  return w;
}

function parseLimitBlock(raw: unknown): { allowed?: boolean; limitReached?: boolean; primary?: UsageWindow; secondary?: UsageWindow } {
  if (!isRecord(raw)) return {};
  const out: { allowed?: boolean; limitReached?: boolean; primary?: UsageWindow; secondary?: UsageWindow } = {};
  if (typeof raw.allowed === "boolean") out.allowed = raw.allowed;
  if (typeof raw.limit_reached === "boolean") out.limitReached = raw.limit_reached;
  const primary = parseWindow(raw.primary_window);
  if (primary) out.primary = primary;
  const secondary = parseWindow(raw.secondary_window);
  if (secondary) out.secondary = secondary;
  return out;
}

export function parseUsageResponse(json: unknown): UsageSnapshot {
  const out: UsageSnapshot = { additional: [] };
  if (!isRecord(json)) return out;
  const plan = str(json.plan_type);
  if (plan) out.planType = plan;
  Object.assign(out, parseLimitBlock(json.rate_limit));
  const additional = json.additional_rate_limits;
  const entries = Array.isArray(additional) ? additional : isRecord(additional) ? Object.entries(additional).map(([k, v]) => ({ limit_name: k, ...(isRecord(v) ? v : {}) })) : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = str(entry.limit_name) ?? str(entry.metered_feature) ?? "additional";
    const block = parseLimitBlock(isRecord(entry.rate_limit) ? entry.rate_limit : entry);
    const limit: UsageLimit = { name };
    if (block.limitReached !== undefined) limit.limitReached = block.limitReached;
    if (block.primary) limit.primary = block.primary;
    if (block.secondary) limit.secondary = block.secondary;
    out.additional.push(limit);
  }
  if (isRecord(json.credits)) {
    out.credits = {};
    if (typeof json.credits.has_credits === "boolean") out.credits.hasCredits = json.credits.has_credits;
    if (typeof json.credits.unlimited === "boolean") out.credits.unlimited = json.credits.unlimited;
    const balance = str(json.credits.balance);
    if (balance) out.credits.balance = balance;
  }
  const reachedType = str(json.rate_limit_reached_type);
  if (reachedType) out.limitReachedType = reachedType;
  return out;
}

function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "window";
  if (seconds === 604_800) return "weekly window";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day window`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour window`;
  return `${Math.round(seconds / 60)}-minute window`;
}

export function describeUsageWindow(w: UsageWindow, now = Date.now()): string {
  const used = w.usedPercent === undefined ? "?" : `${Math.round(w.usedPercent)}%`;
  const reset = w.resetAt !== undefined ? `, resets ${formatWhen(w.resetAt * 1000, now)}` : "";
  return `${windowLabel(w.windowSeconds)}: ${used} used${reset}`;
}

/** Human-readable usage lines for status output. */
export function describeUsage(u: UsageSnapshot, now = Date.now()): string[] {
  const lines: string[] = [];
  if (u.limitReached) lines.push(`Limit reached${u.limitReachedType ? ` (${u.limitReachedType})` : ""}.`);
  if (u.primary) lines.push(`Codex ${describeUsageWindow(u.primary, now)}`);
  if (u.secondary) lines.push(`Codex ${describeUsageWindow(u.secondary, now)}`);
  for (const a of u.additional) {
    if (a.primary) lines.push(`${a.name} ${describeUsageWindow(a.primary, now)}`);
    if (a.secondary) lines.push(`${a.name} ${describeUsageWindow(a.secondary, now)}`);
  }
  return lines;
}
