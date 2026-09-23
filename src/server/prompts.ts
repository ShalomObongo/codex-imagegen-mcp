import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const CHECKLIST = [
  "Follow the imagegen skill if it is available (otherwise read the imagegen://skill/SKILL.md resource).",
  "Classify the request (use case + asset type) and write a structured prompt: Use case, Asset type, Primary request, Scene/backdrop, Subject, Style/medium, Composition/framing, Lighting/mood, Color palette, Text (verbatim), Constraints, Avoid.",
  "Keep the user's details; only add detail that materially improves the result.",
  "Pick aspect_ratio from the intended use; use background=\"transparent\" when the asset needs alpha.",
  "Inspect the returned preview; iterate with one targeted change if something is off.",
  "Save project assets inside the workspace (output_path) without overwriting existing files, and report the final path(s).",
];

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "generate",
    {
      title: "Generate an image",
      description: "Create a new image with the imagegen tools using the recommended workflow.",
      argsSchema: { description: z.string().describe("What to create, including where it will be used.") },
    },
    ({ description }): GetPromptResult => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Generate an image with the imagegen MCP tools (generate_image).\n\nRequest: ${description}\n\nHow:\n${CHECKLIST.map((c) => `- ${c}`).join("\n")}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "edit",
    {
      title: "Edit an image",
      description: "Edit an existing image with the imagegen tools, preserving everything that should not change.",
      argsSchema: {
        image: z.string().describe("Path (or URL) of the image to edit."),
        change: z.string().describe("What should change."),
      },
    },
    ({ image, change }): GetPromptResult => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Edit this image with the imagegen MCP tools (edit_image): ${image}\n\nChange: ${change}\n\nHow:\n- In the prompt, refer to it as Image 1 and state both the change and the invariants ("change only X; keep Y unchanged").\n${CHECKLIST.slice(3).map((c) => `- ${c}`).join("\n")}`,
          },
        },
      ],
    }),
  );
}
