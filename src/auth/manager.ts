import type { CredentialMode, CredentialSource, RuntimeConfig } from "../config.js";
import {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  BORROWED_TOKEN_MIN_VALIDITY_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
} from "../constants.js";
import { ImagegenError, loginHint, toImagegenError } from "../errors.js";
import type { Logger } from "../log.js";
import { formatWhen } from "../util/format.js";
import { withFileLock } from "../util/fs.js";
import { readCodexCredential, readOpencodeCredential, type BorrowResult } from "./borrowed.js";
import { identityFromTokens, jwtExpiryMs, type ChatGptIdentity } from "./jwt.js";
import { refreshAccessToken, revokeToken, type OAuthClient } from "./oauth.js";
import {
  buildStoredAuth,
  deleteStoredAuth,
  readStoredAuth,
  writeStoredAuth,
  type LoginMethod,
  type StoredAuth,
  type TokenSet,
} from "./store.js";

/** A usable bearer credential for the ChatGPT backend. */
export interface Credentials {
  source: CredentialSource;
  file: string;
  accessToken: string;
  accountId?: string;
  identity: ChatGptIdentity;
  expiresAt?: number;
}

export type SourceState = "ready" | "refreshable" | "missing" | "expired" | "unusable" | "disabled";

export interface SourceReport {
  source: CredentialSource;
  label: string;
  file: string;
  state: SourceState;
  detail: string;
  identity?: ChatGptIdentity;
  expiresAt?: number;
  lastRefresh?: string;
  loginMethod?: LoginMethod;
}

export const SOURCE_LABELS: Record<CredentialSource, string> = {
  own: "codex-imagegen-mcp sign-in",
  codex: "Codex sign-in (borrowed, read-only)",
  opencode: "opencode ChatGPT sign-in (borrowed, read-only)",
};

const OWNER_APP: Record<Exclude<CredentialSource, "own">, string> = { codex: "Codex", opencode: "opencode" };

export interface AuthManagerOptions {
  mode: CredentialMode;
  authFile: string;
  lockFile: string;
  codexAuthFile: string;
  opencodeAuthFile: string;
  oauth: OAuthClient;
  originator: string;
  logger: Logger;
  now?: () => number;
}

export function authOptionsFromConfig(config: RuntimeConfig, logger: Logger, fetchImpl?: typeof fetch): AuthManagerOptions {
  const oauth: OAuthClient = { issuer: config.issuer, clientId: config.clientId, userAgent: config.userAgent };
  if (fetchImpl) oauth.fetchImpl = fetchImpl;
  return {
    mode: config.credentialMode,
    authFile: config.authFile,
    lockFile: config.lockFile,
    codexAuthFile: config.codexAuthFile,
    opencodeAuthFile: config.opencodeAuthFile,
    oauth,
    originator: config.originator,
    logger,
  };
}

type Resolution = { credentials: Credentials } | { reason: string };

/**
 * Resolves credentials for the ChatGPT backend from, in order:
 *   1. our own sign-in (`login`), refreshed automatically under a cross-process lock;
 *   2. the Codex CLI/app sign-in (read-only, never refreshed by us);
 *   3. the opencode ChatGPT sign-in (read-only, never refreshed by us).
 * `CODEX_IMAGEGEN_CREDENTIALS=own|codex|opencode` pins a single source.
 */
export class AuthManager {
  /** Access tokens the backend rejected with 401 during this process's lifetime. */
  private readonly rejected = new Set<string>();

  constructor(private readonly o: AuthManagerOptions) {}

  get mode(): CredentialMode {
    return this.o.mode;
  }

  get oauthClient(): OAuthClient {
    return this.o.oauth;
  }

