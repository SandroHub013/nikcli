/**
 * Files and pictures sent with a message to a bot: the «+» of its composer, a file dragged onto it, a picture pasted
 * (design/ade-bot-2, scelta 5).
 *
 * The Chat's rules (`chat/attachments.ts`), because the danger is the same: a file of the open project only, never a
 * `.env`, checked again with links followed before anything is sent. A file from elsewhere is not read: a picture that
 * is not a file of the project (pasted, or dragged from another folder) is written into the bot's own folder under the
 * project, `.ade/bots/<name>/`, and attached from there. That folder is kept out of the project's git by its own
 * `.git/info/exclude` (`excludeBotFiles`), never by its `.gitignore`, which is the user's.
 *
 * How each program gets them: ragu as file parts of the prompt (`serve-turn.ts`), which it reads itself as the user;
 * Claude Code and Codex by their path in the project, under the user's words, to open with their own tools.
 */

import type { FilePartInput } from "@ragu/sdk/httpapi"
import { t } from "../i18n"
import {
  addAttachment,
  attachmentFor,
  attachmentParts,
  insideProject,
  isEnvFile,
  type Attachment,
} from "../chat/attachments"
import type { AttachmentCheck } from "../chat/store"

export type { Attachment }

/** How many files one message may carry. */
export const BOT_ATTACH_MAX = 10
/** The largest picture kept in the bot's folder, in megabytes. */
export const BOT_PICTURE_MAX_MB = 10

/** A file picked or dragged, added to `list`; when it cannot be, the list as it was and why. */
export function attachPath(
  root: string | undefined,
  list: readonly Attachment[],
  path: string,
): { readonly list: Attachment[]; readonly problem?: string } {
  if (!root) return { list: [...list], problem: t("bots.attach.noProject") }
  if (isEnvFile(path)) return { list: [...list], problem: t("bots.attach.env", path) }
  const file = attachmentFor(root, path)
  if (!file) return { list: [...list], problem: t("bots.attach.outside", path) }
  const next = addAttachment(list, file)
  if (next.length > BOT_ATTACH_MAX) return { list: [...list], problem: t("bots.attach.tooMany", BOT_ATTACH_MAX) }
  return { list: next }
}

/** The bot's own folder under the project, for the pictures given to it: one folder, whatever its name holds. */
export function botFilesDir(root: string, identifier: string): string {
  const last =
    identifier
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? ""
  const name = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "bot"
  return `${root.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/.ade/bots/${name}`
}

const PICTURES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** The extension a picture of this kind is kept with; none for anything else, an SVG included (it can hold a script). */
export function pastedExtension(mime: string): string | undefined {
  return PICTURES[mime.toLowerCase()]
}

const two = (value: number) => String(value).padStart(2, "0")

/** `img-20261016-140509-2.png`: when it came, and which of the ones that came together. */
export function pastedFileName(at: number, index: number, extension: string): string {
  const date = new Date(at)
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  return `img-${day}-${time}-${index}.${extension}`
}

/** A picture with no file in the project, written into the bot's folder and attached from there. */
export async function savePasted(input: {
  readonly root: string
  readonly identifier: string
  readonly file: Blob
  readonly at: number
  readonly index: number
  /** The host's `writeBytes`: the failure, or null. */
  readonly write: (path: string, bytes: Uint8Array) => Promise<string | null>
}): Promise<{ readonly file: Attachment; readonly problem?: undefined } | { readonly problem: string }> {
  const extension = pastedExtension(input.file.type)
  if (!extension) return { problem: t("bots.attach.notPicture") }
  if (input.file.size > BOT_PICTURE_MAX_MB * 1024 * 1024)
    return { problem: t("bots.attach.tooBig", BOT_PICTURE_MAX_MB) }
  const path = `${botFilesDir(input.root, input.identifier)}/${pastedFileName(input.at, input.index, extension)}`
  const failure = await input.write(path, new Uint8Array(await input.file.arrayBuffer()))
  if (failure) return { problem: t("bots.attach.notSaved", failure) }
  const file = attachmentFor(input.root, path)
  return file ? { file } : { problem: t("bots.attach.outside", path) }
}

