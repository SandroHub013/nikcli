/**
 * The one list of what is waiting for the user's yes or no (the user's choice 4): the questions of the bots' panel
 * (`controller.ts`) and the ones asked in a chat (`gateway/approval.ts`), together, so that a request can be seen and
 * decided from ADE wherever it came from. Each source opens an entry while its question is on and closes it when the
 * question is answered, expires or its turn ends; the entry carries the way to answer it.
 *
 * Pure: the reactive wrapper is `approvals-app.ts`.
 */

/** Where a request was asked: `ade` for ADE's own panel, or the platform of the chat (`telegram`, `discord`, `slack`). */
export type ApprovalSource = string

export type ApprovalChoice = "once" | "always" | "reject"

export interface ApprovalRequest {
  /** Unique among the open ones: one question of one source. */
  readonly key: string
  /** The bot's file path, as everywhere else. */
  readonly bot: string
  readonly botName: string
  readonly source: ApprovalSource
  /** ragu's name for what it wants to do (`bash`, `edit`, `external_directory`). */
  readonly permission: string
  /** What it wants to do it on: the command, whole, or the folder. */
  readonly patterns: string
  /** The folder the turn runs in: the same command in another folder is another request. Absent when it is not known. */
  readonly cwd?: string
  /** Why ADE asks, in words (`approval.ts`). */
  readonly reason?: string
  /** The room the question was asked in, when a room's member asked it: the place where it is seen. */
  readonly room?: string
  readonly askedAt: number
  /** When the question becomes a no. */
  readonly expiresAt: number
  /** The answers this source takes: the phone's are `once` and `reject`, never a standing «Sempre». */
  readonly choices: readonly ApprovalChoice[]
  /** Gives the answer where the question is; the source closes its entry itself afterwards. */
  readonly answer: (choice: ApprovalChoice) => void
}

/**
 * What the user sees: the requests of one bot that ask for the same thing at the same time are one. Answering it
 * answers every member, so the phone gets its answer as if it had been given there.
 */
export interface WaitingApproval {
  /** The signature of the request: the same while it is open, whichever source asked first. */
  readonly id: string
  readonly bot: string
  readonly botName: string
  readonly permission: string
  readonly patterns: string
  readonly cwd?: string
  readonly reason?: string
  readonly sources: readonly ApprovalSource[]
  /** The room it was asked in, if one of its members was asked there. */
  readonly room?: string
  /** The earliest ask, and the earliest expiry: the one that runs out first decides how long it can wait. */
  readonly askedAt: number
  readonly expiresAt: number
  /** What every member takes: «Sempre» only when each of them does. */
  readonly choices: readonly ApprovalChoice[]
  readonly members: readonly ApprovalRequest[]
}

