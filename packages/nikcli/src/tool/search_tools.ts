import { Schema } from "effect"
import { zod } from "@nikcli-ai/util/effect-zod"
import { z } from "zod"
import { Tool } from "./tool"
// Type-only: erased at build time, so it cannot reintroduce the import cycle the
// runtime `await import(...)` calls below exist to avoid.
import type { PermissionNext } from "@/permission/next"
import type { Agent } from "@/agent/agent"
import type { ToolRegistry } from "./registry"
import DESCRIPTION from "./search_tools.txt"

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "A tool name (or a comma-separated list of them) or a capability keyword (e.g. 'image', 'memory', 'git', 'browser'). Matched against both tool names and their descriptions.",
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
 * How many characters of parameter schema one search may print, and how many
 * of those a single tool may take.
 *
 * The point of the split is that the schema is not in every request, so it can
 * afford to be printed on demand — but not without a bound: one broad query
 * matching a dozen tools would reprint the surface the split just removed. The
 * per-tool cap stops a single large tool from eating the whole budget.
 */
const MAX_SCHEMA_CHARS = 12_000
const MAX_SCHEMA_PER_TOOL = 4_000

/** One line per tool. The full description arrives with the tool's own schema if it gets used. */
const SUMMARY_LENGTH = 160

function summarize(description: string | undefined): string {
  const line =
    (description ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? ""
  if (line.length <= SUMMARY_LENGTH) return line
  return line.slice(0, SUMMARY_LENGTH - 1).trimEnd() + "…"
}

type Candidate = {
  id: string
  summary: string
  haystack: string
  loaded: boolean
  tool: ToolRegistry.Resolved
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
  const band = id === query ? 2 : id.includes(query) ? 1 : 0
  // Density is a fraction of the description, so it can never reach the gap
  // between two bands — a band always wins outright.
  return band * 2 + density
}

/**
 * The tool names a query asks for, or `undefined` for a keyword query. A comma-separated list (or
 * Claude Code's `select:` form) is always a list of names; a single word is one only when it is
 * exactly a tool's id, so "image" still searches while "webfetch" is looked up. (Upstream 1.417.)
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
  const { ToolRegistry } = await import("./registry")
  // Only the agent's permission ruleset is read from here, and only at execute time; the
  // description below is built without touching the registry at all.
  const agent = initCtx?.agent

  /**
   * The names of the deferred tools, so the model knows they exist without a
   * search to find out.
   *
   * Read straight off the registry's own set, **not** by asking the registry
   * which tools it resolved. A first attempt did the latter and it recursed:
   * `registry.tools()` initialises every tool including this one, so each
   * `init` asked the registry to init every tool, and the test log grew to ten
   * million lines before anyone noticed. The set is a constant, so reading it
   * makes the line not only stable within a session but constant across
   * processes — which is what the cached prefix needs.
   *
   * The cost of the cheap version: a deferred tool that is not registered in this
   * build (behind a flag, say) still gets named here, and a search for it comes
   * back empty. Naming a tool that is absent is a wasted query; omitting a tool
   * that is present is a capability the model cannot discover, so the first
   * failure is the cheaper one.
   */
  const deferredNames = [...ToolRegistry.DEFERRED].sort(ToolRegistry.compareIds)

  return {
    description: [
      DESCRIPTION.trimEnd(),
      "",
      `The ${deferredNames.length} tools below are registered but not in your tool list: ${deferredNames.join(", ")}.`,
      `search_tools returns any of their parameters, and call_tool runs one: call_tool({"name": "<tool>", "args": {...}}).`,
    ].join("\n"),
    parameters: zod(Parameters),

    async execute({ query }, ctx) {
      const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
      const { Effect } = await import("effect")
      const { ToolRegistry } = await import("./registry")

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

      // Session-level visibility, evaluated exactly the way `resolveTools` does
      // when it hands the toolset to the model — otherwise this tool would name
      // tools the model has no schema for.
      const ruleset = await sessionRuleset(ctx.sessionID, agent)
      const disabledTools = ruleset.disabledTools
      const eager = ruleset.eager

      const candidates: Candidate[] = []
      const known = new Set<string>()
      for (const tool of resolved) {
        if (HIDDEN.has(tool.id)) continue
        known.add(tool.id.toLowerCase())
        // A deferred tool is absent from the model's schema but is exactly what
        // this search exists to find. "Could it be reached?" is asked by running
        // the same exposure check, so a permission deny or a user switch-off
        // still wins and the rules live in one place.
        const exposure = ToolRegistry.exposure(tool.id, { disabledTools, ruleset: ruleset.rules, eager })
        if (exposure === "hidden") continue
        const loaded = exposure === "active"
        const summary = summarize(tool.description)
        candidates.push({
          id: tool.id,
          summary,
          // Descriptions are what make a capability keyword like "git" or
          // "screenshot" findable at all: no tool id contains either word.
          haystack: (tool.id + " " + (tool.description ?? "")).toLowerCase(),
          loaded,
          // The full description and parameter schema, so the model can call it
          // without a second round-trip to ask what the parameters are.
          tool,
        })
      }
      candidates.sort((left, right) => ToolRegistry.compareIds(left.id, right.id))

      // Deferred entries come back whole: description and parameter schema, so the next call is a
      // `call_tool` and not another search. The cap keeps one broad query from reprinting the
      // surface this split removed.
      const render = (deferred: Candidate[], shownCount: number) => {
        const budget = Math.max(0, MAX_SCHEMA_CHARS - shownCount * SUMMARY_LENGTH)
        const lines: string[] = []
        const withSchema: string[] = []
        let spent = 0
        for (const entry of deferred) {
          const schema = schemaOf(entry.tool)
          const size = entry.summary.length + schema.length
          if (size > budget - spent) {
            lines.push(`- ${entry.id}: ${entry.summary} [parameters omitted, narrow the query]`)
            continue
          }
          spent += size
          lines.push(
            [
              `- ${entry.id}: ${entry.summary}`,
              `  call it with: call_tool({"name": "${entry.id}", "args": ...})`,
              `  parameters: ${schema}`,
            ].join("\n"),
          )
          withSchema.push(entry.id)
        }
        return { lines, withSchema }
      }

      // Exact names (or a `select:` list): answer for each name, say which ones this session lacks.
      const names = requestedNames(query, known)
      if (names) {
        const byId = new Map(candidates.map((entry) => [entry.id.toLowerCase(), entry]))
        const found = names.map((name) => byId.get(name.toLowerCase())).filter((entry) => entry !== undefined)
        const missing = names.filter((name) => !byId.has(name.toLowerCase()))
        const already = found.filter((entry) => entry.loaded)
        const rendered = render(
          found.filter((entry) => !entry.loaded),
          found.length,
        )
        return {
          title: `search_tools: ${query}`,
          output: [
            ...(already.length > 0 ? [`Already in your toolset: ${already.map((entry) => entry.id).join(", ")}`] : []),
            ...rendered.lines,
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
            schemas: rendered.withSchema,
            truncated: rendered.withSchema.length < found.filter((entry) => !entry.loaded).length,
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
          metadata: { query, matches: 0, available: candidates.length, schemas: [] as string[], truncated: false },
        }
      }

      const shown = matches.slice(0, MAX_MATCHES)
      const overflow = matches.length - shown.length

      const deferred = shown.filter((entry) => !entry.loaded)
      const { lines, withSchema } = render(deferred, shown.length)

      return {
        title: `search_tools: ${query}`,
        output: [
          `${matches.length} tool${matches.length === 1 ? "" : "s"} match "${query}" (of ${candidates.length} available in this session):`,
          "",
          ...shown.map((entry) => (entry.loaded ? `- ${entry.id}: ${entry.summary} [in your toolset]` : null)),
          ...(deferred.length > 0 ? lines : []),
          ...(overflow > 0 ? ["", `…and ${overflow} more. Narrow the query to see them.`] : []),
        ]
          .filter((line) => line !== null)
          .join("\n"),
        metadata: {
          query,
          matches: matches.length,
          available: candidates.length,
          schemas: withSchema,
          truncated: withSchema.length < deferred.length,
        },
      }
    },
  }
})

