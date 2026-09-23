# Tools, resources and prompts

Server name in client configs: `imagegen` by default. Clients prefix the tool names:

| Client | Tool name format |
|---|---|
| opencode | `imagegen_generate_image` |
| Claude Code | `mcp__imagegen__generate_image` |
| Cursor, VS Code | `generate_image`, shown under the server |

Relative paths resolve against the **workspace root**. That is the first `file://` root the client reports through MCP roots (opencode reports the project directory), or else the directory the client started the server in. A filesystem root such as `/` falls back to the home directory.

## generate_image

Generate a new image from a text prompt. The server calls `POST https://chatgpt.com/backend-api/codex/images/generations`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `prompt` | string, 1-32000 | required | Image description. Structure it (see the skill). |
| `aspect_ratio` | enum | `auto` | `auto`, `1:1`, `4:5`, `5:4`, `4:3`, `3:4`, `3:2`, `2:3`, `16:9`, `9:16`, `21:9`, `9:21`. Appended to the prompt as `Aspect ratio: 16:9, wide landscape (horizontal) canvas.`; the service sizes the canvas from the prompt. |
| `background` | enum | `auto` | `transparent` gives a PNG with real alpha. `opaque` asks for a filled background. |
| `n` | int 1-4 | `1` | Variants of the same prompt, sent as concurrent requests. Each counts against the quota. |
| `output_path` | string | image library | A `.png`/`.jpg`/`.jpeg` file or a directory (existing, or ending in `/`). With `n > 1`, `-1`, `-2`… is inserted before the extension. |
| `output_format` | `png` \| `jpeg` | `png` | JPEG is converted locally (flattened on white) and is incompatible with `transparent`. It is inferred from the `output_path` extension. |
| `overwrite` | bool | `false` | When false, an existing file is never replaced; the next free `name-2.png`, `name-3.png`… is used. |
| `include_preview` | bool | `true` | Attach a JPEG preview (longest edge 1024 px, checkerboard behind transparency). |

**Default location** (no `output_path`): `$CODEX_IMAGEGEN_OUTPUT_DIR`, which defaults to `~/.local/share/codex-imagegen-mcp/images`. Files go in `/YYYY-MM-DD/HHMMSS-<prompt-slug>.png`.

**Result:**
- **Text:** one line per saved file (path, dimensions, format, size, background, id), a warning if a transparent request came back opaque, and guidance for the model.
- **Image blocks:** one preview per saved file, when enabled.
- **`structuredContent`**, validated against the declared `outputSchema`:

```json
{
  "images": [
    { "id": "img_aa289474550c", "path": "/abs/project/assets/hero.png", "mime_type": "image/png",
      "bytes": 2063882, "width": 1672, "height": 941, "background": "opaque" }
  ],
  "prompt": "…exact prompt sent, including the aspect-ratio line…",
  "elapsed_ms": 22834,
  "failures": [],
  "warnings": []
}
```

`transparent: true|false` is included when transparency was requested. It records whether the decoded PNG actually contains non-opaque pixels.

**Partial success:** with `n > 1`, results that succeed are saved and returned, and the ones that fail are listed in `failures`. The call is only an error (`isError: true`) if nothing was produced.

## edit_image

Edit images, or generate using references. The server calls `POST https://chatgpt.com/backend-api/codex/images/edits` with the images inlined as data URLs.

It takes the same parameters as `generate_image`, plus:

| Parameter | Type | Description |
|---|---|---|
| `images` | string[], 1-5 | Local paths (absolute, `~/…`, workspace-relative), `file://` URLs, `http(s)://` URLs (downloaded with a 60 s timeout), or `data:image/…;base64,…`. PNG, JPEG or WebP, up to 15 MB each; formats are detected by magic bytes. |

- `images[0]` is **Image 1**, the primary edit target. Refer to inputs by index in the prompt and spell out the invariants.
- Input files are never modified.
- To iterate on a result, pass the previous output path as Image 1.

## remove_background

