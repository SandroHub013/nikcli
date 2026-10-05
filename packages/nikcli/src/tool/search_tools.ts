import { Schema } from "effect"
import { zod } from "@nikcli-ai/util/effect-zod"
import { Tool } from "./tool"
// Type-only: erased at build time, so it cannot reintroduce the import cycle the
// runtime `await import(...)` calls below exist to avoid.
import type { PermissionNext } from "@/permission/next"
import type { Agent } from "@/agent/agent"
import DESCRIPTION from "./search_tools.txt"

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Exact tool names to load, comma-separated (e.g. 'webfetch' or 'webfetch,websearch'), or a capability keyword (e.g. 'image', 'memory', 'git', 'browser') matched against tool names and descriptions.",
  }),
})

/**
 * Never worth returning:
 *
 * - `invalid` is an internal shim the model is explicitly told not to call; it
 *   exists so a malformed tool call has somewhere to land.
 * - `search_tools` is the tool being run. Its own description names the
 *   capabilities it helps you find ("image", "git", "screenshot", …), so
 *   leaving it in would make it a false positive for almost every query.
 */
const HIDDEN = new Set(["invalid", "search_tools"])

/** Enough to choose a tool; not so many that discovery costs more than the toolset. */
const MAX_MATCHES = 20

/**
 * A keyword query loads at most this many deferred tools, and only ones whose
 * name contains the keyword. A word that merely appears in a description is
 * too weak a signal to put a schema into every remaining request — `opentui`
 * alone is larger than the whole core toolset — so those matches are listed
 * for the model to load by name.
 */
const MAX_KEYWORD_LOADS = 3

/** One line per tool. The full description arrives with the tool's own schema once it is loaded. */
const SUMMARY_LENGTH = 160

/** The deferred index rides in every request, so its lines are kept shorter than a search result's. */
const INDEX_SUMMARY_LENGTH = 100

function summarize(description: string | undefined, length = SUMMARY_LENGTH): string {
  const line =
    (description ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? ""
  if (line.length <= length) return line
  return line.slice(0, length - 1).trimEnd() + "…"
}

/**
 * This tool's description plus the index of the tools it can load: the only
 * place the model learns a deferred tool exists, so it goes wherever the tool
 * does — the request `resolveTools` builds and the `/usage` estimate of it.
 *
 * Loaded tools drop out of the index. That changes this description, but only
 * on the step where the loaded tool's own schema joins the toolset, which
 * changes the tool block anyway.
 */
export function withDeferredIndex(
  description: string,
  deferred: readonly { id: string; description?: string }[],
): string {
  const entries = deferred.filter((entry) => !HIDDEN.has(entry.id))
  if (entries.length === 0) return description
  return [
    description.trimEnd(),
    "",
    `Deferred tools (${entries.length}) — load by exact name before first use:`,
    ...entries.map((entry) => {
      const summary = summarize(entry.description, INDEX_SUMMARY_LENGTH)
      return summary ? `- ${entry.id}: ${summary}` : `- ${entry.id}`
    }),
  ].join("\n")
}

/**
 * Load deferred tools into a session: from the next step on, their schemas are
 * part of every request. Recorded as `disabledTools[id] = false` — the same
 * entry the `/usage` toggle writes — so a loaded tool survives restarts, shows
 * as enabled in `/usage` and can be switched back off there. An entry the
 * user already set, either way, is left alone.
 *
 * Resolves to the requested ids that are loaded once the write lands — a
 * concurrent call may have loaded some of them first; an id the user switched
 * off is not among them.
 */
export async function loadTools(sessionID: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
  const { Effect } = await import("effect")
  const { Session } = await import("@/session")
  let loaded: string[] = []
  await runPromiseWithLayer(
    Session.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const session = yield* Session.Service
        yield* session.update(
          sessionID,
          (draft) => {
            const map = { ...draft.disabledTools }
            for (const id of ids) if (map[id] === undefined) map[id] = false
            loaded = ids.filter((id) => map[id] === false)
            draft.disabledTools = map
          },
          // Loading a tool is not activity the session list should reorder on.
          { touch: false },
        )
      }),
    ),
  )
  return loaded
}

type Candidate = {
  id: string
  summary: string
  haystack: string
  deferred: boolean
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count++
    from = at + needle.length
  }
}

/** Exact-id match, id contains the query, description-only match. */
function band(entry: Candidate, query: string): number {
  const id = entry.id.toLowerCase()
  return id === query ? 2 : id.includes(query) ? 1 : 0
}

