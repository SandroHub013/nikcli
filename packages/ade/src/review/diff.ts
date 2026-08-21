export interface FileDiff {
  path: string
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed"
  added: number
  removed: number
  binary: boolean
  hunks: Hunk[]
}

export interface Hunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
  oldNumber?: number
  newNumber?: number
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let currentFile: FileDiff | null = null
  let currentHunk: Hunk | null = null
  let oldLineCounter = 0
  let newLineCounter = 0

  const lines = text.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith("diff --git")) {
      currentFile = {
        path: "",
        status: "modified",
        added: 0,
        removed: 0,
        binary: false,
        hunks: [],
      }
      files.push(currentFile)
      currentHunk = null

      const parts = line.split(" ")
      const aPath = parts[2]
      const bPath = parts[3]

      currentFile.path = bPath ? bPath.replace(/^b\//, "") : ""
      if (!currentFile.path && aPath) {
        currentFile.path = aPath.replace(/^a\//, "")
      }

      // Check extended headers for rename and status
      let j = i + 1
      while (j < lines.length && !lines[j].startsWith("--- ") && !lines[j].startsWith("diff --git") && !lines[j].startsWith("Binary files")) {
        const extLine = lines[j]
        if (extLine.startsWith("new file mode")) {
          currentFile.status = "added"
        } else if (extLine.startsWith("deleted file mode")) {
          currentFile.status = "deleted"
        } else if (extLine.startsWith("rename from ")) {
          currentFile.status = "renamed"
          currentFile.oldPath = extLine.slice(12).replace(/^"?([^"]+)"?$/, "$1") // very basic unquote if any
        } else if (extLine.startsWith("rename to ")) {
          currentFile.path = extLine.slice(10).replace(/^"?([^"]+)"?$/, "$1")
        }
        j++
      }
      // Leave i at the end of the extended headers so the next iteration will process '---' or 'Binary files'
      i = j - 1
    } else if (line.startsWith("--- ") && currentFile) {
      if (line === "--- /dev/null") {
        currentFile.status = "added"
      }
    } else if (line.startsWith("+++ ") && currentFile) {
      if (line === "+++ /dev/null") {
        currentFile.status = "deleted"
      }
    } else if (line.startsWith("Binary files") && currentFile) {
      currentFile.binary = true
    } else if (line.startsWith("@@ ") && currentFile) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLineCounter = parseInt(match[1], 10)
        newLineCounter = parseInt(match[2], 10)
        currentHunk = {
          header: line,
          oldStart: oldLineCounter,
          newStart: newLineCounter,
          lines: [],
        }
        currentFile.hunks.push(currentHunk)
      }
    } else if (currentHunk) {
      if (line.startsWith("\\ No newline at end of file")) {
        // Just ignore
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({
          kind: "add",
          text: line.slice(1),
          newNumber: newLineCounter++,
        })
        currentFile!.added++
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          kind: "remove",
          text: line.slice(1),
          oldNumber: oldLineCounter++,
        })
        currentFile!.removed++
      } else if (line.startsWith(" ") || line === "") {
        const text = line.length > 0 ? line.slice(1) : line
        currentHunk.lines.push({
          kind: "context",
          text: text,
          oldNumber: oldLineCounter++,
          newNumber: newLineCounter++,
        })
      } else {
        // Unknown, probably end of hunk or empty line at end of file
        currentHunk = null
      }
    }

    i++
  }

  return files
}