/** The parameter schema as the model would receive it, bounded per tool. */
function schemaOf(tool: { parameters: unknown }): string {
  try {
    const schema = z.toJSONSchema(tool.parameters as z.ZodType, {
      io: "input",
      unrepresentable: "any",
    }) as unknown
    const text = JSON.stringify(schema)
    return text.length > MAX_SCHEMA_PER_TOOL ? text.slice(0, MAX_SCHEMA_PER_TOOL) + "…" : text
  } catch {
    return "{}"
  }
}

/**
 * The effective ruleset plus the session's disabled-tool map — the same pair
 * `resolveTools` builds. A session that cannot be read (no session at all, or a
 * transient store error) degrades to "nothing disabled" rather than failing the
 * search: an over-broad catalog is a far better outcome here than an error.
 */
async function sessionRuleset(sessionID: string, agent?: Agent.Info) {
  const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
  const { Effect } = await import("effect")
  const { PermissionNext } = await import("@/permission/next")
  const { Flag } = await import("@nikcli-ai/util/flag")
  const { Session } = await import("@/session")

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

  const { Config } = await import("@/config/config")
  const eager = await runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    ),
  )
    .then((config) => config.tool?.eager ?? [])
    .catch(() => [] as string[])

  const merged = PermissionNext.merge(agentRules, info?.permission ?? [])
  return {
    rules: Flag.autoApprove() ? PermissionNext.autoApprove(merged) : merged,
    disabledTools: info?.disabledTools ?? {},
    eager,
  }
}

/**
 * This tool's description plus an index of the deferred tools. Upstream appends the index so the
 * model learns what it can load; here the list is fixed text in the description and a tool never
 * leaves it, because a description that shrinks as tools are used would rewrite the first block of
 * the prompt. Kept so `/usage` can size the tool the way `resolveTools` builds it.
 */
export function withDeferredIndex(
  description: string,
  _deferred: readonly { id: string; description?: string }[],
): string {
  return description
}