A local chroma-key cutout: a TypeScript port of the Codex skill's `scripts/remove_chroma_key.py`, with the same algorithm. It makes no network call and uses no quota.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `input_path` | string | required | PNG or JPEG |
| `output_path` | string (`.png`) | `<input>-transparent.png` | Never overwrites unless `overwrite: true` |
| `key_color` | `#rrggbb` | auto | When omitted, the per-channel median of a 6 px border band |
| `soft_matte` | bool | `true` | Smoothstep alpha between `transparent_threshold` and `opaque_threshold`, combined with key-channel dominance |
| `despill` | bool | `true` | Caps key-colored channels on semi-transparent pixels |
| `tolerance` | 0-255 | `12` | Hard key (`soft_matte: false`): max per-channel distance treated as background |
| `transparent_threshold` | 0-255 | `12` | Soft matte: at or below this distance, fully transparent |
| `opaque_threshold` | 0-255 | `96` | Soft matte: at or above this distance, fully opaque |
| `edge_contract` | 0-16 | `0` | Erode the matte N px (3×3 min filter) to kill halos |
| `edge_feather` | 0-64 | `0` | Gaussian blur radius for the alpha edge |
| `overwrite`, `include_preview` | bool | `false`, `true` | As above |

The result reports the key color used and the percentages of fully transparent and soft-edge pixels. It warns if nothing matched the key, or if more than 97% became transparent.

## auth_status

| Parameter | Default | Description |
|---|---|---|
| `check_usage` | `true` | Also fetch `GET /backend-api/wham/usage` (free) for the usage windows |

**Output:** a text report covering:
- the active source, account email, plan and account suffix;
- token expiry;
- the usage windows (e.g. `Codex 5-hour window: 6% used, resets in 32m`);
- any sign-in in progress and the last sign-in outcome;
- every credential source with its state (`✓` ready, `·` missing, `✗` expired/unusable, `-` disabled).

## sign_in

| Parameter | Default | Description |
|---|---|---|
| `method` | `browser` | `browser`: an authorize link that redirects to `http://localhost:1455` on this machine. `device`: a code to enter at `https://auth.openai.com/codex/device` from any device. |
| `open_browser` | `true` | Try to open the link on this machine |
| `force` | `false` | Start a new sign-in even when one already exists (switch account/workspace) |

The tool returns immediately with the link or code, and the sign-in completes in the background. Only one sign-in runs at a time, so a second call returns the pending one. The model should relay the link or code verbatim, then call `auth_status`.

## Errors

Errors are returned as `isError: true` results. The text states the problem and the next step:

| Kind | Typical message → next step |
|---|---|
| `not_signed_in` | `Not signed in to ChatGPT. Sign in by running … login … or call the sign_in tool` |
| `session_expired` | `Your sign-in was invalidated … Please sign in again.` |
| `auth_failed` | HTTP 401 (credentials rejected), or 403 (plan or workspace lacks the feature) |
| `usage_limit` | `You've hit your ChatGPT image-generation usage limit (plus plan). It resets in 1h 12m …` → don't retry |
| `content_policy` | `The request was rejected by OpenAI's safety system: …` → rephrase |
| `invalid_request` / `invalid_input` / `unsupported` | Bad parameters, paths, formats or sizes → fix the arguments |
| `server_error` / `network` / `timeout` | Transient. The server already retried 5xx and network errors twice (1 s, 3 s); one more try is reasonable |
| `blocked` | Cloudflare challenge → try later or from another network |

The ChatGPT request id (`x-codex-imagegen-request-id`) is appended when available.

## Resources

| URI | Type | Content |
|---|---|---|
| `imagegen://history` | `application/json` | The 50 most recent saved images, newest first: id, time, tool, path, size, prompt, inputs, request ids |
| `imagegen://images/{id}` | image blob | The saved file, or a 2048 px JPEG preview if it is larger than 8 MB. Listed: the 25 most recent. |
| `imagegen://skill/SKILL.md`, `imagegen://skill/references/*.md` | `text/markdown` | The bundled skill, for clients without Agent Skills support |

History is also written to `$CODEX_IMAGEGEN_HOME/history.jsonl`.

## Prompts

| Prompt | Arguments | Expands to |
|---|---|---|
| `generate` | `description` | A request to use `generate_image` with the skill's workflow checklist |
| `edit` | `image`, `change` | A request to use `edit_image` with invariant-preserving instructions |

In opencode these appear as `/imagegen:generate` and `/imagegen:edit`.

## Progress, timeouts and cancellation

- **Progress:** while a request runs, the server sends `notifications/progress` every 5 s whenever the client supplied a progress token. opencode supplies one and resets its request timeout on each notification (`resetTimeoutOnProgress`), so 15-60 s generations never hit its 60 s default.
- **Timeout:** the backend request itself times out after `CODEX_IMAGEGEN_TIMEOUT_MS` (300 s).
- **Cancellation:** cancelling the tool call (`notifications/cancelled`) aborts the HTTP request.