/**
 * How strongly a tool answers the query. Higher sorts first; 0 means "no match".
 *
 * Density, not hit count. A few tools build their description at init time by
 * embedding a catalog — `code_mode` documents the tools its scripts can call,
 * `skill` lists the installed skills — so almost any capability word appears
 * somewhere inside them. Scoring by the share of the description given over to
 * the term keeps `computer` ahead of `code_mode` for "screenshot" without
 * having to special-case either tool by name.
 */
function score(entry: Candidate, query: string): number {
  const id = entry.id.toLowerCase()
  const hits = occurrences(entry.haystack, query)
  if (!id.includes(query) && hits === 0) return 0
  const density = (hits * query.length) / Math.max(entry.haystack.length, 1)
  // Three bands, each of which beats everything below it outright; density only
  // orders tools within a band. Asking for "read" must return `read` before
  // `todoread`, and both before whatever merely mentions reading.
  // Density is a fraction of the description, so it can never reach the gap
  // between two bands — a band always wins outright.
  return band(entry, query) * 2 + density
}

/**
 * The tool names a query asks for, or `undefined` for a keyword query. A
 * comma-separated list (or Claude Code's `select:` form) is always a list of
 * names; a single word is one only when it is exactly a tool's id — including
 * one this session cannot use, which is then reported as such — so "image"
 * still searches while "webfetch" loads.
 */
function requestedNames(query: string, ids: ReadonlySet<string>): string[] | undefined {
  const trimmed = query.trim()
  const select = /^select:/i.test(trimmed)
  const names = (select ? trimmed.slice("select:".length) : trimmed)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  if (names.length === 0) return undefined
  if (select || names.length > 1) return names
  return ids.has(names[0].toLowerCase()) ? names : undefined
}

