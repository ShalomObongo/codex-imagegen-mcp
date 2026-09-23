import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ProgressReporter {
  update(message: string): void;
  stop(): void;
}

/**
 * Heartbeat progress notifications while a long request runs. Clients such as opencode reset
 * their per-request timeout on every progress notification (resetTimeoutOnProgress), so a
 * 30-60 s image generation never trips a 60 s default timeout. No-op if the client did not send a
 * progress token.
 */
export function startProgress(extra: ToolExtra, label: string, intervalMs = 5_000): ProgressReporter {
  const token = extra._meta?.progressToken;
  if (token === undefined) return { update() {}, stop() {} };
  const started = Date.now();
  let progress = 0;
  let stopped = false;
  const send = (message: string) => {
    if (stopped || extra.signal.aborted) return;
    progress += 1;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, message } })
      .catch(() => undefined);
  };
  send(`${label}…`);
  const timer = setInterval(() => send(`${label}… ${Math.round((Date.now() - started) / 1000)}s`), intervalMs);
  timer.unref();
  return {
    update: send,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
