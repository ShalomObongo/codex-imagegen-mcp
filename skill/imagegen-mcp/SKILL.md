---
name: imagegen-mcp
description: Generate or edit raster images (photos, illustrations, textures, sprites, icons, product shots, mockups, transparent cutouts) with the imagegen MCP tools, which use the user's ChatGPT plan through the same image service as OpenAI Codex's built-in image tool — no API key. Use when the task benefits from an AI-created bitmap, when transforming an existing image, or when deriving variants from reference images. Do not use when the result is better made as SVG/vector/HTML/CSS/canvas code or by extending an existing icon or logo system in the repo.
---

# Image Generation Skill (imagegen MCP)

Generates or edits images for the current project — website and game assets, UI and product mockups, wireframes, logo exploration, photorealistic images, infographics — using the **imagegen MCP server**. It runs on the user's ChatGPT subscription (the same backend OpenAI Codex uses for its built-in `image_gen` tool), so no `OPENAI_API_KEY` is needed.

## Tools

Tool names are prefixed by the client: `imagegen_generate_image` in opencode, `mcp__imagegen__generate_image` in Claude Code, and so on.

| Tool | Use it to |
|---|---|
| `generate_image` | Create a new image from a prompt. |
| `edit_image` | Change existing image(s), or generate guided by 1-5 reference images. |
| `remove_background` | Cut out a flat, solid-color backdrop locally (no network, no quota). |
| `auth_status` | Check sign-in, plan and usage limits (no quota). |
| `sign_in` | Start a ChatGPT sign-in; relay the returned link or code to the user. |

Parameter details and service behavior: `references/tools.md`.

## Rules

- Use `generate_image` / `edit_image` for every raster request. Do not substitute SVG/HTML/CSS placeholders when the user asked for a photo, illustration, sprite, product image, banner or other bitmap.
- **One call per distinct asset.** `n` (1-4) is only for variants of the *same* prompt. Many assets → one call each, with its own prompt.
- Every image counts against the user's ChatGPT usage limits. Don't generate speculative extras; ask before large batches (more than ~6 images).
- **The service picks resolution and quality.** Choose the shape with `aspect_ratio` (or describe the orientation in the prompt). Don't promise exact pixel sizes; if exact dimensions are required, generate the closest aspect ratio, then resize or crop with local tools.
- **Transparent assets:** pass `background: "transparent"` and keep the alpha. The result says `alpha verified` when the PNG really has transparency. If it comes back opaque, see *Transparent images* below.
- **Never overwrite** an existing asset unless the user asked for replacement. The tools already refuse to overwrite and pick a `-2`, `-3`… sibling; prefer descriptive versioned names such as `hero-v2.png`.
- If a tool reports **not signed in / session expired**, call `sign_in` and give the user the link (or device code) verbatim, or ask them to run the login command named in the error. Then call `auth_status`.
- On a **usage-limit** error, stop generating and tell the user when the limit resets. Don't retry in a loop.
- On a **content-policy** rejection, don't resend the same prompt; rephrase within policy or ask the user.

## Save-path policy

- Without `output_path`, images are saved to the server's image library (outside the project). The path is returned.
- If the image is meant for the current project, pass `output_path` inside the workspace, relative to the workspace root (e.g. `public/images/hero.png`, `assets/sprites/`), or copy the file there afterwards. Never leave a project-referenced asset only in the library.
- A directory `output_path` (existing, or ending in `/`) gets an auto-generated descriptive file name.
- Preview/brainstorm-only images can stay in the library.
- Use `.png` for anything with transparency. `.jpg` / `output_format: "jpeg"` is converted locally and is fine for photos.
- Always report the final saved path(s) to the user.

## When to use
- Generate a new image (concept art, product shot, cover, website hero, game asset, texture, icon, sticker)
- Generate a new image using one or more reference images for style, composition, subject or mood
- Edit an existing image (object removal/insertion, background replacement or removal, relighting, weather or time of day, restyling, text localization, compositing, sketch-to-render)
- Produce several assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system or illustration library in the repo
- Simple shapes, diagrams, wireframes or icons that are better produced directly in SVG, HTML/CSS or canvas
- Small edits to a project asset that exists in an editable native format
- Any task where the user clearly wants deterministic, code-native output

## Decision tree

1. **Intent:** new image or edit?
   - The user wants to modify an existing image while preserving parts of it → **edit** (`edit_image`, the image as Image 1).
   - Images are provided only as style, composition or mood references → **generate with references** (`edit_image`, prompt says "use Image 1 only as a style reference").
   - No images → **generate** (`generate_image`).
2. **Execution:** one asset, variants of one prompt (`n`), or many distinct assets (one call each)?
3. **Destination:** preview-only (library) or project-bound (`output_path` in the workspace)?

Assume a new image unless the user clearly asks to change an existing one.

## Workflow
1. Decide intent, execution strategy and destination (above).
2. Collect inputs up front: prompt(s), exact text (verbatim), constraints/avoid list, input images.
3. For every input image, state its role in the prompt: `Image 1: edit target`, `Image 2: style reference`, `Image 3: object to insert`. `edit_image` takes local paths directly (absolute, `~/…` or workspace-relative), http(s) URLs or data URLs — no need to open the file first.
4. Shape the prompt with the schema below, following the specificity policy:
   - specific, detailed prompt → normalize it into the schema without adding creative requirements;
   - generic prompt → add only tasteful detail that materially improves the result.
