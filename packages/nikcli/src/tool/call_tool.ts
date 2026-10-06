import { Schema } from "effect"
import { zod } from "@nikcli-ai/util/effect-zod"
import { Tool } from "./tool"

/**
 * The parameters are a free-form object on purpose: this tool forwards to another
 * tool's own schema, and a schema here would have to be a union of every tool's
 * parameters — that is the surface the deferral split exists to keep out of every
 * request. The forwarded tool validates its own arguments, and a mismatch comes
 * back as this tool's error with the target's complaint attached.
 */
const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "The tool to run, exactly as search_tools named it.",
  }),
  args: Schema.Any.annotate({
    description: "The tool's own parameters, as the JSON schema from search_tools described them.",
  }),
})

export const CallToolTool = Tool.define("call_tool", {
  description: [
    "Run a tool that is not in your tool list.",
    "",
    "Your tool list holds a core set; the rest are registered but deferred, so they cost nothing until asked for.",
    "Call search_tools with a tool name or capability keyword to get a deferred tool's parameters — it returns the exact",
    'call_tool invocation to run. Then run it here: call_tool({"name": "<tool>", "args": {...}}).',
    "",
    "Runs through the same permission checks, plugin hooks and timeout as a direct call, so a tool that is denied or",
    "disabled fails the same way it would if it were in your list.",
  ].join("\n"),
  parameters: zod(Parameters),
  /**
   * The registry installs the executor: it is the only place that knows the
   * resolved tool instances and the pipeline they run in. Without it — a direct
   * `call_tool` outside a session — the tool reports that rather than pretending
   * to have run something.
   */
  async execute(params, ctx) {
    const executor = executorFor(ctx)
    if (!executor) {
      return {
        title: "call_tool unavailable",
        output: `call_tool has no tool registry in this context, so "${params.name}" cannot be run.`,
        metadata: { tool: params.name, ok: false },
      }
    }
    return executor(params.name, (params.args ?? {}) as Record<string, unknown>, ctx)
  },
})

export type CallToolExecutor = (name: string, args: Record<string, unknown>, ctx: Tool.Context) => Promise<Tool.Result>

/**
 * Where the session toolset installs the executor.
 *
 * `call_tool` is defined in this module and executed from `session/tools.ts`, which
 * is what owns the resolved tool instances. A module-level holder rather than a
 * parameter keeps the tool definition free of a session import — the same reason
 * `code_mode` reaches tools by name instead of importing them.
 */
let executor: CallToolExecutor | undefined

export function setCallToolExecutor(value: CallToolExecutor | undefined) {
  executor = value
}

function executorFor(_ctx: Tool.Context): CallToolExecutor | undefined {
  return executor
}
