/** The notice's lines: what happened, where the details are, and the ways out. Each is dropped when not known. */
export function transcriptFailedLines(input: { message: string; logFile?: string; exits?: string }): string[] {
  return [input.message, input.logFile ? `Log: ${input.logFile}` : undefined, input.exits].filter(
    (line): line is string => Boolean(line),
  )
}
