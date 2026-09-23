import { isRecord, str } from "../util/http.js";

export type JwtPayload = Record<string, unknown>;

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

/**
 * Decode a JWT payload WITHOUT verifying the signature. That is fine here: tokens come straight
 * from OpenAI's token endpoint (or the user's own credential files) and are only read for
 * display/expiry; the backend is what validates them. Mirrors codex-rs/login/src/token_data.rs.
 */
export function decodeJwtPayload(token: string | undefined): JwtPayload | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `exp` claim in epoch milliseconds, if present. */
export function jwtExpiryMs(token: string | undefined): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export interface ChatGptIdentity {
  email?: string;
  /** ChatGPT plan, e.g. "free" | "plus" | "pro" | "team" | "business" | "enterprise" | "edu" | "go". */
  planType?: string;
  /** ChatGPT workspace/account id; sent as the `ChatGPT-Account-ID` header. */
  accountId?: string;
  userId?: string;
  isFedramp: boolean;
}

function readIdentity(payload: JwtPayload | undefined): Partial<ChatGptIdentity> {
  if (!payload) return {};
  const auth = isRecord(payload[AUTH_CLAIM]) ? payload[AUTH_CLAIM] : {};
  const profile = isRecord(payload[PROFILE_CLAIM]) ? payload[PROFILE_CLAIM] : {};
  const out: Partial<ChatGptIdentity> = {};
  const email = str(payload.email) ?? str(profile.email);
  if (email) out.email = email;
  const plan = str(auth.chatgpt_plan_type);
  if (plan) out.planType = plan;
  const account = str(auth.chatgpt_account_id);
  if (account) out.accountId = account;
  const user = str(auth.chatgpt_user_id) ?? str(auth.user_id);
  if (user) out.userId = user;
  if (auth.chatgpt_account_is_fedramp === true) out.isFedramp = true;
  return out;
}

/** Identity from the id_token, with access-token claims as fallback for missing fields. */
export function identityFromTokens(idToken?: string, accessToken?: string): ChatGptIdentity {
  const fromId = readIdentity(decodeJwtPayload(idToken));
  const fromAccess = readIdentity(decodeJwtPayload(accessToken));
  const merged: ChatGptIdentity = { isFedramp: Boolean(fromId.isFedramp ?? fromAccess.isFedramp) };
  const email = fromId.email ?? fromAccess.email;
  if (email) merged.email = email;
  const planType = fromId.planType ?? fromAccess.planType;
  if (planType) merged.planType = planType;
  const accountId = fromId.accountId ?? fromAccess.accountId;
  if (accountId) merged.accountId = accountId;
  const userId = fromId.userId ?? fromAccess.userId;
  if (userId) merged.userId = userId;
  return merged;
}
