import { Schema } from "effect"
import { zod } from "@nikcli-ai/util/effect-zod"
import { Tool } from "./tool"

const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: zod(Parameters),
  async execute(params) {
    // A call to a deferred tool arrives here: the repair hook in `session/llm`
    // routes an unknown tool name to this shim, and a deferred tool has no
    // schema for the model to have matched. Saying so — and naming the one call
    // that fixes it — turns a dead end into one extra round-trip. Imported
    // lazily because `registry` imports this module.
    const { ToolRegistry } = await import("./registry")
    if (ToolRegistry.deferred(params.tool)) {
      return {
        title: "Tool not deferred",
        output: [
          `The ${params.tool} tool is registered but not in your tool schema.`,
          `Call search_tools with query "${params.tool}" to get its parameters, then call it with call_tool: {"name": "${params.tool}", "args": {...}}.`,
        ].join(" "),
        metadata: { deferred: true, tool: params.tool },
      }
    }
    return {
      title: "Invalid Tool",
      output: `The arguments provided to the tool are invalid: ${params.error}`,
      metadata: { deferred: false, tool: params.tool },
    }
  },
})
