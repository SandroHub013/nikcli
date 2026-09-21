import { parseDesignLog, serializeDesignEvent, type DesignEvent, type ParsedLog } from "./log"
import { foldProposals, type DesignState } from "./state"
import { t } from "../i18n"

export const DEFAULT_DESIGN_PATH = ".ade/design.jsonl"
export const MAX_REGISTER_BYTES = 8 * 1024 * 1024

export function designPath(projectRoot: string, setting?: string): string {
  const chosen = setting?.trim() || DEFAULT_DESIGN_PATH
  if (isAbsolute(chosen)) return chosen
  const separator = projectRoot.includes("\\") && !projectRoot.includes("/") ? "\\" : "/"
  const root = projectRoot.replace(/[\\/]+$/, "")
  return `${root}${separator}${chosen.replace(/^\.?[\\/]+/, "").replace(/[\\/]/g, separator)}`
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

export interface DesignIo {
  readTextFile: (path: string, maxBytes?: number) => Promise<{ text: string; truncated: boolean }>
  writeTextFile: (path: string, contents: string) => Promise<string | null>
  appendTextFile?: (path: string, text: string) => Promise<string | null>
  exists?: (path: string) => Promise<boolean>
}

export interface LoadedRegister extends ParsedLog {
  readonly text: string
  readonly state: DesignState
}

export async function loadDesign(io: DesignIo, path: string): Promise<LoadedRegister> {
  const text = await readRegister(io, path)
  const parsed = parseDesignLog(text)
  return { ...parsed, text, state: foldProposals(parsed.events) }
}

async function readRegister(io: DesignIo, path: string): Promise<string> {
  if (io.exists && !(await io.exists(path))) return ""
  let read: { text: string; truncated: boolean }
  try {
    read = await io.readTextFile(path, MAX_REGISTER_BYTES)
  } catch (error) {
    if (!io.exists && /not found|no such file|os error 2|impossibile trovare/i.test(String(error))) return ""
    throw error
  }
  if (read.truncated) throw new Error(t("design.log.tooLarge", MAX_REGISTER_BYTES / (1024 * 1024)))
  return read.text
}

export async function appendDesignEvent(
  io: DesignIo,
  path: string,
  event: DesignEvent,
): Promise<DesignState> {
  const line = serializeDesignEvent(event)
  const text = await readRegister(io, path)
  const parsed = parseDesignLog(text)
  const after = foldProposals([...parsed.events, event])
  const refused = after.rejected.find((item) => item.event === event)
  if (refused) throw new Error(refused.reason)

  const joiner = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
  const failure = io.appendTextFile
    ? await io.appendTextFile(path, `${joiner}${line}`)
    : await io.writeTextFile(path, `${text}${joiner}${line}`)
  if (failure) throw new Error(failure)
  return after
}
