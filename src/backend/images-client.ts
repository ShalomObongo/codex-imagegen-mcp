import type { AuthManager, Credentials } from "../auth/manager.js";
import { SOURCE_LABELS } from "../auth/manager.js";
import type { CredentialSource } from "../config.js";
import { IMAGE_MODEL, MAX_INPUT_IMAGES, MAX_OUTPUT_IMAGE_BYTES } from "../constants.js";
import { ImagegenError, loginHint, toImagegenError } from "../errors.js";
import { sniffImageMime } from "../images/codec.js";
import type { Logger } from "../log.js";
import { formatWhen } from "../util/format.js";
import { anySignal, isRecord, num, readBody, sleep, snippet, str } from "../util/http.js";
import { exhaustedResetAt, parseRateLimitHeaders, parseUsageResponse, type RateLimitSnapshot, type UsageSnapshot } from "./ratelimits.js";

export type Background = "auto" | "transparent" | "opaque";

export interface ImageInput {
  /** `data:<mime>;base64,<…>` */
  dataUrl: string;
}

export interface CreateImageRequest {
  prompt: string;
  background: Background;
  /** Present => POST /images/edits (edit / reference-guided generation); absent => /images/generations. */
  images?: readonly ImageInput[];
}

export interface CreatedImage {
  bytes: Buffer;
  mimeType: string;
  /** Metadata echoed by the service. */
  background?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  generationId?: string;
  requestId?: string;
  usage?: Record<string, unknown>;
  rateLimits?: RateLimitSnapshot;
  elapsedMs: number;
  credentialSource: CredentialSource;
}

export interface ImagesClientOptions {
  baseUrl: string;
  usageUrl: string;
  originator: string;
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Retries for 5xx / network errors (never 4xx/429). Default 2. */
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS = [1_000, 3_000];

/**
 * Client for the ChatGPT backend image endpoints used by the Codex built-in `image_gen` tool:
 *   POST {base}/images/generations   {prompt, background, model, quality, size}
 *   POST {base}/images/edits         {…, images: [{image_url: data-url}]}   (max 5 images)
 * Auth: `Authorization: Bearer <ChatGPT access token>` + `ChatGPT-Account-ID`.
 */
export class ImagesClient {
  constructor(
    private readonly auth: AuthManager,
    private readonly o: ImagesClientOptions,
  ) {}

