/**
 * A nikcli bot's turn on ADE's nikcli server (B8d).
 *
 * `nikcli run` in a terminal, one process per turn, becomes a prompt to a
 * session of the server the Chat uses (`chat/connection.ts`), with the bot as
 * its agent. What the process printed as JSON lines arrives here as the
 * server's events, and a question arrives as `permission.asked` with its own
 * id: it is answered by that id, so nothing the model writes can pass for
 * one, and no menu is read off the screen.
 *
 * The session is made with the rules of the turn's profile (`serve-rules.ts`),
 * which come after the bot's own file and win over it. A session whose rules
 * are not the profile's — one of `nikcli run`, or of another profile — is not
 * continued: a new one starts, and the thread says so once. The prompt never
 * carries `tools`, which would replace the session's rules.
 *
 * The project is admitted before anything is sent (`admitProject`), as for
 * the Chat: with its dialog when someone is in front of the screen, refused
 * otherwise. A project agent with the bot's name would take its place on the
 * server, with its own prompt and rules: the turn is refused instead.
 *
 * Stop, the time limit and the spend cap abort the session's turn on the
 * server; nothing of it keeps running.
 */

import type { Agent, NikcliClient } from "@nikcli-ai/sdk/client"
import { t } from "../i18n"
import { appChatConnectionDeps, openChat, type ChatConnectionDeps } from "../chat/connection"
import type { ChatEvent } from "../chat/events"
import { readEvents } from "../chat/stream"
import { admitProject, PROJECT_TRUST_KEY, projectSurface, type AdmitProjectDeps } from "./project-trust"
import { projectFs } from "./store"
import { localTrustStore } from "./trust"
import { agentDirs, type AgentFile } from "./nikcli"
import { joinPath } from "../host/path"
import { finalText, spendKind } from "./runners"
import { botPermission, hasBotRules, profileFor } from "./serve-rules"
import {
  appendMessage,
  emptyTalk,
  errorText,
  noteReportedModel,
  noteTurnUsage,
  sendMessage,
  sumTokens,
  upsertMessage,
  type PendingPermission,
  type Talk,
} from "./talk"
import { acquireTurn } from "./terms"
import { runTurn, timeoutProblem, TURN_TIMEOUT_MS, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "./turn"
import type { PermissionRule } from "../chat/rules"

/** What a turn asks of the server: the SDK's calls it makes, and nothing else. */
export interface ServeClient {
  readonly agents: () => Promise<readonly Pick<Agent, "name" | "prompt">[]>
  /** The session, or undefined when the server has none by that id. */
  readonly session: (sessionID: string) => Promise<{ readonly permission?: unknown } | undefined>
  readonly create: (input: { readonly title: string; readonly permission: readonly PermissionRule[] }) => Promise<string>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly modelID: string }
    readonly variant?: string
  }) => Promise<void>
  readonly abort: (sessionID: string) => Promise<void>
  readonly reply: (requestID: string, reply: "once" | "reject") => Promise<void>
  readonly rejectQuestion: (requestID: string) => Promise<void>
}

export type ServeConnection =
  | { readonly ok: true; readonly client: ServeClient; readonly events: (signal: AbortSignal) => AsyncIterable<ChatEvent> }
  | { readonly ok: false; readonly problem?: string }

export interface ServeTurnDeps {
  /** The server for `directory`, once its project is admitted: asked about when `interactive`, refused otherwise. */
  readonly connect: (directory: string, interactive: boolean) => Promise<ServeConnection>
  /** Whether the project at `directory` has an agent file named `identifier` (`.nikcli/agent/<name>.md`). */
  readonly projectHasAgent?: (directory: string, identifier: string) => Promise<boolean>
  readonly now?: () => number
}

/** `provider/model` as the server wants it; the model's own id may hold more slashes. */
export function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const at = model?.indexOf("/") ?? -1
  if (!model || at <= 0 || at === model.length - 1) return undefined
  return { providerID: model.slice(0, at), modelID: model.slice(at + 1) }
}

const samePrompt = (a: string | undefined, b: string) => (a ?? "").replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim()

