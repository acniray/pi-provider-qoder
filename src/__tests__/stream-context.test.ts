import type { Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveSystemText, resolveTools } from "../protocol/stream.js";

describe("TranscriptContext compatibility", () => {
  const readTool: Tool = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
  };
  const bashTool: Tool = {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: {} },
  };
  const editTool: Tool = {
    name: "edit",
    description: "Edit a file",
    parameters: { type: "object", properties: {} },
  };

  it("keeps legacy Context systemPrompt and tools", () => {
    const context = {
      systemPrompt: "legacy prompt",
      messages: [],
      tools: [readTool],
    } as unknown as Context;

    expect(resolveSystemText(context)).toBe("legacy prompt");
    expect(resolveTools(context)?.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("reconstructs prompt sections and tool state from TranscriptContext", () => {
    const context = {
      messages: [
        {
          role: "system",
          content: "base prompt",
          sections: { rules: "rule v1" },
          toolsAdded: [readTool, bashTool],
        },
        {
          role: "system",
          content: "",
          sections: { rules: "rule v2", docs: "docs" },
          toolsRemoved: [{ name: "read" }],
          toolsAdded: [editTool],
        },
        { role: "user", content: "hello" },
      ],
    } as unknown as Context;

    expect(resolveSystemText(context)).toBe("base prompt\n\nrule v2\n\ndocs");
    expect(resolveTools(context)?.map((tool) => tool.name)).toEqual(["bash", "edit"]);
  });
});