/** A folder as a name to compare: one kind of slash, none at the end, the case of Windows. Empty when it is not known. */
const folderName = (cwd: string | undefined) => (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/**
 * What makes two requests one: the same bot asking for the same thing in the same folder. The folder matters: the
 * gateway runs in the project fixed when it was switched on and the panel in the one open in ADE, so `rm -rf dist` from
 * the phone and from the panel can be two different folders, and a single «Consenti» must not run both. A request whose
 * folder is not known merges only with others of unknown folder. Stable while the request is open.
 */
export const approvalSignature = (request: Pick<ApprovalRequest, "bot" | "permission" | "patterns" | "cwd">) =>
  [request.bot, request.permission, request.patterns.trim(), folderName(request.cwd)].join("\n")

const sameThing = (a: ApprovalRequest, b: ApprovalRequest) => approvalSignature(a) === approvalSignature(b)

/** The open requests as the user sees them: merged, the oldest first. */
export function mergeApprovals(requests: readonly ApprovalRequest[]): WaitingApproval[] {
  const groups: ApprovalRequest[][] = []
  for (const request of [...requests].sort((a, b) => a.askedAt - b.askedAt)) {
    const group = groups.find((members) => sameThing(members[0]!, request))
    if (group) group.push(request)
    else groups.push([request])
  }
  return groups.map((members) => {
    const first = members[0]!
    const choices = (["once", "always", "reject"] as const).filter((choice) =>
      members.every((member) => member.choices.includes(choice)),
    )
    const reason = members.find((member) => member.reason !== undefined)?.reason
    const room = members.find((member) => member.room !== undefined)?.room
    return {
      id: approvalSignature(first),
      bot: first.bot,
      botName: first.botName,
      permission: first.permission,
      patterns: first.patterns,
      ...(first.cwd !== undefined ? { cwd: first.cwd } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(room !== undefined ? { room } : {}),
      sources: [...new Set(members.map((member) => member.source))],
      askedAt: first.askedAt,
      expiresAt: Math.min(...members.map((member) => member.expiresAt)),
      choices,
      members,
    }
  })
}

/**
 * The room a thread belongs to, when it is a room member's place there (`roomThread` in `room-app.ts`:
 * `room:<id>:<bot path>`); undefined for the bot's own thread.
 */
export function roomOfThread(thread: string, bot: string): string | undefined {
  const prefix = "room:"
  const suffix = `:${bot}`
  if (!thread.startsWith(prefix) || !thread.endsWith(suffix) || thread.length <= prefix.length + suffix.length) return undefined
  return thread.slice(prefix.length, thread.length - suffix.length)
}

/** How long is left before the request becomes a no; never below zero. */
export function remainingMs(waiting: Pick<WaitingApproval, "expiresAt">, now: number): number {
  return Math.max(0, waiting.expiresAt - now)
}

/** Whole minutes and seconds left, as «4:05». */
export function remainingClock(waiting: Pick<WaitingApproval, "expiresAt">, now: number): string {
  const total = Math.ceil(remainingMs(waiting, now) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** Answers every member of the request. A choice the members do not all take is not given. */
export function decideApproval(waiting: WaitingApproval, choice: ApprovalChoice): boolean {
  if (!waiting.choices.includes(choice)) return false
  for (const member of waiting.members) member.answer(choice)
  return true
}

export interface GatewayAttentionItem {
  /** Unique id for the attention: e.g. `gateway:${bot}:${platform}` */
  readonly id: string
  readonly bot: string
  readonly botName: string
  readonly platform: string
  readonly reason?: string
  readonly at: number
}

export interface ApprovalRegistry {
  /** Opens an entry; the function returned closes it (once). Opening a key again replaces the entry. */
  open: (request: ApprovalRequest) => () => void
  close: (key: string) => void
  /** The open requests, as asked. */
  list: () => readonly ApprovalRequest[]
  /** Opens a gateway attention item. The function returned closes it. */
  openAttention: (item: GatewayAttentionItem) => () => void
  closeAttention: (id: string) => void
  listAttentions: () => readonly GatewayAttentionItem[]
}

/** The registry, with `changed` called after every change (the app's wrapper makes it reactive). */
export function createApprovalRegistry(changed: () => void = () => {}): ApprovalRegistry {
  const open = new Map<string, ApprovalRequest>()
  const attentions = new Map<string, GatewayAttentionItem>()
  const close = (key: string) => {
    if (open.delete(key)) changed()
  }
  const closeAttention = (id: string) => {
    if (attentions.delete(id)) changed()
  }
  return {
    open: (request) => {
      open.set(request.key, request)
      changed()
      return () => {
        // Only its own entry: a newer one under the same key stays.
        if (open.get(request.key) === request) close(request.key)
      }
    },
    close,
    list: () => [...open.values()],
    openAttention: (item) => {
      attentions.set(item.id, item)
      changed()
      return () => {
        if (attentions.get(item.id) === item) closeAttention(item.id)
      }
    },
    closeAttention,
    listAttentions: () => [...attentions.values()],
  }
}
