import path from "path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { Effect, Schema } from "effect"
import { configFilesInDirectory } from "@nikcli-ai/util/config-file"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Flag } from "@nikcli-ai/util/flag"
import { Log } from "@nikcli-ai/util/log"
import { Global } from "@nikcli-ai/util/global"
import { ModApi } from "./api"
import type { ModChain } from "./chain"

/**
 * What an organization decides about mods, and the guard that enforces it.
 *
 * The policy lives in managed settings only: a `mod` block in `nikcli.json`
 * under a managed directory. The same block in a user's or a project's config
 * changes nothing, so a repository cannot loosen what the machine's owner set.
 *
 * `sec-default` is itself a mod, registered through the same `on` as any other
 * and loaded ahead of every mod a user installs. It is the model for a policy
 * mod, and it can be read as one.
 */
export namespace ModGuard {
  const log = Log.create({ service: "mod-guard" })

  export const Policy = Schema.Struct({
    /** Plugin names that run before every mod a user installs, in this order. */
    prependPlugins: Schema.optional(Schema.Array(Schema.String)),
    /** Plugin names that run after every mod a user installs, in this order. */
    appendPlugins: Schema.optional(Schema.Array(Schema.String)),
    /** Only the organization's mods and the built-in ones load. */
    allowManagedModsOnly: Schema.optional(Schema.Boolean),
    /** A mod may approve a tool call that a `deny` rule refuses. */
    allowModsToOverrideDenyRules: Schema.optional(Schema.Boolean),
    /** No mod runs at all. */
    disableAllMods: Schema.optional(Schema.Boolean),
  }).annotate({ identifier: "ModPolicy" })
  export type Policy = typeof Policy.Type

  const Settings = Schema.Struct({ mod: Schema.optional(Policy) })

  export class PolicyInvalid extends Schema.TaggedError<PolicyInvalid>()("ModPolicyInvalid", {
    path: Schema.String,
    reason: Schema.String,
  }) {
    override get message() {
      return `Managed mod policy ${this.path} is invalid: ${this.reason}`
    }
  }

  export interface Resolved {
    policy: Policy
    /** A managed settings file exists. */
    managed: boolean
    /** A managed file could not be read; the guard then refuses every user mod. */
    invalid?: string
    /** Directories whose `plugins/` hold the organization's own mods. */
    orgDirs: string[]
  }

  /**
   * Managed settings directories, strongest first. The system directories are
   * admin-owned and also hold the organization's own mods; the legacy
   * `~/.config/nikcli/managed` carries policy only, because the user owns it.
   */
  export function managedDirs(): { dir: string; org: boolean }[] {
    const system =
      process.platform === "darwin"
        ? "/Library/Application Support/nikcli"
        : process.platform === "win32"
          ? path.join(process.env["ProgramData"] ?? "C:\\ProgramData", "nikcli")
          : "/etc/nikcli"
    const dirs: { dir: string; org: boolean }[] = []
    const extra = Flag.managedConfigDir()
    if (extra) dirs.push({ dir: extra, org: true })
    dirs.push({ dir: path.join(system, "managed"), org: true })
    dirs.push({ dir: path.join(Global.Path.config, "managed"), org: false })
    return dirs
  }