/**
 * Why the server's agent by the bot's name is not the bot, if it is not: the
 * server knows no such agent, or one of the project's (or nikcli's own) has
 * the name with another prompt, and would answer in the bot's place.
 */
export function agentProblem(agents: readonly Pick<Agent, "name" | "prompt">[], bot: AgentFile): string | undefined {
  const found = agents.find((agent) => agent.name === bot.identifier)
  if (!found) return t("bots.serve.noAgent", bot.identifier)
  if (!samePrompt(found.prompt, bot.prompt)) return t("bots.serve.agentTaken", bot.identifier)
  return undefined
}

interface ServePart {
  readonly id: string
  readonly messageID: string
  readonly sessionID: string
  readonly type: string
  readonly text?: string
  readonly tool?: string
  readonly state?: { readonly status?: string; readonly title?: string; readonly input?: unknown; readonly output?: unknown; readonly error?: unknown }
}

/** A part on the thread: a text as the bot's words, a tool as what it did. Nothing for the rest. */
function partChange(part: ServePart, at: number): ((talk: Talk) => Talk) | undefined {
  const id = `srv-${part.id}`
  if (part.type === "text") {
    const text = part.text ?? ""
    if (text.trim().length === 0) return undefined
    return (talk) => upsertMessage(talk, { id, role: "bot", text }, at)
  }
  if (part.type === "tool") {
    const state = part.state
    if (!state || state.status === "pending") return undefined
    const tool = part.tool ?? "tool"
    const input = state.input
    const title =
      state.title || (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : tool)
    const said = state.status === "completed" ? state.output : state.status === "error" ? state.error : undefined
    const output = typeof said === "string" && said.trim().length > 0 ? said : undefined
    return (talk) => upsertMessage(talk, { id, role: "tool", tool, text: title, ...(output ? { output } : {}) }, at)
  }
  return undefined
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The session an event is about, wherever the event keeps it. */
function sessionOf(event: ChatEvent): string | undefined {
  const props = record(event.properties)
  const id = props["sessionID"] ?? record(props["info"])["sessionID"] ?? record(props["part"])["sessionID"]
  return typeof id === "string" ? id : undefined
}

type End = { readonly kind: "done" | "stopped" | "timeout" | "budget" } | { readonly kind: "lost"; readonly why: string }

export function runServeTurn(request: TurnRequest, deps: ServeTurnDeps): Turn {
  const now = deps.now ?? Date.now
  let stopped = false
  /* How the turn ended, the first time anything ended it. */
  let over: End | undefined
  let resolveEnd: (how: End) => void = () => {}
  const ended = new Promise<End>((resolve) => (resolveEnd = resolve))
  const end = (how: End) => {
    if (over) return
    over = how
    resolveEnd(how)
  }
  let answer: ((requestID: string, reply: "once" | "reject") => void) | undefined

  const result = (async (): Promise<TurnResult> => {
    let talk = sendMessage(emptyTalk(), request.message, now())
    const bot: AgentFile = request.bot ?? {
      identifier: request.agent ?? "",
      path: "",
      scope: "global",
      description: "",
      mode: "primary",
      prompt: request.instructions ?? "",
      disabledTools: request.disabledTools ?? [],
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      runner: "nikcli",
    }
    talk = { ...talk, turnMode: spendKind("nikcli", bot.model, request.account) }
    /* A change to the turn: to its own thread, and to the caller's. */
    const change = (next: (talk: Talk) => Talk) => {
      talk = next(talk)
      request.onChange?.(next)
      request.onUpdate?.(talk)
    }
    let sessionId: string | undefined
    const finish = (status: TurnResult["status"], problem?: string, exitCode?: number): TurnResult => ({
      status,
      text: finalText(talk),
      ...(sessionId ? { sessionId } : {}),
      tokens: talk.tokens,
      costUsd: talk.costUsd,
      ...(problem ? { problem } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      talk,
    })

    // The server answers for a folder: a turn without one has nowhere to run.
    const cwd = request.cwd
    if (!cwd) return finish("error", t("bots.serve.noFolder"))
    const slot = acquireTurn("nikcli", "nikcli")
    if ("problem" in slot) return finish("error", slot.problem)
    const timeoutMs = request.timeoutMs ?? TURN_TIMEOUT_MS
    const timer = setTimeout(() => end({ kind: "timeout" }), timeoutMs)
    const stream = new AbortController()
    let client: ServeClient | undefined
    /* The prompt went, or is going: from here the server has a turn to stop. */
    let sent = false
    let prompted = false
    try {
      const connection = await Promise.race([deps.connect(cwd, request.interactive === true), ended])
      if ("kind" in connection) return settled(connection)
      if (!connection.ok) return finish("error", connection.problem ?? t("bots.serve.notAdmitted", cwd))
      client = connection.client
      const server = client

      if (bot.identifier) {
        const agents = await server.agents()
        const problem = agentProblem(agents, bot)
        if (problem) return finish("error", problem)
        /*
         * A user's bot and a project's agent of its name, with the same words:
         * the server runs the project's file, whose rules and model are its
         * own. Refused as well; a project's bot is that file.
         */
        if (bot.scope === "global" && (await deps.projectHasAgent?.(cwd, bot.identifier)))
          return finish("error", t("bots.serve.agentTaken", bot.identifier))
      }

      const profile = profileFor({
        ...(request.remote ? { remote: { commands: request.remote.commands } } : {}),
        ...(request.unattended ? { unattended: true } : {}),
        ...(request.approvals ? { approvals: true } : {}),
        shell: !bot.disabledTools.includes("bash"),
      })
      const previous = request.sessionId ? await server.session(request.sessionId) : undefined
      if (request.sessionId && hasBotRules(previous, profile)) sessionId = request.sessionId
      else {
        sessionId = await server.create({ title: bot.identifier || "bot", permission: botPermission(profile) })
        /*
         * A routine's session is its own each run (B11): made read-only, it
         * cannot be the one the panel goes on with, so the thread keeps its own.
         */
        if (!request.unattended) {
          const id = sessionId
          const restarted = request.sessionId !== undefined
          const at = now()
          change((thread) => {
            const next = { ...thread, sessionId: id }
            return restarted ? appendMessage(next, { role: "tool", tool: "ade", text: t("bots.serve.newSession") }, at) : next
          })
        }
      }
      if (stopped) return finish("stopped")
      const session = sessionId

      /* ── the events of the session ───────────────────────────────────── */
      const roles = new Map<string, string>()
      /** Parts of a message whose role is not known yet: the user's own words are not the bot's. */
      const waiting = new Map<string, ServePart[]>()
      const spent = new Map<string, { tokens: number; cost: number }>()
      let busy = false
      let failed: string | undefined
      const questions: PendingPermission[] = []
      let shown: string | undefined

      const showNext = () => {
        if (shown !== undefined) return
        const next = questions.shift()
        if (!next) return
        shown = next.requestID
        request.onPermission?.(next)
      }
      /*
       * Only the question on screen, by its id (B8d review, M1): one the
       * server settled meanwhile, and the next one shown in its place, must
       * not take an answer given to the first.
       */
      answer = (requestID, reply) => {
        const id = shown
        if (id === undefined || id !== requestID) return
        shown = undefined
        void server.reply(id, reply).catch(() => {})
        showNext()
      }
      const applyPart = (part: ServePart) => {
        const next = partChange(part, now())
        if (next) change(next)
      }

      const handle = (event: ChatEvent) => {
        if (sessionOf(event) !== session) return
        const props = record(event.properties)
        switch (event.type) {
          case "session.status": {
            const kind = record(props["status"])["type"]
            if (kind === "busy" || kind === "retry") busy = true
            else if (kind === "idle" && busy && prompted) end({ kind: "done" })
            return
          }
          case "session.idle":
            if (busy && prompted) end({ kind: "done" })
            return
          case "message.updated": {
            const info = record(props["info"])
            const id = info["id"]
            if (typeof id !== "string") return
            roles.set(id, String(info["role"]))
            if (info["role"] === "assistant") {
              change((thread) => noteReportedModel(thread, info))
              const raw = record(info["tokens"])
              const tokens = typeof raw["total"] === "number" ? raw["total"] : sumTokens(raw)
              const cost = typeof info["cost"] === "number" ? info["cost"] : 0
              const before = spent.get(id) ?? { tokens: 0, cost: 0 }
              spent.set(id, { tokens, cost })
              const more = tokens - before.tokens
              const extra = cost - before.cost
              if (more !== 0 || extra !== 0) {
                change((thread) =>
                  noteTurnUsage({ ...thread, tokens: thread.tokens + more, costUsd: thread.costUsd + extra }, more, extra, false),
                )
              }
              if (request.maxCostUsd !== undefined && talk.costUsd > request.maxCostUsd) end({ kind: "budget" })
              for (const part of waiting.get(id) ?? []) applyPart(part)
            }
            waiting.delete(id)
            return
          }
          case "message.part.updated": {
            const part = record(props["part"]) as unknown as ServePart
            const role = roles.get(part.messageID)
            if (role === "assistant") applyPart(part)
            else if (role === undefined) {
              const list = (waiting.get(part.messageID) ?? []).filter((kept) => kept.id !== part.id)
              waiting.set(part.messageID, [...list, part])
            }
            return
          }
          case "session.error": {
            const error = props["error"]
            if (stopped && record(error)["name"] === "MessageAbortedError") return
            const text = errorText(error)
            failed = text
            const at = now()
            change((thread) => ({ ...appendMessage(thread, { role: "error", text }, at), status: "error" }))
            return
          }
          case "permission.asked": {
            const id = props["id"]
            if (typeof id !== "string") return
            const permission = String(props["permission"] ?? "")
            const patterns = Array.isArray(props["patterns"]) ? props["patterns"].map(String).join(", ") : ""
            if (!request.onPermission) {
              // Nobody to answer: refused as it comes, and said.
              void server.reply(id, "reject").catch(() => {})
              const at = now()
              change((thread) => appendMessage(thread, { role: "error", text: t("bots.serve.refused", permission, patterns) }, at))
              return
            }
            questions.push({ requestID: id, permission, patterns, askedAt: now() })
            showNext()
            return
          }
          case "permission.replied": {
            const id = props["requestID"]
            const index = questions.findIndex((asked) => asked.requestID === id)
            if (index >= 0) questions.splice(index, 1)
            if (shown === id) {
              shown = undefined
              showNext()
            }
            return
          }
          case "question.asked": {
            // A bot's thread has nowhere to answer one; its rules deny the tool, this is in case.
            const id = props["id"]
            if (typeof id === "string") void server.rejectQuestion(id).catch(() => {})
            return
          }
        }
      }

      /* The stream is open before the prompt goes, so nothing of the turn is missed. */
      const events = connection.events(stream.signal)[Symbol.asyncIterator]()
      const first = await Promise.race([events.next(), ended])
      if ("kind" in first) return settled(first)
      if (!first.done) handle(first.value)
      void (async () => {
        try {
          for (;;) {
            const next = await events.next()
            if (next.done) break
            handle(next.value)
          }
          end({ kind: "lost", why: t("bots.serve.lost") })
        } catch (error) {
          end({ kind: "lost", why: error instanceof Error ? error.message : String(error) })
        }
      })()

      // A bot made on the spot (not a file) has its instructions before the message, as `turnCommand` puts them.
      const text = !request.bot && request.instructions ? `${request.instructions}\n\n${request.message}` : request.message
      const model = modelRef(bot.model)
      if (stopped) return settled({ kind: "stopped" })
      sent = true
      await server.prompt({
        sessionID: session,
        text,
        ...(bot.identifier ? { agent: bot.identifier } : {}),
        ...(model ? { model } : {}),
        ...(bot.effort ? { variant: bot.effort } : {}),
      })
      prompted = true
      const how = await ended
      if (how.kind === "done") return failed !== undefined ? finish("error", failed, 1) : finish("done", undefined, 0)
      return settled(how)
    } catch (error) {
      return finish("error", t("bots.turn.didNotStart", "nikcli", error instanceof Error ? error.message : String(error)))
    } finally {
      clearTimeout(timer)
      stream.abort()
      answer = undefined
      slot.release()
      // Whatever ended the turn early, the server stops it too.
      if (client && sessionId && sent && over?.kind !== "done") void client.abort(sessionId).catch(() => {})
    }

    function settled(how: End): TurnResult {
      switch (how.kind) {
        case "stopped":
          return finish("stopped")
        case "timeout":
          return finish("error", timeoutProblem("nikcli", timeoutMs))
        case "budget": {
          const usd = (value: number) => `${value.toFixed(2)} $`
          return finish("error", t("bots.turn.overBudget", "nikcli", usd(talk.costUsd), usd(request.maxCostUsd ?? 0)))
        }
        case "lost":
          return finish("error", how.why)
        case "done":
          return finish("done", undefined, 0)
      }
    }
  })()

  return {
    result,
    stop: () => {
      stopped = true
      end({ kind: "stopped" })
    },
    answer: (requestID, reply) => answer?.(requestID, reply),
  }
}

/** Where a project's yes is kept and what it covers: the Bots' own (`project-trust.ts`), as the Chat has it. */
export function appProjectTrust(directory: string): Omit<AdmitProjectDeps, "confirm"> {
  return { store: localTrustStore(PROJECT_TRUST_KEY), surface: () => projectSurface(directory, projectFs) }
}

/**
 * A bot's turn, on the runner it names: nikcli's on ADE's server, where a
 * question has an id (B8d) — the panel's, a room's, a routine's and a chat's;
 * the others as `runTurn` runs them.
 */
export function runBotTurn(request: TurnRequest, serve: () => ServeTurnDeps = appServeTurnDeps, deps: TurnDeps = {}): Turn {
  if (request.runner === "nikcli") return runServeTurn(request, serve())
  return runTurn(request, deps)
}

/** The calls of `ServeClient` on the SDK's client. */
export function serveClientOf(client: NikcliClient): ServeClient {
  return {
    agents: async () => ((await client.app.agents()).data ?? []) as readonly Agent[],
    session: async (sessionID) => {
      try {
        return (await client.session.get({ sessionID })).data as { permission?: unknown } | undefined
      } catch (error) {
        // Gone, or never on this server: a session of `nikcli run` from another folder, say.
        if (/\b404\b|not ?found/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error))) return undefined
        throw error
      }
    },
    create: async ({ title, permission }) =>
      ((await client.session.create({ title, permission: [...permission] })).data as unknown as { id: string }).id,
    prompt: async ({ sessionID, text, agent, model, variant }) => {
      // Never `tools`: it would replace the session's rules (`prompt.ts`).
      await client.session.promptAsync({
        sessionID,
        parts: [{ type: "text", text }],
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
      })
    },
    abort: async (sessionID) => {
      await client.session.abort({ sessionID })
    },
    reply: async (requestID, reply) => {
      await client.permission.reply({ requestID, reply })
    },
    rejectQuestion: async (requestID) => {
      await client.question.reject({ requestID })
    },
  }
}

