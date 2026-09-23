import { cliInvocation } from "./util/invocation.js";

/**
 * Error categories surfaced to users and models. Each maps to a concrete next step,
 * so tool results can tell the model exactly what to do (or what to tell the user).
 */
export type ErrorKind =
  | "not_signed_in"
  | "session_expired"
  | "auth_failed"
  | "login_failed"
  | "login_cancelled"
  | "usage_limit"
  | "content_policy"
  | "invalid_request"
  | "invalid_input"
  | "unsupported"
  | "server_error"
  | "network"
  | "timeout"
  | "cancelled"
  | "blocked"
  | "internal";

export interface ImagegenErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  retryable?: boolean;
}

export class ImagegenError extends Error {
  readonly kind: ErrorKind;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(kind: ErrorKind, message: string, options: ImagegenErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ImagegenError";
    this.kind = kind;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Normalize anything thrown into an ImagegenError. */
export function toImagegenError(err: unknown, fallbackKind: ErrorKind = "internal"): ImagegenError {
  if (err instanceof ImagegenError) return err;
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return new ImagegenError("timeout", "The request timed out.", { cause: err, retryable: true });
    if (err.name === "AbortError") return new ImagegenError("cancelled", "The request was cancelled.", { cause: err });
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
      const cause = err.cause as NodeJS.ErrnoException | undefined;
      const detail = cause?.code ?? cause?.message ?? "";
      return new ImagegenError("network", `Network error while contacting OpenAI${detail ? ` (${detail})` : ""}.`, {
        cause: err,
        retryable: true,
      });
    }
    if (code === "ENOENT") return new ImagegenError("invalid_input", err.message, { cause: err });
    return new ImagegenError(fallbackKind, err.message, { cause: err });
  }
  return new ImagegenError(fallbackKind, String(err));
}

export function loginHint(): string {
  return `Sign in by running \`${cliInvocation()} login\` in a terminal (or call the \`sign_in\` tool to get a sign-in link), then retry.`;
}

/** Human/model-facing one-paragraph description of an error, including the next step. */
export function describeError(err: ImagegenError): string {
  const lines = [err.message];
  switch (err.kind) {
    case "not_signed_in":
    case "session_expired":
    case "auth_failed":
      if (!err.message.includes("login")) lines.push(loginHint());
      break;
    case "usage_limit":
      lines.push("Do not retry until the limit resets. Tell the user; they can check quota with the `auth_status` tool.");
      break;
    case "content_policy":
      lines.push("Rephrase the prompt to comply with OpenAI's usage policies; do not retry the same prompt.");
      break;
    case "server_error":
    case "network":
    case "timeout":
      lines.push("This is usually transient; retrying once is reasonable.");
      break;
    case "blocked":
      lines.push("Try again later, from another network, or sign in to chatgpt.com in a browser once.");
      break;
    default:
      break;
  }
  const requestId = err.details.requestId;
  if (typeof requestId === "string" && requestId) lines.push(`(request id: ${requestId})`);
  return lines.join(" ");
}
