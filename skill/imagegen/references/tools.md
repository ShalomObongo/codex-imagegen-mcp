# imagegen MCP tools reference

The server exposes five tools. Clients add a prefix (`imagegen_generate_image` in opencode, `mcp__imagegen__generate_image` in Claude Code). All paths may be absolute, `~/…`, or relative to the workspace root (the client's MCP root, or the directory the server was started in).

## generate_image

Create a new image from text. Calls `POST /backend-api/codex/images/generations`.

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | required | 1-32000 characters. Use the labeled schema from `SKILL.md`. |
| `aspect_ratio` | `auto` | `1:1`, `4:5`, `5:4`, `4:3`, `3:4`, `3:2`, `2:3`, `16:9`, `9:16`, `21:9`, `9:21`. Appended to the prompt as an explicit line; the service then picks a matching canvas. |
| `background` | `auto` | `transparent` returns a PNG with real alpha. `opaque` forces a filled background. |
| `n` | `1` | 1-4 variants of the same prompt, run as parallel requests. Each one counts against the quota. |
| `output_path` | library | File (`.png`, `.jpg`, `.jpeg`) or directory. Without it, the image goes to the server's image library, outside the project. |
| `output_format` | `png` | `jpeg` is converted locally, flattened on white, and cannot be transparent. Inferred from the `output_path` extension. |
| `overwrite` | `false` | When false, an existing file is never replaced; `name-2.png`, `name-3.png`… is used instead. |
| `include_preview` | `true` | Attaches a downscaled JPEG preview (longest edge 1024 px). Transparent areas are shown as a checkerboard. |

The text result lists each saved file with its dimensions, size, background, and an id such as `img_ab12…`. It also includes the exact prompt sent and any warnings.

## edit_image

Edit images, or generate with reference images. Calls `POST /backend-api/codex/images/edits`. It takes the same parameters as `generate_image`, plus:

| Parameter | Notes |
|---|---|
| `images` | Required, 1-5 entries: local paths, `file://` URLs, `http(s)://` URLs, or `data:image/…;base64,…`. PNG, JPEG or WebP, up to 15 MB each. |

- **Indexing:** `images[0]` is Image 1, the primary edit target. Refer to the others by index in the prompt.
- **Inputs:** the input files are never modified.
- **Iterating:** pass a previous output path as Image 1.

## remove_background

Local chroma-key removal. This is a port of the Codex skill's `remove_chroma_key.py`. It makes no network call and uses no quota.

| Parameter | Default | Notes |
|---|---|---|
| `input_path` | required | PNG or JPEG. |
| `output_path` | `<input>-transparent.png` | Must be `.png`. Never overwrites unless `overwrite: true`. |
| `key_color` | auto | Hex color such as `#00ff00`. When omitted, it is the median color of the image border. |
| `soft_matte` | `true` | Smooth alpha ramp between `transparent_threshold` (12) and `opaque_threshold` (96), using per-channel max distance to the key. |
| `despill` | `true` | Removes key-color fringe from semi-transparent edge pixels. |
| `tolerance` | `12` | Hard-key tolerance, used only when `soft_matte: false`. |
| `edge_contract` | `0` | Erodes the matte by N pixels (0-16) to remove a thin halo. |
| `edge_feather` | `0` | Gaussian blur radius (0-64) for softer edges. |

The result reports the key color used and the fully and partially transparent percentages. It warns when nothing matched or when almost everything became transparent.

## auth_status

- **Reports:** whether a usable sign-in exists, which source and ChatGPT account/plan it belongs to, and when its token expires.
- **Quota:** the usage windows (5-hour and weekly), fetched from `GET /backend-api/wham/usage`, which uses no image quota.
- **During sign-in:** it also shows any sign-in that is in progress.

## sign_in

| Parameter | Default | Notes |
|---|---|---|
| `method` | `browser` | `browser`: the user opens a link on this machine, and the sign-in redirects to `http://localhost:1455`. `device`: the user enters a code at `https://auth.openai.com/codex/device` from any device; it must be enabled in ChatGPT → Settings → Security. |
| `open_browser` | `true` | Tries to open the link automatically. |
| `force` | `false` | Starts a new sign-in even if one exists, e.g. to switch accounts. |

Returns immediately with the link or code, and sign-in completes in the background. Relay the link or code to the user verbatim, then call `auth_status`.

## Where credentials come from

The server checks these sources in order:
1. **Its own sign-in** (`codex-imagegen-mcp login` or `sign_in`). Refreshed automatically.
2. **The Codex CLI/app sign-in** at `~/.codex/auth.json`. Read-only; used while its token is valid.
3. **The opencode ChatGPT sign-in** at `~/.local/share/opencode/auth.json`. Read-only.

Borrowed sign-ins are never refreshed or modified, because refreshing them would sign the other app out. When a borrowed token expires, opening that app renews it, or you can sign in to this server directly.

## Errors and what to do

| Error | Meaning | Do |
|---|---|---|
| not signed in / session expired / HTTP 401 | No usable ChatGPT credentials | `sign_in` (relay the link), or ask the user to run the login command in the message, then `auth_status`. |
| usage limit (HTTP 429) | ChatGPT image or Codex usage limit reached | Stop. Tell the user when it resets (included in the message). |
| content policy | The prompt or output was blocked by OpenAI's safety system | Rephrase within policy, or ask the user. Don't resend the same prompt. |
| HTTP 403 | The plan or workspace doesn't include Codex image generation (e.g. Free), or the request was blocked | Tell the user; `auth_status` shows the plan. |
| server error / network / timeout | Transient | One retry is reasonable (the server already retries 5xx twice). |
| invalid input | Bad path, unsupported format (GIF, SVG), too large, too many images | Fix the arguments. |

## Limits
- Up to 5 input images, each at most 15 MB; up to 4 variants per call.
- Typical latency is 15-60 s per image. Requests are parallel, so `n: 4` takes about as long as one.
- Service output is a PNG up to about 1672×941 / 1536×1024 / 1024×1536 (roughly 1.5-1.6 MP). Larger or exact sizes need local resizing.