export const SearchToolsTool = Tool.define("search_tools", async (initCtx) => {
  const agent = initCtx?.agent

  return {
    description: DESCRIPTION,
    parameters: zod(Parameters),

    async execute({ query }, ctx) {
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      const { Effect } = await import("effect")
      const { ToolRegistry } = await import("./registry")
      const { Log } = await import("@nikcli-ai/util/log")

      // The model this session is running against decides part of the toolset
      // (apply_patch vs edit/write, the Exa-backed search tools). Falling back to
      // an empty descriptor keeps the tool answering rather than throwing when it
      // is driven outside the normal session path.
      // SAFETY: every field is optional and read defensively — the comment
      // above describes the empty-descriptor fallback that covers a context
      // carrying no model at all.
      const model = ctx.extra?.["model"] as { providerID?: string; api?: { id?: string } } | undefined
      const descriptor = {
        providerID: model?.providerID ?? "",
        modelID: model?.api?.id ?? "",
      }

      const resolved = await runPromiseWithLayer(
        ToolRegistry.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools(descriptor, agent)
          }),
        ),
      )

      // Session-level exposure, evaluated exactly the way `resolveTools` does
      // when it hands the toolset to the model — otherwise this tool would
      // offer a tool the session will not run, or load one that is already in.
      const state = await sessionState(ctx.sessionID, agent)

      const candidates: Candidate[] = []
      const known = new Set<string>()
      for (const tool of resolved) {
        if (HIDDEN.has(tool.id)) continue
        known.add(tool.id.toLowerCase())
        const exposure = ToolRegistry.exposure(tool.id, state)
        if (exposure === "hidden") continue
        candidates.push({
          id: tool.id,
          summary: summarize(tool.description),
          // Descriptions are what make a capability keyword like "git" or
          // "screenshot" findable at all: no tool id contains either word.
          haystack: (tool.id + " " + (tool.description ?? "")).toLowerCase(),
          deferred: exposure === "deferred",
        })
      }
      candidates.sort((left, right) => ToolRegistry.compareIds(left.id, right.id))
      const byId = new Map(candidates.map((entry) => [entry.id.toLowerCase(), entry]))

      const load = async (ids: string[]) => {
        if (ids.length === 0) return []
        // A session that cannot be written to (a tool driven outside one) still
        // gets its answer: the tools stay callable by name, just not loaded.
        return loadTools(ctx.sessionID, ids).catch((error) => {
          Log.create({ service: "tool.search_tools" }).warn("failed to load deferred tools", {
            sessionID: ctx.sessionID,
            ids,
            error: String(error),
          })
          return [] as string[]
        })
      }

      const names = requestedNames(query, known)
      if (names) {
        const found = names.map((name) => byId.get(name.toLowerCase())).filter((entry) => entry !== undefined)
        const missing = names.filter((name) => !byId.has(name.toLowerCase()))
        const loaded = new Set(await load(found.filter((entry) => entry.deferred).map((entry) => entry.id)))
        const newly = found.filter((entry) => entry.deferred && loaded.has(entry.id))
        const failed = found.filter((entry) => entry.deferred && !loaded.has(entry.id))
        const already = found.filter((entry) => !entry.deferred)
        return {
          title: `search_tools: ${query}`,
          output: [
            ...(newly.length > 0
              ? [
                  `Loaded ${newly.length} tool${newly.length === 1 ? "" : "s"} — ${newly.length === 1 ? "its schema is" : "their schemas are"} in your toolset from your next step:`,
                  ...newly.map((entry) => `- ${entry.id}: ${entry.summary}`),
                ]
              : []),
            ...(already.length > 0 ? [`Already in your toolset: ${already.map((entry) => entry.id).join(", ")}`] : []),
            ...(failed.length > 0
              ? [
                  `Could not load ${failed.map((entry) => entry.id).join(", ")} into this session; ${failed.length === 1 ? "it is" : "they are"} still callable by name.`,
                ]
              : []),
            ...(missing.length > 0
              ? [
                  `Not available in this session: ${missing.join(", ")}`,
                  "",
                  `Available tools (${candidates.length}): ${candidates.map((entry) => entry.id).join(", ")}`,
                ]
              : []),
          ].join("\n"),
          metadata: {
            query,
            matches: found.length,
            available: candidates.length,
            loaded: [...loaded],
            truncated: false,
          },
        }
      }

      const q = query.trim().toLowerCase()
      const matches = candidates
        .map((entry) => ({ entry, score: score(entry, q) }))
        .filter((scored) => scored.score > 0)
        // Ties break on id so the same query always returns the same order.
        .sort((left, right) => right.score - left.score || ToolRegistry.compareIds(left.entry.id, right.entry.id))
        .map((scored) => scored.entry)

      if (matches.length === 0) {
        return {
          title: `search_tools: ${query}`,
          output: [
            `No tool matches "${query}".`,
            "",
            // Names only. A miss is the cheap branch: the model needs to see the
            // shape of the toolset to retry, not 35 summaries it did not ask for.
            `Available tools (${candidates.length}): ${candidates.map((entry) => entry.id).join(", ")}`,
          ].join("\n"),
          metadata: { query, matches: 0, available: candidates.length, loaded: [] as string[], truncated: false },
        }
      }

      const loaded = new Set(
        await load(
          matches
            .filter((entry) => entry.deferred && band(entry, q) > 0)
            .slice(0, MAX_KEYWORD_LOADS)
            .map((entry) => entry.id),
        ),
      )
      const shown = matches.slice(0, MAX_MATCHES)
      const overflow = matches.length - shown.length
      const pending = shown.some((entry) => entry.deferred && !loaded.has(entry.id))
      const status = (entry: Candidate) =>
        loaded.has(entry.id) ? " [loaded now]" : entry.deferred ? " [deferred — load by name]" : ""
      return {
        title: `search_tools: ${query}`,
        output: [
          `${matches.length} tool${matches.length === 1 ? "" : "s"} match "${query}" (of ${candidates.length} available in this session):`,
          "",
          ...shown.map((entry) => `- ${entry.id}${status(entry)}: ${entry.summary}`),
          ...(overflow > 0 ? ["", `…and ${overflow} more. Narrow the query to see them.`] : []),
          ...(loaded.size > 0 ? ["", "Tools marked [loaded now] are in your toolset from your next step."] : []),
          ...(pending ? ["", "To load a deferred tool, call search_tools again with its exact name."] : []),
        ].join("\n"),
        metadata: {
          query,
          matches: matches.length,
          available: candidates.length,
          loaded: [...loaded],
          truncated: false,
        },
      }
    },
  }
})

/**
 * What {@link ToolRegistry.exposure} needs for this session: the effective
 * ruleset and the session's tool map — the same pair `resolveTools` builds —
 * plus `config.tool.eager`. A session that cannot be read (no session at all,
 * or a transient store error) degrades to "nothing disabled or loaded" rather
 * than failing the search: an over-broad catalog is a far better outcome here
 * than an error.
 */
async function sessionState(sessionID: string, agent?: Agent.Info) {
  const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
  const { Effect } = await import("effect")
  const { PermissionNext } = await import("@/permission/next")
  const { Flag } = await import("@nikcli-ai/util/flag")
  const { Session } = await import("@/session")
  const { Config } = await import("@/config/config")

  const agentRules: PermissionNext.Ruleset = agent?.permission ?? []

  const info = await runPromiseWithLayer(
    Session.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.get(sessionID)
      }),
    ),
  ).catch(() => undefined)

  const config = await runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.get()
      }),
    ),
  ).catch(() => undefined)

  const merged = PermissionNext.merge(agentRules, info?.permission ?? [])
  return {
    ruleset: Flag.autoApprove() ? PermissionNext.autoApprove(merged) : merged,
    disabledTools: info?.disabledTools ?? {},
    eager: config?.tool?.eager ?? [],
  }
}