  enabledSources(): CredentialSource[] {
    return this.o.mode === "auto" ? ["own", "codex", "opencode"] : [this.o.mode];
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Return credentials that are valid right now (refreshing our own tokens if needed). */
  async getCredentials(): Promise<Credentials> {
    const reasons: string[] = [];
    const errors: ImagegenError[] = [];
    for (const source of this.enabledSources()) {
      try {
        const r = await this.resolve(source);
        if ("credentials" in r) return r.credentials;
        reasons.push(`${SOURCE_LABELS[source]}: ${r.reason}`);
      } catch (err) {
        const e = toImagegenError(err);
        if (e.kind === "cancelled") throw e;
        errors.push(e);
        reasons.push(`${SOURCE_LABELS[source]}: ${e.message}`);
        this.o.logger.warn("credential source failed", { source, kind: e.kind, message: e.message });
      }
    }
    const expired = errors.find((e) => e.kind === "session_expired");
    if (expired) {
      throw new ImagegenError("session_expired", `${expired.message} ${loginHint()}`, { details: { sources: reasons }, cause: expired });
    }
    const transient = errors.find((e) => e.retryable);
    if (transient) throw transient;
    throw new ImagegenError("not_signed_in", `Not signed in to ChatGPT. ${loginHint()} (Checked — ${reasons.join("; ")}.)`, {
      details: { sources: reasons },
    });
  }

  /**
   * Called after the backend answered 401 for `failed`. Marks that token as rejected and returns a
   * different usable credential (refreshed own token, a re-read borrowed token, or the next source).
   */
  async recoverFromUnauthorized(failed: Credentials): Promise<Credentials | undefined> {
    this.rejected.add(failed.accessToken);
    try {
      const next = await this.getCredentials();
      return next.accessToken === failed.accessToken ? undefined : next;
    } catch (err) {
      this.o.logger.warn("could not recover from 401", { message: toImagegenError(err).message });
      return undefined;
    }
  }

  private async resolve(source: CredentialSource): Promise<Resolution> {
    if (source === "own") return this.resolveOwn();
    const read = source === "codex" ? await readCodexCredential(this.o.codexAuthFile) : await readOpencodeCredential(this.o.opencodeAuthFile);
    return this.resolveBorrowed(source, read);
  }

  private resolveBorrowed(source: Exclude<CredentialSource, "own">, read: BorrowResult): Resolution {
    if (!read.ok) return { reason: read.reason };
    const c = read.credential;
    if (this.rejected.has(c.accessToken)) {
      return { reason: `ChatGPT rejected its access token; open ${OWNER_APP[source]} once so it refreshes the sign-in` };
    }
    if (c.expiresAt !== undefined && c.expiresAt - this.now() < BORROWED_TOKEN_MIN_VALIDITY_MS) {
      return { reason: `its access token expired ${formatWhen(c.expiresAt, this.now())}; open ${OWNER_APP[source]} once to refresh it` };
    }
    const credentials: Credentials = { source, file: c.file, accessToken: c.accessToken, identity: c.identity };
    if (c.accountId) credentials.accountId = c.accountId;
    if (c.expiresAt !== undefined) credentials.expiresAt = c.expiresAt;
    return { credentials };
  }

  private ownToCredentials(stored: StoredAuth): Credentials {
    const identity = identityFromTokens(stored.tokens.id_token, stored.tokens.access_token);
    const credentials: Credentials = {
      source: "own",
      file: this.o.authFile,
      accessToken: stored.tokens.access_token,
      identity,
    };
    const accountId = stored.tokens.account_id ?? identity.accountId;
    if (accountId) credentials.accountId = accountId;
    const exp = jwtExpiryMs(stored.tokens.access_token);
    if (exp !== undefined) credentials.expiresAt = exp;
    return credentials;
  }

  private needsRefresh(stored: StoredAuth): boolean {
    if (this.rejected.has(stored.tokens.access_token)) return true;
    const exp = jwtExpiryMs(stored.tokens.access_token);
    if (exp !== undefined) return exp - this.now() <= ACCESS_TOKEN_REFRESH_WINDOW_MS;
    const last = Date.parse(stored.last_refresh);
    return !Number.isFinite(last) || this.now() - last >= FALLBACK_REFRESH_INTERVAL_MS;
  }

  private async resolveOwn(): Promise<Resolution> {
    const stored = await readStoredAuth(this.o.authFile);
    if (!stored) return { reason: "not signed in" };
    if (!this.needsRefresh(stored)) return { credentials: this.ownToCredentials(stored) };
    return { credentials: await this.refreshOwn(stored.tokens.access_token) };
  }

  /**
   * Refresh under a cross-process lock. After acquiring it we re-read the file: if another process
   * already rotated the tokens we adopt its result instead of spending the (single-use) refresh
   * token again — which would invalidate the whole sign-in with `refresh_token_reused`.
   */
  private async refreshOwn(staleAccessToken: string): Promise<Credentials> {
    return withFileLock(this.o.lockFile, async () => {
      const latest = await readStoredAuth(this.o.authFile);
      if (!latest) throw new ImagegenError("not_signed_in", "You were signed out while the sign-in was being refreshed.");
      if (latest.tokens.access_token !== staleAccessToken && !this.needsRefresh(latest)) {
        this.o.logger.debug("adopting tokens refreshed by another process");
        return this.ownToCredentials(latest);
      }
      let fresh: Partial<TokenSet>;
      try {
        fresh = await refreshAccessToken(this.o.oauth, { refreshToken: latest.tokens.refresh_token, originator: this.o.originator });
      } catch (err) {
        const e = toImagegenError(err);
        const exp = jwtExpiryMs(latest.tokens.access_token);
        const stillUsable = exp !== undefined && exp - this.now() > 30_000 && !this.rejected.has(latest.tokens.access_token);
        if (e.kind !== "session_expired" && stillUsable) {
          this.o.logger.warn("token refresh failed; using the current access token until it expires", { message: e.message });
          return this.ownToCredentials(latest);
        }
        throw e;
      }
      const next: StoredAuth = { ...latest, tokens: { ...latest.tokens }, last_refresh: new Date(this.now()).toISOString() };
      if (fresh.accessToken) next.tokens.access_token = fresh.accessToken;
      if (fresh.refreshToken) next.tokens.refresh_token = fresh.refreshToken;
      if (fresh.idToken) next.tokens.id_token = fresh.idToken;
      if (!next.tokens.account_id) {
        const accountId = identityFromTokens(next.tokens.id_token, next.tokens.access_token).accountId;
        if (accountId) next.tokens.account_id = accountId;
      }
      await writeStoredAuth(this.o.authFile, next);
      this.o.logger.info("refreshed ChatGPT access token");
      return this.ownToCredentials(next);
    });
  }

  /**
   * Persist a fresh login (replacing and revoking any previous one of ours). `onSaved` runs as soon
   * as the credentials are on disk, before the old sign-in is revoked, so callers can report the
   * sign-in as finished at the same moment status starts reporting it as signed in.
   */
  async saveLogin(
    tokens: TokenSet,
    method: LoginMethod,
    onSaved?: (identity: ChatGptIdentity) => void,
  ): Promise<{ stored: StoredAuth; identity: ChatGptIdentity; revokedPrevious: boolean }> {
    return withFileLock(this.o.lockFile, async () => {
      const previous = await readStoredAuth(this.o.authFile).catch(() => undefined);
      const stored = buildStoredAuth(tokens, method, new Date(this.now()));
      await writeStoredAuth(this.o.authFile, stored);
      this.rejected.clear();
      onSaved?.(identityFromTokens(stored.tokens.id_token, stored.tokens.access_token));
      let revokedPrevious = false;
      if (previous && previous.tokens.refresh_token !== stored.tokens.refresh_token) {
        revokedPrevious = await revokeToken(this.o.oauth, previous.tokens.refresh_token, "refresh_token");
      }
      return { stored, identity: identityFromTokens(stored.tokens.id_token, stored.tokens.access_token), revokedPrevious };
    });
  }

  /** Remove our own credentials (never touches Codex/opencode files). */
  async logout(options: { revoke: boolean }): Promise<{ hadCredentials: boolean; removed: boolean; revoked: boolean }> {
    return withFileLock(this.o.lockFile, async () => {
      const stored = await readStoredAuth(this.o.authFile).catch(() => undefined);
      let revoked = false;
      if (stored && options.revoke) revoked = await revokeToken(this.o.oauth, stored.tokens.refresh_token, "refresh_token");
      const removed = await deleteStoredAuth(this.o.authFile);
      return { hadCredentials: Boolean(stored), removed, revoked };
    });
  }

  /** Describe every credential source without refreshing anything. */
  async inspect(): Promise<SourceReport[]> {
    const enabled = new Set(this.enabledSources());
    const disabledDetail = `disabled (CODEX_IMAGEGEN_CREDENTIALS=${this.o.mode})`;
    const own = await this.inspectOwn();
    const codex = this.inspectBorrowed("codex", this.o.codexAuthFile, await readCodexCredential(this.o.codexAuthFile));
    const opencode = this.inspectBorrowed("opencode", this.o.opencodeAuthFile, await readOpencodeCredential(this.o.opencodeAuthFile));
    return [own, codex, opencode].map((r) => (enabled.has(r.source) ? r : { ...r, state: "disabled" as const, detail: disabledDetail }));
  }

  /** The source `getCredentials()` would pick, based on an `inspect()` report. */
  static activeSource(reports: readonly SourceReport[]): SourceReport | undefined {
    return reports.find((r) => r.state === "ready" || r.state === "refreshable");
  }

  private async inspectOwn(): Promise<SourceReport> {
    const base = { source: "own" as const, label: SOURCE_LABELS.own, file: this.o.authFile };
    let stored: StoredAuth | undefined;
    try {
      stored = await readStoredAuth(this.o.authFile);
    } catch (err) {
      return { ...base, state: "unusable", detail: toImagegenError(err).message };
    }
    if (!stored) return { ...base, state: "missing", detail: "not signed in" };
    const identity = identityFromTokens(stored.tokens.id_token, stored.tokens.access_token);
    const report: SourceReport = {
      ...base,
      state: "ready",
      detail: "signed in",
      identity,
      lastRefresh: stored.last_refresh,
      loginMethod: stored.login_method,
    };
    const exp = jwtExpiryMs(stored.tokens.access_token);
    if (exp !== undefined) report.expiresAt = exp;
    if (this.needsRefresh(stored)) {
      report.state = "refreshable";
      report.detail = "access token expired or expiring; it is refreshed automatically on next use";
    }
    return report;
  }

  private inspectBorrowed(source: Exclude<CredentialSource, "own">, file: string, read: BorrowResult): SourceReport {
    const base = { source, label: SOURCE_LABELS[source], file };
    if (!read.ok) return { ...base, state: read.missing ? "missing" : "unusable", detail: read.reason };
    const c = read.credential;
    const report: SourceReport = { ...base, state: "ready", detail: "signed in", identity: c.identity };
    if (c.expiresAt !== undefined) report.expiresAt = c.expiresAt;
    if (this.rejected.has(c.accessToken)) {
      report.state = "unusable";
      report.detail = `ChatGPT rejected this token; open ${OWNER_APP[source]} once to refresh it`;
    } else if (c.expiresAt !== undefined && c.expiresAt - this.now() < BORROWED_TOKEN_MIN_VALIDITY_MS) {
      report.state = "expired";
      report.detail = `access token expired ${formatWhen(c.expiresAt, this.now())}; open ${OWNER_APP[source]} once to refresh it`;
    }
    return report;
  }
}
