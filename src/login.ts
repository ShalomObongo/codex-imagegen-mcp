import { startBrowserLogin } from "./auth/browser-login.js";
import { startDeviceLogin } from "./auth/device-login.js";
import type { ChatGptIdentity } from "./auth/jwt.js";
import type { LoginMethod, TokenSet } from "./auth/store.js";
import type { ServerDeps } from "./server/context.js";
import { openInBrowser } from "./util/open.js";

export interface LoginOutcome {
  identity: ChatGptIdentity;
  revokedPrevious: boolean;
}

/**
 * Interactive ChatGPT sign-in from a terminal (browser or device code). Shared by the `login`
 * command and the installer's final step; `print` receives the instructions to show the user.
 */
export async function performLogin(
  deps: ServerDeps,
  options: { method: LoginMethod; openBrowser: boolean; signal: AbortSignal; print: (text: string) => void },
): Promise<LoginOutcome> {
  let tokens: TokenSet;
  if (options.method === "device") {
    const login = await startDeviceLogin(deps.auth.oauthClient, options.signal);
    options.print(`To sign in, open this page on any device and enter the code:\n\n    ${login.verificationUrl}\n    Code: ${login.userCode}\n`);
    options.print("The code expires in 15 minutes. If ChatGPT says device codes are disabled, enable");
    options.print("“device code authorization for Codex” in ChatGPT → Settings → Security, or use browser login.\n");
    options.print("Waiting for approval… (Ctrl+C to cancel)");
    tokens = await login.result;
  } else {
    const login = await startBrowserLogin({ ...deps.auth.oauthClient, originator: deps.config.originator, signal: options.signal });
    const opened = options.openBrowser && !deps.config.noBrowser ? await openInBrowser(login.url) : false;
    options.print(opened ? "Opened your browser to sign in with ChatGPT. If it did not open, visit:\n" : "Open this URL in a browser on this machine to sign in with ChatGPT:\n");
    options.print(`  ${login.url}\n`);
    options.print("Waiting for you to finish signing in… (Ctrl+C to cancel; use --device on a headless machine)");
    tokens = await login.result;
  }
  return deps.auth.saveLogin(tokens, options.method);
}

export function describeSignIn(identity: ChatGptIdentity): string {
  return `Signed in${identity.email ? ` as ${identity.email}` : ""}${identity.planType ? ` (ChatGPT ${identity.planType} plan)` : ""}.`;
}
