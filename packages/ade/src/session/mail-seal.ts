/**
 * Who wrote a mailbox file.
 *
 * The mailbox is a folder every session writes, so a file in it proves nothing
 * by being there: any session could write the answer another one is waiting
 * for, or a message into its inbox. So each file carries an HMAC-SHA256 keyed
 * by a pane's `ADE_PANE_TOKEN`, which ADE and that pane's process tree have and
 * the other panes do not. `ade-msg` signs what it posts, so the token itself is
 * never in the folder, and checks what it reads (both scripts in `mailbox.rs`).
 *
 * A file is `ade-mac1 <64 hex>`, a line feed and the text, and the MAC covers
 * `<kind>\n<id>\n<text>`: a text signed as one thing cannot be passed off as
 * another, or moved to another request.
 *
 * The writes are sealed in `host/shell.ts`, the one way to those files, so no
 * call site can forget. The workbench says whose key each id takes (`useMailKeys`).
 */

const HEADER = "ade-mac1 "
const MAC_CHARS = 64

export type SealKind = "outbox" | "receipt" | "result" | "update" | "state" | "inbox"

const encoder = new TextEncoder()

const hmacKey = (token: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, [use])

const signed = (kind: SealKind, id: string, body: string) => encoder.encode(`${kind}\n${id}\n${body}`)

/** `body` as a file only the holder of `token` will accept, as `kind` for `id`. */
export async function seal(token: string, kind: SealKind, id: string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(token, "sign"), signed(kind, id, body))
  const hex = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${HEADER}${hex}\n${body}`
}

export interface Sealed {
  readonly mac: string
  readonly body: string
}

/** The two parts of a sealed file; `undefined` for one that is not sealed at all. */
export function splitSealed(text: string): Sealed | undefined {
  const line = HEADER.length + MAC_CHARS
  if (!text.startsWith(HEADER) || text[line] !== "\n") return undefined
  const mac = text.slice(HEADER.length, line)
  return /^[0-9a-f]+$/.test(mac) ? { mac, body: text.slice(line + 1) } : undefined
}

/** Whether `sealed` was signed with `token`, as `kind` for `id`. */
export async function sealedBy(
  token: string | undefined,
  kind: SealKind,
  id: string,
  sealed: Sealed,
): Promise<boolean> {
  if (!token) return false
  const mac = Uint8Array.from(sealed.mac.match(/../g) ?? [], (pair) => parseInt(pair, 16))
  return crypto.subtle.verify("HMAC", await hmacKey(token, "verify"), mac, signed(kind, id, sealed.body))
}

/** How long an id is remembered, and the oldest message taken: a copy of a message cannot be posted again. */
export const REPLAY_WINDOW_MS = 60 * 60 * 1000

/**
 * Whether message `id` may be taken now. A signature is good for ever, so a
 * session that read a message before ADE took it could post the same file again
 * and have it carried out twice. Ids start with the time they were made. Asked
 * only of a proven message, or anybody could burn an id they have read.
 */
export function firstTime(seen: Map<string, number>, id: string, now: number): "new" | "seen" | "old" {
  for (const [known, at] of seen) {
    if (now - at <= REPLAY_WINDOW_MS) break
    seen.delete(known)
  }
  if (seen.has(id)) return "seen"
  const made = Number(/^(\d{10,})-/.exec(id)?.[1])
  if (Number.isFinite(made) && now - made > REPLAY_WINDOW_MS) return "old"
  seen.set(id, now)
  return "new"
}

/** Whose token signs what: the waiter on a request or message id, and a pane's inbox. */
export interface MailKeys {
  readonly forRequest: (id: string) => string | undefined
  /** Every token a file of `id` may have been sealed with: the current one, then those of the waiter's earlier processes. */
  readonly everyForRequest: (id: string) => readonly string[]
  readonly forPane: (pane: string) => string | undefined
}

let keys: MailKeys = { forRequest: () => undefined, everyForRequest: () => [], forPane: () => undefined }

export function useMailKeys(next: MailKeys): void {
  keys = next
}

/**
 * The text for a file of request `id`. With no key, because its sender is unproven or gone, it is written as it is:
 * `ade-msg` will refuse it and say so, and there is nobody else to read it.
 */
export async function sealForRequest(kind: SealKind, id: string, text: string): Promise<string> {
  const token = keys.forRequest(id)
  return token ? seal(token, kind, id, text) : text
}

export async function sealForPane(pane: string, name: string, text: string): Promise<string> {
  const token = keys.forPane(pane)
  return token ? seal(token, "inbox", name, text) : text
}

/**
 * The text of an answer ADE took back to type it, or `""` if ADE did not write it: what is typed into a session is
 * taken for the answer, so a file another session dropped there must not get through this way either. Empty and not
 * `null`, which says there was no file: this one was there, so nobody has taken the answer.
 *
 * The waiter's old tokens count: an answer written before it was started again is real, and only now it is read.
 */
export async function openReclaimed(kind: "result" | "update", id: string, text: string): Promise<string> {
  const sealed = splitSealed(text)
  if (sealed) {
    for (const token of keys.everyForRequest(id)) {
      if (await sealedBy(token, kind, id, sealed)) return sealed.body
    }
  }
  console.error(`ADE: posta ${id}: un file non scritto da ADE è stato ignorato`)
  return ""
}

/** SHA-256 of a text, in hex: what ADE keeps of an inbox message to know it again after a restart (SEC2-3). */
export async function bodyHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The text of an inbox file to seal again, `undefined` to leave it: with `retired` tokens, only what one of them sealed.
 * With none (ADE has just started and the tokens of before are gone with it) only the text ADE left, which it knows by its
 * hash (SEC2-3): any session can write the inbox folder, and a file that is not that text is left for the client to refuse.
 * An entry with no hash was saved before it was kept, and is taken as it is, once.
 */
async function bodyToReseal(
  retired: readonly string[],
  entry: { name: string; sha256?: string },
  text: string,
): Promise<string | undefined> {
  const { name } = entry
  const sealed = splitSealed(text)
  if (retired.length === 0) {
    const body = sealed?.body ?? text
    return entry.sha256 === undefined || (await bodyHash(body)) === entry.sha256 ? body : undefined
  }
  if (!sealed) return undefined
  for (const token of retired) {
    if (await sealedBy(token, "inbox", name, sealed)) return sealed.body
  }
  return undefined
}

/**
 * Called when a pane gets a new token, before its process starts: what it has not read yet was sealed for the process
 * before, and the new one would take it for false. `entries` are the messages ADE knows it left there; `write` seals.
 * A file that fails is left as it is and does not stop the others, nor the start.
 *
 * Returns the entries that had no hash and were sealed again (the first restart after the hash was kept), with the hash
 * of the text taken: the caller keeps it, so that restart is the only one that takes a file on its word.
 */
export async function resealUnread(
  entries: readonly { name: string; sha256?: string }[],
  retired: readonly string[],
  io: { read: (name: string) => Promise<string | null>; write: (name: string, body: string) => Promise<void> },
): Promise<{ name: string; sha256: string }[]> {
  const adopted: { name: string; sha256: string }[] = []
  for (const entry of entries) {
    const { name } = entry
    try {
      const text = await io.read(name)
      const body = text === null ? undefined : await bodyToReseal(retired, entry, text)
      if (body !== undefined) {
        await io.write(name, body)
        if (entry.sha256 === undefined && retired.length === 0) adopted.push({ name, sha256: await bodyHash(body) })
      }
    } catch (error) {
      console.error(`ADE: posta ${name}: non ho potuto sigillarla di nuovo`, error)
    }
  }
  return adopted
}
