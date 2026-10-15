/**
 * The row for a call that landed on the `invalid` tool: the model asked for a tool it was not given, or gave a
 * known one arguments that do not fit. The tool's own name and error are what the row says, not the raw
 * `invalid [tool=list, error=…]` the generic view printed.
 */
export function invalidToolRow(input: unknown): string {
  const shape = (input && typeof input === "object" ? input : {}) as { tool?: unknown; error?: unknown }
  const name = typeof shape.tool === "string" && shape.tool.trim() ? shape.tool.trim() : "a tool"
  const error = typeof shape.error === "string" ? shape.error.trim() : ""
  // The repair hook words an absent tool as «Model tried to call unavailable tool 'x'.»
  if (!error || /unavailable tool/i.test(error)) return `${name} is not available to this model`
  const first = error.split("\n")[0]!.trim()
  return `${name} was called with invalid arguments: ${first.length > 120 ? first.slice(0, 119) + "…" : first}`
}
