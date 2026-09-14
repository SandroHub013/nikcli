/**
 * A session as a Markdown document.
 *
 * The transcript already lets you copy one answer. What it never let you do is
 * take the conversation somewhere else — into an issue, a review, a note. Zed
 * calls this "Open Thread as Markdown" and it is the only way the work leaves
 * the app in a form anyone else can read.
 *
 * Tool calls are named, not transcribed. Their output is often thousands of
 * lines and belongs to the run, not to the record of what was decided.
 */

export type TranscriptMessage = {
  role: "user" | "assistant" | string
  parts: ReadonlyArray<{ type?: string; text?: string; tool?: string; state?: { status?: string } }>
}


function textOf(message: TranscriptMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n")
}

function toolsOf(message: TranscriptMessage): string[] {
  const names = message.parts
    .filter((part) => part.type === "tool" && part.tool && part.state?.status === "completed")
    .map((part) => part.tool!)
  // Consecutive repeats collapse: "read ×4" says as much as four lines of "read".
  const out: string[] = []
  for (const name of names) {
    const last = out[out.length - 1]
    // Exact match or an existing run of the same name. `startsWith` alone folded
    // any tool whose name is a prefix of the previous one into it: `search_files`
    // followed by `search` rendered as `search ×2`, erasing the first and
    // inventing the count. No built-in pair collides, but MCP servers routinely
    // expose `x` beside `x_y`.
    if (last === name || (last !== undefined && last.startsWith(`${name} ×`))) {
      const count = last === name ? 1 : Number(last.slice(name.length + 2)) || 1
      out[out.length - 1] = `${name} ×${count + 1}`
      continue
    }
    out.push(name)
  }
  return out
}

export function transcriptToMarkdown(input: {
  title?: string
  messages: readonly TranscriptMessage[]
}): string {
  const lines: string[] = []
  if (input.title) lines.push(`# ${input.title}`, "")

  for (const message of input.messages) {
    const text = textOf(message)
    const tools = message.role === "assistant" ? toolsOf(message) : []
    if (!text && tools.length === 0) continue

    if (message.role === "user") {
      // Quoted so a long prompt stays visually separate from the answer, and so
      // markdown inside it cannot restructure the document it lands in.
      lines.push(...text.split("\n").map((line) => (line ? `> ${line}` : ">")), "")
      continue
    }

    if (tools.length > 0) lines.push(`*${tools.join(", ")}*`, "")
    if (text) lines.push(text, "")
  }

  // A trailing blank line is noise when pasted; a single newline is not.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}