/**
 * In the app: the Chat's server and its admitted connection, per folder, on
 * every turn. The yes is the one the Chat and the panel keep, per project and
 * for its files as they are: asked once, and again only when they change.
 * With nobody in front of the screen, a project not admitted is refused.
 */
export function appServeTurnDeps(
  connection: () => ChatConnectionDeps = appChatConnectionDeps,
  trust: (directory: string) => Omit<AdmitProjectDeps, "confirm"> = appProjectTrust,
): ServeTurnDeps {
  const unattended = (directory: string) =>
    admitProject(directory, { ...trust(directory), confirm: () => false }).then((admitted) =>
      admitted.ok ? admitted : { ok: false as const, problem: t("bots.serve.notAdmitted", directory) },
    )
  return {
    projectHasAgent: async (directory, identifier) => {
      for (const folder of agentDirs(directory, "project")) {
        try {
          await projectFs.readText(joinPath(folder, `${identifier}.md`))
          return true
        } catch {
          // Not there: the next spelling of the folder.
        }
      }
      return false
    },
    connect: async (directory, interactive) => {
      const base = connection()
      const opened = await openChat(directory, interactive ? base : { ...base, admit: unattended })
      if (!opened.ok) return opened
      return { ok: true, client: serveClientOf(opened.client), events: (signal) => readEvents(opened.fetch, directory, signal) }
    },
  }
}