  private headers(creds: Credentials): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${creds.accessToken}`,
      originator: this.o.originator,
      "user-agent": this.o.userAgent,
      accept: "application/json",
    };
    if (creds.accountId) h["chatgpt-account-id"] = creds.accountId;
    if (creds.identity.isFedramp) h["x-openai-fedramp"] = "true";
    return h;
  }

  async createImage(req: CreateImageRequest, options: { signal?: AbortSignal } = {}): Promise<CreatedImage> {
    const images = req.images ?? [];
    if (images.length > MAX_INPUT_IMAGES) {
      throw new ImagegenError("invalid_input", `At most ${MAX_INPUT_IMAGES} input images are supported (got ${images.length}).`);
    }
    const endpoint = images.length > 0 ? "images/edits" : "images/generations";
    // Same body the Codex built-in tool sends. The service picks model/quality/size itself;
    // only `prompt`, `background` and `images` influence the result.
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      background: req.background,
      model: IMAGE_MODEL,
      quality: "auto",
      size: "auto",
    };
    if (images.length > 0) body.images = images.map((i) => ({ image_url: i.dataUrl }));
    const payload = JSON.stringify(body);

    const { res, creds, started } = await this.send(`${this.o.baseUrl}/${endpoint}`, "POST", payload, options.signal);
    const requestId = requestIdOf(res.headers);
    const rateLimits = parseRateLimitHeaders(res.headers);
    const { json, text } = await readBody(res);
    const first = isRecord(json) && Array.isArray(json.data) ? (json.data[0] as unknown) : undefined;
    const b64 = isRecord(first) ? str(first.b64_json) : undefined;
    if (!b64) {
      throw new ImagegenError("server_error", `The image service returned no image data${text ? `: ${snippet(text, 200)}` : "."}`, {
        details: { requestId },
        retryable: true,
      });
    }
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
      throw new ImagegenError("server_error", `The image service returned an invalid image (${bytes.length} bytes).`, { details: { requestId } });
    }
    const result: CreatedImage = {
      bytes,
      mimeType: sniffImageMime(bytes) ?? "image/png",
      elapsedMs: Date.now() - started,
      credentialSource: creds.source,
    };
    const meta = isRecord(json) ? json : {};
    const background = str(meta.background);
    if (background) result.background = background;
    const size = str(meta.size);
    if (size) result.size = size;
    const quality = str(meta.quality);
    if (quality) result.quality = quality;
    const format = str(meta.output_format);
    if (format) result.outputFormat = format;
    if (isRecord(first)) {
      const gen = str(first.generation_id);
      if (gen) result.generationId = gen;
    }
    if (requestId) result.requestId = requestId;
    if (isRecord(meta.usage)) result.usage = meta.usage;
    if (rateLimits) result.rateLimits = rateLimits;
    return result;
  }

  /** Current plan + quota windows (does not consume any quota). */
  async getUsage(options: { signal?: AbortSignal } = {}): Promise<UsageSnapshot & { credentialSource: CredentialSource }> {
    const { res, creds } = await this.send(this.o.usageUrl, "GET", undefined, options.signal);
    const { json } = await readBody(res);
    return { ...parseUsageResponse(json), credentialSource: creds.source };
  }

  /**
   * Send with auth, a per-attempt timeout, one 401 recovery (refresh / re-read / next source) and
   * bounded retries for transient failures. Returns only successful responses.
   */
  private async send(url: string, method: "GET" | "POST", payload: string | undefined, signal: AbortSignal | undefined) {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const maxRetries = this.o.maxRetries ?? 2;
    const delays = this.o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    let creds = await this.auth.getCredentials();
    let authRecovered = false;
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      let res: Response;
      try {
        const headers = this.headers(creds);
        if (payload !== undefined) headers["content-type"] = "application/json";
        const init: RequestInit = { method, headers, signal: anySignal(signal, AbortSignal.timeout(this.o.timeoutMs)) ?? null };
        if (payload !== undefined) init.body = payload;
        res = await fetchImpl(url, init);
      } catch (err) {
        const e = signal?.aborted ? new ImagegenError("cancelled", "The request was cancelled.") : toImagegenError(err, "network");
        if (e.retryable && attempt < maxRetries) {
          this.o.logger.warn("request failed; retrying", { url, attempt, message: e.message });
          await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1_000, signal);
          attempt++;
          continue;
        }
        throw e;
      }
      if (res.ok) return { res, creds, started };
      const error = await errorFromResponse(res, creds);
      if (res.status === 401 && !authRecovered) {
        authRecovered = true;
        const next = await this.auth.recoverFromUnauthorized(creds);
        if (next) {
          this.o.logger.info("retrying with recovered credentials", { from: creds.source, to: next.source });
          creds = next;
          continue;
        }
      }
      if (error.retryable && attempt < maxRetries) {
        this.o.logger.warn("transient backend error; retrying", { url, status: res.status, attempt });
        await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1_000, signal);
        attempt++;
        continue;
      }
      this.o.logger.warn("backend request failed", { url, status: res.status, kind: error.kind, requestId: error.details.requestId });
      throw error;
    }
  }
}

function requestIdOf(headers: Headers): string | undefined {
  return headers.get("x-codex-imagegen-request-id") ?? headers.get("x-oai-request-id") ?? headers.get("x-request-id") ?? undefined;
}

const POLICY_CODES = new Set(["moderation_blocked", "content_policy_violation", "safety_violation", "image_generation_user_error_moderation"]);

/** Map a non-2xx backend response onto an actionable ImagegenError. */
export async function errorFromResponse(res: Response, creds: Credentials): Promise<ImagegenError> {
  const { json, text } = await readBody(res);
  const status = res.status;
  const err = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  const type = str(err?.type);
  const code = str(err?.code);
  const detail = isRecord(json) ? (str(json.detail) ?? (isRecord(json.detail) ? str(json.detail.message) : undefined)) : undefined;
  const message = str(err?.message) ?? detail ?? (isRecord(json) ? str(json.message) : undefined);
  const requestId = requestIdOf(res.headers);
  const rateLimits = parseRateLimitHeaders(res.headers);
  const details: Record<string, unknown> = { status, type, code, requestId, cfRay: res.headers.get("cf-ray") ?? undefined };
  const isCloudflare = /cloudflare|cf-chl|just a moment/i.test(text) && !json;

  if (status === 401) {
    return new ImagegenError(
      "auth_failed",
      `ChatGPT rejected the ${SOURCE_LABELS[creds.source]} (HTTP 401${message ? `: ${message}` : ""}). ${loginHint()}`,
      { details },
    );
  }
  if (status === 403) {
    if (isCloudflare) {
      return new ImagegenError("blocked", "The request was blocked by Cloudflare before reaching ChatGPT (HTTP 403).", { details });
    }
    return new ImagegenError(
      "auth_failed",
      `Access denied (HTTP 403${message ? `: ${message}` : ""}). Your ChatGPT plan or workspace may not include Codex image generation (it is not available on the Free plan).`,
      { details },
    );
  }
  if (status === 429) {
    const resetsAt = num(err?.resets_at) ?? exhaustedResetAt(rateLimits);
    const plan = str(err?.plan_type) ?? rateLimits?.planType ?? creds.identity.planType;
    if (resetsAt !== undefined) details.resetsAt = resetsAt;
    if (type === "usage_not_included") {
      return new ImagegenError("usage_limit", `Your ChatGPT${plan ? ` ${plan}` : ""} plan does not include Codex image generation.`, { details });
    }
    const when = resetsAt !== undefined ? ` It resets ${formatWhen(resetsAt * 1000)}.` : "";
    const what = type === "usage_limit_reached" ? "You've hit your ChatGPT image-generation usage limit" : "Rate limited by ChatGPT (HTTP 429)";
    return new ImagegenError("usage_limit", `${what}${plan ? ` (${plan} plan)` : ""}.${when}${message && type !== "usage_limit_reached" ? ` ${message}` : ""}`, {
      details,
    });
  }
  if (status === 400 || status === 422) {
    const policy =
      (code !== undefined && POLICY_CODES.has(code)) || /safety|moderation|content policy|policy violation|not allowed/i.test(message ?? "");
    if (policy) {
      return new ImagegenError("content_policy", `The request was rejected by OpenAI's safety system${message ? `: ${message}` : "."}`, { details });
    }
    return new ImagegenError("invalid_request", `The image service rejected the request (HTTP ${status})${message ? `: ${message}` : "."}`, { details });
  }
  if (status === 413) {
    return new ImagegenError("invalid_input", "The request is too large — use fewer or smaller input images.", { details });
  }
  if (status >= 500) {
    return new ImagegenError("server_error", `OpenAI's image service had a problem (HTTP ${status})${message ? `: ${message}` : "."}`, {
      details,
      retryable: true,
    });
  }
  return new ImagegenError("internal", `Unexpected response from the image service (HTTP ${status})${message ? `: ${message}` : text ? `: ${snippet(text, 200)}` : "."}`, {
    details,
  });
}
