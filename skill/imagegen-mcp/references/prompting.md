# Prompting best practices

Prompt-shaping principles for the imagegen MCP tools (`generate_image`, `edit_image`). Adapted from the OpenAI Codex imagegen skill. This file is about prompt structure, specificity and iteration; tool parameters live in `references/tools.md`.

## Contents
- [Structure](#structure)
- [Specificity policy](#specificity-policy)
- [Allowed and disallowed augmentation](#allowed-and-disallowed-augmentation)
- [Composition and layout](#composition-and-layout)
- [Constraints and invariants](#constraints-and-invariants)
- [Text in images](#text-in-images)
- [Input images and references](#input-images-and-references)
- [Iterate deliberately](#iterate-deliberately)
- [Transparent images](#transparent-images)
- [What the service controls](#what-the-service-controls)
- [Use-case tips](#use-case-tips)
- [Where to find copy/paste recipes](#where-to-find-copypaste-recipes)

## Structure
- Use a consistent order: scene/backdrop -> subject -> key details -> constraints -> output intent.
- Include intended use (ad, UI mock, infographic) to set the level of polish.
- For complex requests, use short labeled lines instead of one long paragraph.

## Specificity policy
- If the user prompt is already specific and detailed, normalize it into a clean spec without adding creative requirements.
- If the prompt is generic, you may add tasteful detail when it materially improves the output.
- Treat examples in `sample-prompts.md` as fully-authored recipes, not as the default amount of augmentation to add to every request.
- For photorealism, include `photorealistic` directly when that is the goal, plus concrete real-world texture such as pores, wrinkles, fabric wear, material grain, or imperfect everyday detail.

## Allowed and disallowed augmentation

Allowed augmentation for generic prompts:
- composition and framing cues
- intended-use or polish-level hints
- practical layout guidance
- reasonable scene concreteness that supports the request

Do not add:
- extra characters, props, or objects that are not implied
- brand palettes, slogans, or story beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Composition and layout
- Specify framing and viewpoint (close-up, wide, top-down) and placement only when it materially helps.
- Call out negative space if the asset clearly needs room for UI or copy.
- Avoid making left/right layout decisions unless the user or surrounding layout supports them.
- For people, describe body framing, scale, gaze, and object interactions when they matter (`full body visible`, `looking down at the book`, `hands naturally gripping the handlebars`).
- Set the canvas shape with the `aspect_ratio` parameter; you can reinforce it in the prompt ("tall vertical poster").

## Constraints and invariants
- State what must not change (`keep background unchanged`).
- For edits, say `change only X; keep Y unchanged` and repeat invariants on every iteration to reduce drift.

## Text in images
- Put literal text in quotes or ALL CAPS and specify typography (font style, size, color, placement).
- Spell uncommon words letter-by-letter if accuracy matters.
- For in-image copy, require verbatim rendering and no extra characters.
- Keep dense text (legends, axes, footnotes) to what is truly needed; always proofread text in the preview before finishing, and iterate on just the wrong words.

## Input images and references
- Do not assume that every provided image is an edit target.
- Label each image by index and role (`Image 1: edit target`, `Image 2: style reference`). The order of `images` in `edit_image` defines the indices.
- If the user provides images for style, composition, or mood guidance and does not ask to modify them, treat the request as generation with references.
- If the user asks to preserve an existing image while changing specific parts, treat the request as an edit.
- For compositing, describe how the images interact (`place the subject from Image 2 into Image 1`).
- To keep iterating on a result, pass the previously saved output path as Image 1.

## Iterate deliberately
- Start with a clean base prompt, then make small single-change edits.
- Re-specify critical constraints when you iterate.
- Prefer one targeted follow-up at a time over rewriting the whole prompt.

## Transparent images
- Pass `background: "transparent"`; the output PNG keeps real alpha — preserve it.
- In the prompt, isolate the subject: `isolated subject, clean edges, no backdrop, no cast shadow on the ground`.
- Fallback when a result is opaque or needs cleanup: generate on a perfectly flat, uniform key color (`#00ff00`, or `#ff00ff` for green subjects; no gradient, shadow, texture or floor), then run `remove_background`.

## What the service controls
The ChatGPT image service (the one Codex's built-in tool uses) decides several things itself:
- **Model:** the service's current Codex image model. Model names cannot be selected.
- **Resolution and quality:** chosen per request. Pixel-size and quality parameters are ignored.
- **Aspect ratio:** follows the prompt. The `aspect_ratio` parameter adds an explicit line (e.g. `16:9` gave 1672×941; `9:16` gave 941×1672).
- **Output format:** always PNG from the service. JPEG output is converted locally.
- **Count:** one image per request. `n` is implemented as parallel requests.
- **Masks / input fidelity:** not supported; describe the region to change in words (masking is prompt-based anyway).

## Use-case tips
Generate:
- photorealistic-natural: Prompt as if a real photo is captured in the moment; use photography language (lens, lighting, framing); call for real texture; avoid over-stylized polish unless requested.
- product-mockup: Describe the product/packaging and materials; ensure clean silhouette and label clarity; if in-image text is needed, require verbatim rendering and specify typography.
- ui-mockup: Describe the target fidelity first (shippable mockup or low-fi wireframe), then focus on layout, hierarchy, and practical UI elements; avoid concept-art language.
- infographic-diagram: Define the audience and layout flow; label parts explicitly; require verbatim text; keep labels few and large.
- logo-brand: Keep it simple and scalable; ask for a strong silhouette and balanced negative space; avoid decorative flourishes unless requested.
- ads-marketing: Write like a creative brief; include brand positioning, audience, desired vibe, scene, and exact tagline if text must appear.
- productivity-visual: Name the exact artifact (slide, chart, workflow diagram), define the canvas and hierarchy, provide real labels/data, and ask for readable typography and polished spacing.
- scientific-educational: Define audience, lesson objective, required labels, scientific constraints, arrows, and scan-friendly whitespace.
- illustration-story: Define panels or scene beats; keep each action concrete.
- stylized-concept: Specify style cues, material finish, and rendering approach (3D, painterly, clay) without inventing new story elements.
- historical-scene: State the location/date and required period accuracy; constrain clothing, props, and environment to match the era.

Edit:
- text-localization: Change only the text; preserve layout, typography, spacing, and hierarchy; no extra words or reflow unless needed.
- identity-preserve: Lock identity (face, body, pose, hair, expression); change only the specified elements; match lighting and shadows.
- precise-object-edit: Specify exactly what to remove/replace; preserve surrounding texture and lighting; keep everything else unchanged.
- lighting-weather: Change only environmental conditions (light, shadows, atmosphere, precipitation); keep geometry, framing, and subject identity.
- background-extraction: Request a clean cutout with `background: "transparent"`; preserve fine edges and label text; no halos or restyling.
- style-transfer: Specify style cues to preserve (palette, texture, brushwork) and what must change; add `no extra elements` to prevent drift.
- compositing: Reference inputs by index; specify what moves where; match lighting, perspective, and scale; keep the base framing unchanged.
- sketch-to-render: Preserve layout, proportions, and perspective; choose materials and lighting that support the supplied sketch without adding new elements.

## Where to find copy/paste recipes
For copy/paste prompt specs (examples only), see `references/sample-prompts.md`. This file focuses on principles, specificity, and iteration patterns.