/** The message for Claude Code and Codex: the files by their path in the project, under the user's words. */
export function withFilePaths(message: string, files: readonly Attachment[]): string {
  if (files.length === 0) return message
  return `${message}\n\n${t("bots.attach.forModel")}\n${files.map((file) => `- ${file.relative}`).join("\n")}`
}

/** What the thread shows under the user's words: the names of the files that went. */
export function attachedLine(files: readonly Attachment[]): string {
  return t("bots.attach.line", files.map((file) => file.relative.split("/").at(-1) ?? file.relative).join(", "))
}

/**
 * ragu's file parts, each file checked again just before it goes: ragu reads a `file://` part as the user, with no
 * question asked, so a file that is no longer the project's (moved, or a link out of it) stops the whole message.
 */
export async function checkedFileParts(
  root: string,
  files: readonly Attachment[],
  /** Rust's check with links and junctions followed: the Chat's `tauriAttachmentCheck` in the app. */
  check: (root: string, path: string) => Promise<AttachmentCheck>,
): Promise<{ readonly parts: FilePartInput[] } | { readonly problem: string }> {
  for (const file of files) {
    if (!insideProject(root, file.path)) return { problem: t("bots.attach.outside", file.path) }
    if (isEnvFile(file.path)) return { problem: t("bots.attach.env", file.path) }
    const verdict = await check(root, file.path)
    if (verdict === "notFile") return { problem: t("bots.attach.notFile", file.path) }
    if (verdict === "env") return { problem: t("bots.attach.env", file.path) }
    if (verdict !== "ok") return { problem: t("bots.attach.outside", file.path) }
  }
  return { parts: attachmentParts(files) }
}

/** The line a project's `.git/info/exclude` gets for the bots' pictures; undefined when a line there already covers it. */
export function excludeWithBotFiles(current: string): string | undefined {
  const covered = new Set([".ade/bots/", ".ade/bots", "/.ade/bots/", "/.ade/bots", ".ade/", ".ade", "/.ade/", "/.ade"])
  if (current.split(/\r?\n/).some((line) => covered.has(line.trim()))) return undefined
  const base = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`
  return `${base}# ADE: immagini date ai bot\n.ade/bots/\n`
}

/**
 * `.ade/bots/` in the project's own `.git/info/exclude`, when the project is a git repository and no line covers it
 * yet (bot-ui-3, 2): the pictures stay on disk and out of `git status`, and nothing goes in a commit. The folder is
 * git's common one, so a worktree's line is its repository's. Never throws: a picture in `git status` is a nuisance,
 * not a reason to refuse it.
 */
export async function excludeBotFiles(
  root: string,
  /** What of the host it asks: git, and one text file read and written (`Host` in the app). */
  host: {
    readonly run: (command: string, args: string[], cwd?: string) => Promise<{ code: number | null; stdout: string }>
    readonly readTextFile?: (path: string) => Promise<{ readonly text: string }>
    readonly writeTextFile?: (path: string, contents: string) => Promise<string | null>
  },
): Promise<"added" | "there" | "none"> {
  try {
    if (!host.readTextFile || !host.writeTextFile) return "none"
    const common = await host.run("git", ["rev-parse", "--git-common-dir"], root)
    const dir = common.stdout.trim()
    if (common.code !== 0 || !dir) return "none"
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dir) ? dir : `${root.replace(/[\\/]+$/, "")}/${dir}`
    const file = `${absolute.replace(/[\\/]+$/, "")}/info/exclude`
    const current = await host
      .readTextFile(file)
      .then((read) => read.text)
      .catch(() => "")
    const next = excludeWithBotFiles(current)
    if (next === undefined) return "there"
    return (await host.writeTextFile(file, next)) ? "none" : "added"
  } catch {
    return "none"
  }
}
