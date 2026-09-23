import { startBrowserLogin } from "../auth/browser-login.js";
import { startDeviceLogin } from "../auth/device-login.js";
import type { AuthManager } from "../auth/manager.js";
import type { RuntimeConfig } from "../config.js";
import { toImagegenError } from "../errors.js";
import type { Logger } from "../log.js";
import { openInBrowser } from "../util/open.js";

export type LoginMethod = "browser" | "device";

export interface PendingLogin {
  method: LoginMethod;
  /** Browser: the authorize URL. Device: the verification page. */
  url: string;
  userCode?: string;
  startedAt: number;
  expiresAt?: number;
}

export interface LoginOutcome {
  ok: boolean;
  message: string;
  at: number;
}

/**
 * Runs at most one sign-in at a time inside a long-lived server process, so the `sign_in` tool can
 * hand the user a link immediately while the OAuth round-trip completes in the background.
 */
export class LoginCoordinator {
  private pending: { info: PendingLogin; cancel: () => void } | undefined;
  private last: LoginOutcome | undefined;

  constructor(private readonly deps: { config: RuntimeConfig; auth: AuthManager; logger: Logger }) {}

  get pendingLogin(): PendingLogin | undefined {
    return this.pending?.info;
  }

  get lastOutcome(): LoginOutcome | undefined {
    return this.last;
  }

  async start(method: LoginMethod, options: { openBrowser: boolean }): Promise<{ info: PendingLogin; reused: boolean; browserOpened: boolean }> {
    if (this.pending && this.pending.info.method === method) {
      return { info: this.pending.info, reused: true, browserOpened: false };
    }
    this.cancel();
    const { config, auth, logger } = this.deps;
    const oauth = auth.oauthClient;
    let info: PendingLogin;
    let result: Promise<import("../auth/store.js").TokenSet>;
    let cancel: () => void;
    if (method === "browser") {
      const login = await startBrowserLogin({ ...oauth, originator: config.originator });
      info = { method, url: login.url, startedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 };
      result = login.result;
      cancel = login.cancel;
    } else {
      const login = await startDeviceLogin(oauth);
      info = { method, url: login.verificationUrl, userCode: login.userCode, startedAt: Date.now(), expiresAt: login.expiresAt };
      result = login.result;
      cancel = login.cancel;
    }
    const entry = { info, cancel };
    this.pending = entry;
    logger.info("sign-in started", { method });
    let saved = false;
    result
      .then((tokens) =>
        // Record the outcome the moment the credentials are written, so auth_status never shows
        // "signed in" next to a sign-in that still looks in progress.
        auth.saveLogin(tokens, method, (identity) => {
          saved = true;
          this.last = { ok: true, message: `Signed in${identity.email ? ` as ${identity.email}` : ""}${identity.planType ? ` (ChatGPT ${identity.planType})` : ""}.`, at: Date.now() };
          if (this.pending === entry) this.pending = undefined;
        }),
      )
      .then(({ identity }) => {
        logger.info("sign-in completed", { method, plan: identity.planType });
      })
      .catch((err: unknown) => {
        if (saved) {
          logger.warn("sign-in saved, but finishing up failed", { method, message: err instanceof Error ? err.message : String(err) });
          return;
        }
        const e = toImagegenError(err, "login_failed");
        this.last = { ok: false, message: e.message, at: Date.now() };
        logger.warn("sign-in failed", { method, kind: e.kind, message: e.message });
      })
      .finally(() => {
        if (this.pending === entry) this.pending = undefined;
      });

    let browserOpened = false;
    if (method === "browser" && options.openBrowser && !config.noBrowser) browserOpened = await openInBrowser(info.url);
    return { info, reused: false, browserOpened };
  }

  cancel(): void {
    const p = this.pending;
    this.pending = undefined;
    p?.cancel();
  }
}
