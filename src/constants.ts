import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { name: string; version: string };

/** npm package name (also the CLI binary name). */
export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;

/** Package root: the directory holding package.json, dist/ and skill/. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The bundled Agent Skill that ships with this package. */
export const SKILL_SOURCE_DIR = path.join(PACKAGE_ROOT, "skill", "imagegen");
export const SKILL_NAME = "imagegen";

/** Default key used for the server in MCP client configs (tools appear as `imagegen_*` in opencode). */
export const DEFAULT_SERVER_NAME = "imagegen";
/** Sent as the `originator` header / authorize parameter so traffic is attributable to this tool. */
export const DEFAULT_ORIGINATOR = "codex-imagegen-mcp";

// ---------------------------------------------------------------------------------------------
// OAuth. These are the public parameters of the Codex CLI OAuth client (a native/public client:
// no secret). OpenAI allow-lists the redirect URIs server-side, which is why the local callback
// must listen on exactly port 1455 (fallback 1457) at /auth/callback. Mirrors codex-rs/login.
// ---------------------------------------------------------------------------------------------
export const OAUTH_ISSUER = "https://auth.openai.com";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Least-privilege scopes sufficient for the image endpoints (Codex additionally asks for api.connectors.*). */
export const OAUTH_SCOPES = "openid profile email offline_access";
export const OAUTH_CALLBACK_PATH = "/auth/callback";
export const OAUTH_CALLBACK_PORTS: readonly number[] = [1455, 1457];
/** Device-code verification page shown to the user. */
export const DEVICE_VERIFICATION_PATH = "/codex/device";
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
export const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// ChatGPT backend (the same endpoints the Codex built-in `image_gen` tool uses).
// ---------------------------------------------------------------------------------------------
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Codex always sends this model id; the server maps it to its current Codex image model. */
export const IMAGE_MODEL = "gpt-image-2";

/** Refresh our own access token when it expires within this window (Codex uses 5 minutes). */
export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
/** Fallback refresh cadence when an access token carries no `exp` claim (Codex: 8 days). */
export const FALLBACK_REFRESH_INTERVAL_MS = 8 * 24 * 3600_000;
/** Borrowed (Codex/opencode) tokens are never refreshed by us; stop using them this long before expiry. */
export const BORROWED_TOKEN_MIN_VALIDITY_MS = 60_000;

export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MAX_INPUT_IMAGES = 5;
/** Per-image cap for inputs sent inline as data URLs (the API caps a data URL at ~20 MiB). */
export const MAX_INPUT_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_OUTPUT_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_VARIANTS = 4;
export const PREVIEW_MAX_EDGE = 1024;