  const readPolicyFile = (file: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!(await Filesystem.exists(file))) return undefined
        const errors: ParseError[] = []
        const parsed = parseJsonc(await Filesystem.readText(file), errors, { allowTrailingComma: true })
        if (errors.length > 0) throw new Error(`could not be parsed (offset ${errors[0]!.offset})`)
        return Schema.decodeUnknownSync(Settings)(parsed ?? {}).mod ?? {}
      },
      catch: (error) =>
        new PolicyInvalid({ path: file, reason: error instanceof Error ? error.message : String(error) }),
    })

  /**
   * Read the policy. Never fails: a managed file that cannot be read is
   * reported as `invalid`, and the guard turns that into "no user mod loads".
   * Failing open on a broken policy would make deleting a comma a way around it.
   */
  export const read = Effect.fn("ModGuard.read")(function* () {
    const merged: { -readonly [K in keyof Policy]: Policy[K] } = {}
    const orgDirs: string[] = []
    let managed = false
    let invalid: string | undefined
    for (const { dir, org } of managedDirs()) {
      if (org && (yield* Effect.promise(() => Filesystem.exists(dir)))) orgDirs.push(dir)
      for (const file of configFilesInDirectory(dir, "nikcli")) {
        const found = yield* Effect.result(readPolicyFile(file))
        if (found._tag === "Failure") {
          log.warn("managed mod policy is invalid; refusing user mods", { file, reason: found.failure.reason })
          invalid ??= found.failure.message
          managed = true
          continue
        }
        if (found.success === undefined) continue
        managed = true
        for (const [key, value] of Object.entries(found.success)) {
          if (value !== undefined && merged[key as keyof Policy] === undefined)
            (merged as Record<string, unknown>)[key] = value
        }
      }
    }
    return { policy: merged, managed, invalid, orgDirs } satisfies Resolved
  })

  /** Specifiers of the organization's own mods: `<managed>/plugins/*`. */
  export const orgSpecs = Effect.fn("ModGuard.orgSpecs")(function* (dirs: string[]) {
    const specs: string[] = []
    for (const dir of dirs) {
      const root = path.join(dir, "plugins")
      // A managed directory without a `plugins/` folder is the normal case, not an error.
      const found = yield* Effect.tryPromise(async () => {
        const out: string[] = []
        for (const pattern of ["*/index.{ts,js}", "*.{ts,js}"]) {
          for await (const file of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) out.push(file)
        }
        return out.sort()
      }).pipe(Effect.orElseSucceed(() => [] as string[]))
      for (const file of found) specs.push(Bun.pathToFileURL(file).href)
    }
    return specs
  })

  // ---------------------------------------------------------------------------
  // What a module asks for, read without running it.

  export interface Uses {
    /** Event names passed to `on`, in source order, without duplicates. */
    hooks: string[]
    /** Mods API methods, each `namespace.method` without the `$.`. */
    calls: string[]
    /** Environment variables read and written through `$.env`. */
    envReads: string[]
    envWrites: string[]
    /** Ways the module uses `$` that this analysis cannot read; a module with any is refused. */
    unreadable: string[]
  }

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")

  /**
   * `claude plugin validate`'s `hooks:` and `calls:` lines, for a nikcli mod.
   *
   * A static scan: it can only see calls written in full, namespace then
   * method. That is the point — a module that reaches `$` through an alias, a
   * destructuring or a computed key cannot be reviewed, so it is refused
   * rather than trusted.
   */
  export function analyze(source: string): Uses {
    const text = stripComments(source)
    const hooks = new Set<string>()
    const calls = new Set<string>()
    const envReads = new Set<string>()
    const envWrites = new Set<string>()
    const unreadable: string[] = []

    for (const match of text.matchAll(/\bon\(\s*(["'`])([A-Za-z0-9_.*:-]+)\1/g)) hooks.add(match[2]!)
    if (/\bon\(\s*(?!["'`])[^)\s]/.test(text)) unreadable.push("on() with an event name that is not a literal")

    for (const match of text.matchAll(/\$\.([a-z]+)\.([A-Za-z]+)/g)) calls.add(`${match[1]}.${match[2]}`)
    for (const match of text.matchAll(/\$\.env\.get\(\s*(["'`])([^"'`]+)\1/g)) envReads.add(match[2]!)
    for (const match of text.matchAll(/\$\.env\.set\(\s*(["'`])([^"'`]+)\1/g)) envWrites.add(match[2]!)
    if (/\$\.env\.get\(\s*(?!["'`])/.test(text)) envReads.add("(computed)")
    if (/\$\.env\.set\(\s*(?!["'`])/.test(text)) envWrites.add("(computed)")

    if (/\$\s*\[/.test(text)) unreadable.push("a computed key on $")
    if (/\$\.[a-z]+\s*\[/.test(text)) unreadable.push("a computed method on a $ namespace")
    if (/(?:const|let|var)\s*[{[][^=]*[}\]]\s*=\s*\$(?![.\w])/.test(text)) unreadable.push("$ destructured")
    if (/(?:const|let|var)\s+\w+\s*=\s*\$\s*(?:;|\n|$)/.test(text)) unreadable.push("$ stored in a variable")
    if (/\$\.([a-z]+)(?![.\w])/.test(text.replace(/\$\.plugin\b/g, "")))
      unreadable.push("a $ namespace used without a method")

    return {
      hooks: [...hooks],
      calls: [...calls],
      envReads: [...envReads],
      envWrites: [...envWrites],
      unreadable,
    }
  }

  // ---------------------------------------------------------------------------
  // `nikcli mod validate`

  /** Events nikcli fires today. */
  export const EVENTS = [
    "plugin.register",
    "session.start",
    "session.end",
    "session.compact",
    "prompt.submit",
    "prompt.section",
    "prompt.compose",
    "skill.prompt",
    "tool.call",
    "tool.check",
    "tool.describe",
    "command.run",
    "command.describe",
    "turn.start",
    "turn.step",
    "turn.complete",
    "agent.offer",
    "agent.spawn",
    "ui.render",
    "ui.press",
    "ui.input",
    "ui.select",
  ] as const

  /** The `$` calls nikcli has: each is also an event a hook can intercept. */
  export const API_CALLS = [
    "fs.read",
    "fs.write",
    "fs.list",
    "fs.exists",
    "fs.stat",
    "fs.ancestors",
    "process.run",
    "process.spawn",
    "http.fetch",
    "env.get",
    "env.set",
    "store.get",
    "store.set",
    "store.delete",
    "store.keys",
    "ui.log",
    "ui.toast",
    "ui.ask",
    "ui.copy",
    "command.run",
    "session.messages",
    "session.model",
    "session.turns",
    "session.repo",
    "session.version",
    "session.usage",
    "prompt.submit",
    "prompt.fill",
    "turn.abort",
    "model.complete",
    "model.classify",
    "settings.read",
    "mcp.call",
    "mcp.connect",
    "agent.list",
  ] as const

  /** Events the Claude Code mods API has and nikcli does not fire. A mod hooking one is told, not silently ignored. */
  export const PLANNED_EVENTS = [
    "session.receive",
    "session.send",
    "session.append",
    "session.attach",
    "session.detach",
    "session.measure",
    "prompt.suggest",
    "prompt.edit",
    "prompt.context",
    "prompt.attachment",
    "attribution.text",
    "config.set",
    "config.describe",
    "ui.resolve",
    "ui.focus",
    "ui.scroll",
    "ui.close",
    "ui.message",
    "engine.create",
  ] as const

  export interface Report {
    ok: boolean
    errors: string[]
    warnings: string[]
    uses: Uses
  }

  /**
   * Review a mod's source without running it: what it hooks, what it calls,
   * what it cannot be allowed to do (a module whose use of `$` cannot be read
   * is an error) and what nikcli does not have yet (a warning).
   */
  export function validate(source: string): Report {
    const uses = analyze(source)
    const errors: string[] = []
    const warnings: string[] = []

    let exportsRegister = false
    try {
      exportsRegister = new Bun.Transpiler({ loader: "ts" }).scan(source).exports.includes("register")
    } catch (error) {
      errors.push(`the module does not parse: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!exportsRegister && errors.length === 0) errors.push("the module does not export register(on, options)")
    for (const reason of uses.unreadable)
      errors.push(`it uses the mods API in a way that cannot be reviewed: ${reason}`)

    const apiEvent = { test: (name: string) => (API_CALLS as readonly string[]).includes(name) }
    for (const event of uses.hooks) {
      if ((EVENTS as readonly string[]).includes(event)) continue
      if (event === "*" || event.endsWith(".*")) continue
      if ((PLANNED_EVENTS as readonly string[]).includes(event)) {
        warnings.push(`${event} is not fired by nikcli yet, so this hook never runs`)
      } else if (!apiEvent.test(event)) {
        warnings.push(`${event} is not an event nikcli knows`)
      }
    }
    for (const call of uses.calls) {
      if ((ModApi.UNSUPPORTED as readonly string[]).includes(call))
        warnings.push(`$.${call} is not available in nikcli yet`)
    }
    return { ok: errors.length === 0, errors, warnings, uses }
  }

  // ---------------------------------------------------------------------------
  // sec-default

  export const GUARD_ID = "sec-default@builtin"

  /**
   * The built-in guard, as a mod. It loads before every other mod and cannot be
   * turned off. It does four things:
   *
   * - refuses a user's mod when `allowManagedModsOnly` is set;
   * - refuses every user mod when the managed policy cannot be read;
   * - keeps a `deny` rule a deny, whatever a mod answers on `tool.check`
   *   (unless the policy says `allowModsToOverrideDenyRules`);
   * - fails closed: if its own hook throws or times out, the call is refused.
   */
  export function register(resolved: Resolved) {
    const { policy } = resolved
    return (on: ModChain.On) => {
      on("plugin.register", async (_$, e, next) => {
        if (e.tier !== "user") return next(e)
        if (resolved.invalid) {
          return { refuse: `the managed mod policy could not be read, so user mods are refused (${resolved.invalid})` }
        }
        if (policy.allowManagedModsOnly) {
          return { refuse: "mods are limited to your organization's by policy (allowManagedModsOnly)" }
        }
        return next(e)
      }).catch(async (_$, e, next) => {
        if (e.tier !== "user") return next(e)
        return { refuse: `the mod guard failed, so this mod was not loaded: ${next.error!.kind}` }
      })

      on("tool.check", async (_$, e, next) => {
        const decided = await next(e)
        if (policy.allowModsToOverrideDenyRules) return decided
        if (e.rule === "deny" && decided?.decision !== "deny") {
          return { decision: "deny", reason: e.reason ?? "a permission rule denies this call" }
        }
        return decided
      }).catch(async (_$, e, next) => ({
        decision: "deny",
        reason: `the mod guard failed, so this call was not run: ${next.error!.kind}`,
      }))
    }
  }
}
