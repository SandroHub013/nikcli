import os from "os"

/**
 * Scratch files have to be told where they go.
 *
 * A model that wants a throwaway file outside the project guesses the temp
 * path, and the guess carries the wrong user: `C:\Users\ADMINI~1\AppData\Local\Temp`
 * is the short form of somebody else's account, so the write fails with EPERM
 * and the turn is spent. Neither temp dir nor working directory is guessable,
 * so both are said rather than inferred. This is not a model-specific problem
 * — it is the prompt's.
 */

/**
 * The `<env>` line. Short on purpose: it is paid at every request in the
 * session, not once.
 */
export function scratchEnvLine(): string {
  return `  Temp dir: ${os.tmpdir()} (scratch files)`
}

/** The same two places, for an error that has already cost a turn. */
export function scratchHint(directory: string): string {
  return `Scratch files go in the temp dir ${os.tmpdir()} or the project dir ${directory}.`
}

/**
 * Codes that mean "this parent directory is not yours, or is not there".
 *
 * `ENOENT` belongs here because a parent can still be unreachable without
 * being creatable — and because the two permission codes are not the only way
 * to lose: Bun's wrapped errors often carry the code in the message alone,
 * which `pathFailureCode` also reads.
 */
const PATH_CODES = new Set(["EPERM", "EACCES", "ENOENT"])

function pathFailureCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && PATH_CODES.has(code)) return code
  // Bun's wrapped errors do not always carry `code`; the message does name it.
  return [...PATH_CODES].find((candidate) => error.message.includes(candidate))
}

/**
 * Re-throw a write failure with the scratch paths attached.
 *
 * A failure that has nothing to do with paths comes back untouched: sending
 * the model to the temp dir because a disk was full would be worse than the
 * error it replaced.
 */
export function withScratchHint(error: unknown, directory: string): Error {
  const original = error instanceof Error ? error : new Error(String(error))
  if (!pathFailureCode(original)) return original
  const annotated = new Error(`${original.message}\n${scratchHint(directory)}`)
  annotated.cause = original
  return annotated
}

/**
 * `File not found` for `filePath`, with the scratch paths appended only when
 * the file was meant to be somewhere the model had to invent.
 *
 * Inside the project a missing file means the edit named the wrong file, and
 * the temp dir is noise; outside it, the path is the thing to correct.
 */
export function notFoundMessage(filePath: string, directory: string, outsideProject: boolean): string {
  const found = `File not found: ${filePath}`
  return outsideProject ? `${found}\n${scratchHint(directory)}` : found
}
