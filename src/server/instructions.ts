/**
 * Sent in the MCP `initialize` result. opencode injects it into the system prompt (inside
 * <mcp_instructions>), so it is kept short; detailed guidance lives in the imagegen-mcp skill.
 */
export const SERVER_INSTRUCTIONS = `Image generation and editing through the user's ChatGPT plan — the same image service OpenAI Codex's built-in image tool uses (no API key).

Tools:
- generate_image: new image from a prompt. edit_image: modify images or use them as references (1-5 inputs; refer to them as Image 1, Image 2…).
- remove_background: local chroma-key cutout of a flat backdrop (no quota).
- auth_status: sign-in + quota. sign_in: start a ChatGPT sign-in and relay the link/code to the user.

Rules of thumb:
- Write structured prompts (use case, subject, style, composition, lighting, palette, exact text in quotes, constraints, avoid). For edits, state what changes and what must stay the same.
- The service picks pixel size and quality; set aspect_ratio (or describe the orientation) instead. Use background="transparent" for assets that need real alpha.
- One call per distinct asset; n (1-4) is only for variants of one prompt. Each image counts against the user's ChatGPT usage limits.
- Files are saved to disk and the path is returned. For project assets pass output_path inside the workspace; existing files are never overwritten unless overwrite=true.
- Check the attached preview before finishing, and report saved paths.
- If a tool says the user is not signed in, call sign_in (or ask the user to run the login command it names). On a usage-limit error, stop and tell the user when it resets.
- For detailed prompting guidance, load the "imagegen-mcp" skill if available, or read the imagegen://skill/SKILL.md resource.`;
