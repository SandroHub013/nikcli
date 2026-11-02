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
 * and have it carried out twice. Ids start with the time they were made.
 */
export function firstTime(seen: Map<string, number>, id: string, now: number): boolean {
  for (const [known, at] of seen) {
    if (now - at <= REPLAY_WINDOW_MS) break
    seen.delete(known)
  }
  if (seen.has(id)) return false
  const made = Number(/^(\d{10,})-/.exec(id)?.[1])
  if (Number.isFinite(made) && now - made > REPLAY_WINDOW_MS) return false
  seen.set(id, now)
  return true
}

/** Whose token signs what: the waiter on a request or message id, and a pane's inbox. */
export interface MailKeys {
  readonly forRequest: (id: string) => string | undefined
  readonly forPane: (pane: string) => string | undefined
}

let keys: MailKeys = { forRequest: () => undefined, forPane: () => undefined }

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
 * The text of an answer ADE took back to type it, or `null` if ADE did not write it: what is typed into a session is
 * taken for the answer, so a file another session dropped there must not get through this way either.
 */
export async function openReclaimed(kind: "result" | "update", id: string, text: string): Promise<string | null> {
  const sealed = splitSealed(text)
  const token = keys.forRequest(id)
  // Its waiter is gone: nothing will be typed, and there is no key to ask.
  if (!token) return sealed?.body ?? text
  if (sealed && (await sealedBy(token, kind, id, sealed))) return sealed.body
  console.error(`ADE: posta ${id}: un file non scritto da ADE è stato scartato`)
  return null
}
