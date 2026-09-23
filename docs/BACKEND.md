# How Codex image generation works

These findings come from taking apart the Codex desktop app and its bundled CLI, reading the matching open-source Codex code, and measuring the live service.

**Measured:**
- 2026-09-22 and 2026-09-23, on a ChatGPT **Plus** account.
- Codex desktop app `/Applications/ChatGPT.app`: bundle id `com.openai.codex`, version 26.917.51856.
- Its bundled CLI `Contents/Resources/codex`: 0.155.0-alpha.16.
- The matching source tag `openai/codex@rust-v0.155.0-alpha.16`.

## Two layers: a skill and a built-in tool

Codex's image generation is two separate things.

1. **The `imagegen` skill** is instructions only.
   - It is embedded in the `codex` binary. On startup it is written to `$CODEX_HOME/skills/.system/imagegen/`, with a fingerprint in `.codex-system-skills.marker`.
   - The model sees only the skill's name, description and path, and reads `SKILL.md` on demand.
   - It describes when to generate images, how to structure prompts, and a save-path policy.
   - It also offers an optional API-key CLI fallback (`scripts/image_gen.py`, `OPENAI_API_KEY`) and a chroma-key helper (`scripts/remove_chroma_key.py`).
   - The byte-exact copy is in [`upstream/codex-imagegen-skill/`](../upstream/codex-imagegen-skill/).

2. **The built-in tool `image_gen.imagegen`** does the actual work.
   - It is registered by the `codex-rs/ext/image-generation` crate.
   - It is sent to the model as a namespaced function tool with three inputs:
     - `prompt`
     - `referenced_image_paths`: up to 5 absolute paths
     - `num_last_images_to_include`: 1-5 recent conversation images; mutually exclusive with `referenced_image_paths`
   - It is only offered when **all** of these hold (`core/src/tools/spec_plan.rs`):
     - the `image_generation` feature is on (it is by default);
     - the account is **not on the Free plan**;
     - the model accepts image input;
     - the provider uses OpenAI/ChatGPT auth. API-key auth does not get the tool.

## The HTTP API

```http
POST https://chatgpt.com/backend-api/codex/images/generations    # no input images
POST https://chatgpt.com/backend-api/codex/images/edits          # with input images
Authorization: Bearer <ChatGPT OAuth access token>
ChatGPT-Account-ID: <chatgpt_account_id>
originator: <client id, e.g. codex_cli_rs>
User-Agent: <originator>/<version> (<os>; <arch>) <terminal>
Content-Type: application/json

{"prompt":"…","background":"auto","model":"gpt-image-2","quality":"auto","size":"auto"}
# edits add: "images":[{"image_url":"data:image/png;base64,…"}]  (max 5)
```

- **Constants:** Codex hard-codes `model: "gpt-image-2"`, `quality: "auto"`, `size: "auto"` and `background: "auto"` (`ext/image-generation/src/tool.rs`). This was still true on upstream `main` as of 2026-09-22.
- **Response:**
  - Body: `{created, background, data:[{b64_json, generation_id}], output_format, quality, size, usage}`.
  - Headers: `x-codex-imagegen-request-id`, `x-oai-request-id`, and the rate-limit headers below.
- **What Codex does with it:**
  - The client decodes the first image and saves it to `$CODEX_HOME/generated_images/<thread>/<call_id>.png`.
  - It returns the image to the model along with a note that the user can already see it.
  - The desktop app renders it inline, with Edit/Canvas actions and a context menu.

## What the service honors (measured)

| Request | Result |
|---|---|
| `size: "17x17"` | 1536×1024; invalid size silently ignored |
| `size: "1024x1024"`, `quality: "medium"`, `output_format: "jpeg"`, `n: 2` | **1370×1148, quality `low`, PNG, 1 image**: all four ignored |
| `model: "gpt-image-bogus-does-not-exist"` | 200 OK, normal image: model ignored |
| `model: "gpt-image-2.5-sunburst"`, `quality: "xhigh"`, `size: "2048x2048"` | 1536×1024, quality `medium` |
| `model: "gpt-image-2.5-flare"`, `quality: "max"`, `size: "1024x1536"` | 1536×1024, quality `medium` |
| `background: "transparent"` (generation) | **1024×1536 RGBA PNG** with real alpha |
| `background: "transparent"` (edit, "remove the table and backdrop") | **RGBA PNG**: 55% fully transparent, subject alpha 251-254 |
| Prompt starts "Tall vertical 9:16 portrait phone wallpaper: …" | **941×1672** (exactly 9:16) |
| Prompt ends with "Aspect ratio: 16:9, wide landscape (horizontal) canvas." | **1672×941** (exactly 16:9) |
| 4 requests in parallel on one account | All 200, in 17-25 s each |

**Conclusion:**
- Only **`prompt`**, **`background`** and **`images`** influence the result.
- Model, quality, pixel size, count and format are **chosen by the service**.
- The canvas shape follows the **prompt text**.

This is why this MCP server:
- exposes `aspect_ratio` as a prompt line;
- implements `n` as parallel requests;
- converts JPEG output locally;
- does not offer `model`, `size` or `quality` parameters that would be silently ignored.

