import { ImagegenError } from "../errors.js";
import {
  deviceRedirectUri,
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  requestDeviceCode,
  type OAuthClient,
} from "./oauth.js";
import type { TokenSet } from "./store.js";

export interface DeviceLogin {
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  result: Promise<TokenSet>;
  cancel(): void;
}

/** Start OpenAI's device-code flow (for headless/remote machines where a browser redirect can't reach us). */
export async function startDeviceLogin(client: OAuthClient, signal?: AbortSignal): Promise<DeviceLogin> {
  const device = await requestDeviceCode(client, signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ImagegenError("login_cancelled", "Device-code sign-in was cancelled."));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const result = (async (): Promise<TokenSet> => {
    try {
      const auth = await pollDeviceAuthorization(client, device, controller.signal);
      return await exchangeAuthorizationCode(client, {
        code: auth.authorizationCode,
        redirectUri: deviceRedirectUri(client.issuer),
        codeVerifier: auth.codeVerifier,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new ImagegenError("login_cancelled", "Device-code sign-in was cancelled.");
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();
  result.catch(() => undefined);

  return {
    verificationUrl: device.verificationUrl,
    userCode: device.userCode,
    expiresAt: device.expiresAt,
    result,
    cancel: onAbort,
  };
}
