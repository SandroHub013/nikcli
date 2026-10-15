import type { DiffRow, LineType } from "./comment-box"

/**
 * The rows of a unified patch that the diff view draws, one per added, removed or context line.
 *
 * A row's `visualLine` is its index among those lines, which is how the unified diff view numbers what it draws (the
 * index of `setLineColor`, the row to scroll to). It used to be the line's index in the raw patch, which also counts
 * the file headers and every `@@`: the highlight and the comment landed four or more rows below the line chosen.
 */
export function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  const lines = diff.split("\n")
  let oldLine: number | undefined
  let newLine: number | undefined

  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10)
      newLine = Number.parseInt(hunk[2], 10)
      continue
    }
    if (oldLine === undefined || newLine === undefined) continue
    if (!text || text.startsWith("\\ No newline")) continue

    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push(createRow(rows.length, "add", undefined, newLine, text.slice(1)))
      newLine++
      continue
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push(createRow(rows.length, "remove", oldLine, undefined, text.slice(1)))
      oldLine++
      continue
    }
    if (text.startsWith(" ")) {
      rows.push(createRow(rows.length, "context", oldLine, newLine, text.slice(1)))
      oldLine++
      newLine++
    }
  }

  return rows
}

function createRow(
  visualLine: number,
  lineType: LineType,
  oldLine: number | undefined,
  newLine: number | undefined,
  text: string,
): DiffRow {
  const anchor = lineType === "remove" && oldLine !== undefined ? `old:${oldLine}` : `new:${newLine ?? visualLine + 1}`
  const label =
    lineType === "remove" && oldLine !== undefined ? `old line ${oldLine}` : `new line ${newLine ?? visualLine + 1}`
  return {
    visualLine,
    oldLine,
    newLine,
    lineType,
    anchor,
    label,
    text,
  }
}