5. Pick `aspect_ratio` from the intended use (hero/banner 16:9 or 21:9, phone wallpaper/story 9:16, social post 1:1 or 4:5, poster 2:3, product/thumbnail 1:1…) and `background` (`transparent` for sprites, icons, stickers, logos, cutouts).
6. Call the tool. Generation usually takes 15-60 s.
7. Inspect the attached preview: subject, style, composition, text accuracy, invariants, avoid-list. Transparent regions appear as a checkerboard.
8. If something is off, iterate with **one targeted change**, repeating the invariants. For edits of a previous result, pass the previous output path as Image 1.
9. Persist project-bound finals in the workspace, update the code that references them, and report the path(s) and the final prompt(s).

## Transparent images
- Ask for it directly: `background: "transparent"`, plus a prompt that isolates the subject (e.g. "isolated subject, clean edges, no backdrop, no shadow on the ground").
- The PNG keeps real alpha; keep it (don't flatten or convert to JPEG).
- If a result comes back opaque, or a cutout needs cleanup:
  1. Generate the subject on a perfectly flat, uniform key color that does not appear in the subject: `#00ff00` for most subjects, `#ff00ff` for green subjects. Use no gradient, no shadow, no texture, no floor. Say this explicitly in the prompt.
  2. Run `remove_background` on it (the key color is auto-detected from the border, or pass `key_color`). Tune with `edge_contract: 1` if a thin fringe remains, or a small `edge_feather` for softer edges.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the goal clearer and more actionable, but do not blindly add detail. Use only the lines that help.

### Specificity policy
- Already specific and detailed → preserve that specificity; only normalize/structure it.
- Generic → you may add tasteful augmentation when it will materially improve the result.

Allowed augmentations: composition or framing hints; polish level or intended-use hints; practical layout guidance; reasonable scene concreteness that supports the request.

Not allowed: extra characters or objects not implied by the request; brand names, slogans, palettes or narrative beats not implied; arbitrary side-specific placement unless the surrounding layout supports it.

## Use-case taxonomy (exact slugs)

Generate:
- photorealistic-natural — candid/editorial lifestyle scenes with real texture and natural lighting.
- product-mockup — product/packaging shots, catalog imagery, merch concepts.
- ui-mockup — app/web interface mockups and wireframes; specify the desired fidelity.
- infographic-diagram — diagrams/infographics with structured layout and text.
- scientific-educational — classroom explainers, scientific diagrams and learning visuals with required labels and accuracy constraints.
- ads-marketing — campaign concepts and ad creatives with audience, brand position, scene and exact tagline/copy.
- productivity-visual — slide, chart, workflow and data-heavy business visuals.
- logo-brand — logo/mark exploration, vector-friendly.
- illustration-story — comics, children's book art, narrative scenes.
- stylized-concept — style-driven concept art, 3D/stylized renders.
- historical-scene — period-accurate/world-knowledge scenes.

Edit:
- text-localization — translate/replace in-image text, preserve layout.
- identity-preserve — try-on, person-in-scene; lock face/body/pose.
- precise-object-edit — remove/replace a specific element (including interior swaps).
- lighting-weather — time-of-day/season/atmosphere changes only.
- background-extraction — transparent background / clean cutout (`background: "transparent"`).
- style-transfer — apply reference style while changing subject/scene.
- compositing — multi-image insert/merge with matched lighting/perspective.
- sketch-to-render — drawing/line art to photoreal render.

## Shared prompt schema

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Notes:
- `Scene/backdrop` is the visual setting; transparency is controlled by the `background` tool parameter, not by prompt text alone.
- Resolution, quality and model are chosen by the service. Don't put `Quality:` or pixel sizes in the prompt expecting them to be enforced; use `aspect_ratio` for shape.
- Keep it short. For edits, explicitly list invariants (`change only X; keep Y unchanged`). If a critical detail is missing and blocks success, ask; otherwise proceed.

## Examples

### Generation (hero image)
`generate_image` with `aspect_ratio: "16:9"`, `output_path: "public/images/hero-mug.png"`:
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit (invariants)
`edit_image` with `images: ["assets/product.jpg"]`, `output_path: "assets/product-sunset.png"`:
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: Image 1 — replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product, its edges, labels and shadows unchanged; no text; no watermark
```

### Transparent sprite
`generate_image` with `background: "transparent"`, `aspect_ratio: "1:1"`, `output_path: "assets/sprites/"`:
```text
Use case: stylized-concept
Asset type: 2D game sprite
Primary request: a friendly slime monster, front view, full body
Style/medium: clean cel-shaded game art with a crisp outline
Constraints: isolated subject, no backdrop, no ground shadow, no text
```

## Prompting best practices
- Order: scene/backdrop → subject → details → constraints; include the intended use to set the polish level.
- Use camera/composition language for photorealism.
- Quote exact text and specify typography and placement; spell tricky words letter by letter and require verbatim rendering.
- For multi-image inputs, reference images by index and describe how each is used.
- For edits, repeat invariants on every iteration to reduce drift; iterate with single-change follow-ups.

More principles: `references/prompting.md`. Copy/paste recipes and asset-type templates (website, game, wireframe, logo): `references/sample-prompts.md`. Tool parameters, limits and error handling: `references/tools.md`.