## Newer image models (gpt-image-2.5 "sunburst" / "flare")

OpenAI released `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` on 2026-09-08. They add `xhigh`/`max` quality and native transparency on the public Images API. Through a **ChatGPT sign-in**, the results were:

- **Images endpoint** (`/backend-api/codex/images/*`): the model name is ignored (see the table above). Requesting a 2.5 model, `xhigh`/`max` quality or a 2K size still returns the service's default output at `medium`/`low` quality.
- **Responses endpoint** (`POST /backend-api/codex/responses` with the hosted `image_generation` tool):
  - The server **rewrites the tool config** to `{"model":"gpt-image-2-codex","quality":"auto","size":"auto",…}` whatever model was requested; its `response.created` echo shows this.
  - Tool options that the rewritten model doesn't support are rejected up front:

    | Option | Error |
    |---|---|
    | `background: "transparent"` | `400 image_generation_user_error: "Transparent background is not supported for this model."` |
    | `input_fidelity` | `400 invalid_input_fidelity_model: "The model 'gpt-image-2-codex' does not support the 'input_fidelity' parameter."` |
    | An unknown model name | `server_is_overloaded` failure |
  - This path also returns a `revised_prompt`, but it adds a chat-model turn, so it is slower and costlier than the Images endpoint.
- **Codex desktop app:** its "ImageGen 2.5" announcement ("Image creation got a major upgrade — Higher-quality results, faster generation, and smarter creative tools") is gated by a Statsig flag. The client still sends `gpt-image-2`, so the upgrade is **server-side**: whatever model backs `gpt-image-2` for Codex (reported as `gpt-image-2-codex`) is what every ChatGPT-signed-in client gets.

**So:** a ChatGPT sign-in cannot select a model. This server, like Codex, automatically benefits when OpenAI upgrades the Codex image model server-side. Explicit `gpt-image-2.5-*` selection, exact sizes and `xhigh`/`max` quality require the billed OpenAI Platform API, which is out of scope for this project by design.

## Quota and rate limits

- **`GET https://chatgpt.com/backend-api/wham/usage`** (same auth headers, **no quota cost**) returns:
  - `plan_type`
  - `rate_limit.{allowed, limit_reached, primary_window, secondary_window}`: a 5-hour (`limit_window_seconds: 18000`) and a weekly (`604800`) window, each with `used_percent`, `reset_at` and `reset_after_seconds`
  - `additional_rate_limits` and `credits`

  The Codex apps use it for their usage display; this server uses it for `auth_status`, `status` and `doctor`.
- **Response headers on every image call:**
  - `x-codex-plan-type`
  - `x-codex-active-limit` (observed: `premium`)
  - `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds}`
  - `x-codex-credits-*`
- **Separate image limit:** when a separate image limit applies, Codex expects `x-image-gen-*` equivalents (limit id `image_gen`).
- **Exhausted limit:** a `429` returns `{"error":{"type":"usage_limit_reached","resets_at":…,"plan_type":…}}`, and `usage_not_included` means the plan lacks the feature.
- **Retries:** Codex retries 5xx and transport errors, never 429.

## Output files

- **Format and size:** PNG. Around 1.5 MP depending on aspect ratio: 1536×1024, 1024×1536, 1672×941, 941×1672, 1254×1254 or 1370×1148.
- **Latency:** 15-45 s per request.
- **Provenance:** every file carries a **C2PA** manifest in a `caBX` chunk. It is signed by "OpenAI Media Service", with claim generator `ChatGPT`/`gpt-image` and `digitalSourceType` `trainedAlgorithmicMedia`. This server writes the service's PNG bytes unchanged, so the manifest is preserved; JPEG conversion drops it.

## Authentication

See [AUTH.md](AUTH.md): OAuth (PKCE and device code) with the Codex public client, a roughly 10-day access token, and rotating single-use refresh tokens.

Minimal scopes (`openid profile email offline_access`) are enough for the image endpoints. This was verified with a token that opencode obtained with exactly those scopes.

## How this MCP server differs from Codex's built-in tool

| | Codex built-in `image_gen` | codex-imagegen-mcp |
|---|---|---|
| Clients | Codex CLI/IDE/app only | Any MCP client |
| Auth | Codex's ChatGPT sign-in | Own sign-in (browser or device), or Codex/opencode borrowed read-only |
| Endpoint and body | `/images/{generations,edits}`, as above | Identical |
| Save location | `$CODEX_HOME/generated_images/…`; the model copies files into the project | Library by default, or directly to `output_path` in the workspace (no overwrite) |
| Inputs | Absolute paths / recent images | Paths (workspace-relative OK), URLs, data URLs |
| Aspect ratio | Via the prompt | `aspect_ratio` parameter, as a prompt line |
| Variants | One call per variant | `n` 1-4, in parallel |
| Transparency | `background` not exposed (skill: "ask for transparency") | `background: "transparent"` passed through; alpha verified in the result |
| Chroma key | Python script | Built-in `remove_background` tool (same algorithm) |
| Result to model | Full image | 1024 px JPEG preview (full file on disk) |
