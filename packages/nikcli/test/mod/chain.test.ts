import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ModChain } from "@/mod/chain"

/** The engine's own failure, so a test can tell it from a hook failure. */
class EngineError extends Error {
  readonly _tag = "EngineError"
}

function mod(name: string, rank: number, tier: ModChain.Tier = "user", skip = false): ModChain.Mod {
  return { id: name, name, tier, rank, skip, api: () => ({}) }
}

function load(bus: ModChain.Registry, m: ModChain.Mod, register: (on: ModChain.On) => void) {
  bus.add(m, register)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `emit` as a Promise, with a Promise-or-plain `final`; an engine throw is a typed failure. */
function emit(
  registry: ModChain.Registry,
  name: string,
  event: unknown,
  final: (event: any) => unknown,
  options?: ModChain.EmitOptions,
) {
  return Effect.runPromise(
    ModChain.emit(
      registry,
      name,
      event,
      (e) => Effect.tryPromise({ try: async () => final(e), catch: (error) => error }),
      options,
    ),
  ) as Promise<any>
}

/** The typed failure `emit` ends with, instead of a rejection. */
function emitFailure(
  registry: ModChain.Registry,
  name: string,
  event: unknown,
  final: (event: any) => Effect.Effect<any, any>,
) {
  return Effect.runPromise(Effect.flip(ModChain.emit(registry, name, event, final)))
}

describe("ModChain", () => {
  it("is exactly final(event) when no hook matches: not copied, not frozen", async () => {
    const bus = new ModChain.Registry()
    load(bus, mod("a", 2), (on) => on("other.event", async ($, e, next) => next(e)))
    const event = { text: "hi" }
    const seen: unknown[] = []
    const out = await emit(bus, "prompt.submit", event, (e) => {
      seen.push(e)
      return "done"
    })
    expect(out).toBe("done")
    expect(seen[0]).toBe(event)
    expect(Object.isFrozen(event)).toBe(false)
  })

  it("freezes a copy, so the caller's own objects are never frozen under it", async () => {
    const bus = new ModChain.Registry()
    load(bus, mod("a", 2), (on) => on("tool.call", async ($, e, next) => next(e)))
    const args = { command: "ls", nested: { a: 1 } }
    let seen: any
    await emit(bus, "tool.call", args, (e) => ((seen = e), "ok"))
    expect(Object.isFrozen(args)).toBe(false)
    expect(Object.isFrozen(args.nested)).toBe(false)
    expect(Object.isFrozen(seen)).toBe(true)
    expect(Object.isFrozen(seen.nested)).toBe(true)
  })

  it("observes: next(e) resolves to the final result", async () => {
    const bus = new ModChain.Registry()
    const log: string[] = []
    load(bus, mod("a", 2), (on) =>
      on("tool.call", async ($, e, next) => {
        log.push("before")
        const result = await next(e)
        log.push("after")
        return result
      }),
    )
    const out = await emit(bus, "tool.call", { tool: "bash" }, () => {
      log.push("final")
      return { output: "ok" }
    })
    expect(out).toEqual({ output: "ok" })
    expect(log).toEqual(["before", "final", "after"])
  })

  it("rewrites: later handlers and final get the copy, and the original is frozen", async () => {
    const bus = new ModChain.Registry()
    let assignError: unknown
    load(bus, mod("a", 2), (on) =>
      on("prompt.submit", async ($, e, next) => {
        try {
          ;(e as { text: string }).text = "mutated"
        } catch (error) {
          assignError = error
        }
        return next({ ...e, text: e.text.trim() })
      }),
    )
    const finals: unknown[] = []
    await emit(bus, "prompt.submit", { text: "  hi  ", nested: { a: 1 } }, (e) => {
      finals.push(e)
      return "ok"
    })
    expect(finals[0]).toEqual({ text: "hi", nested: { a: 1 } })
    expect(assignError).toBeInstanceOf(TypeError)
  })

  it("answers: not calling next skips later hooks and the engine", async () => {
    const bus = new ModChain.Registry()
    const called: string[] = []
    load(bus, mod("a", 2), (on) => on("tool.call", async () => ({ deny: "no" })))
    load(bus, mod("b", 2), (on) => on("tool.call", async ($, e, next) => (called.push("b"), next(e))))
    const out = await emit(bus, "tool.call", { tool: "bash" }, () => (called.push("final"), "ran"))
    expect(out).toEqual({ deny: "no" })
    expect(called).toEqual([])
  })

  it("runs in rank order: the first mod is outermost", async () => {
    const bus = new ModChain.Registry()
    const log: string[] = []
    const watch = (name: string) => (on: ModChain.On) =>
      on("tool.call", async ($, e, next) => {
        log.push(`${name}:in`)
        const result = await next(e)
        log.push(`${name}:out`)
        return result
      })
    // Loaded in the "wrong" order on purpose: rank decides, not load order.
    load(bus, mod("user", 2), watch("user"))
    load(bus, mod("guard", 0, "builtin"), watch("guard"))
    load(bus, mod("org", 1, "prepend"), watch("org"))
    await emit(bus, "tool.call", {}, () => (log.push("final"), "x"))
    expect(log).toEqual(["guard:in", "org:in", "user:in", "final", "user:out", "org:out", "guard:out"])
  })

  it("within one rank, load order decides; within one module, registration order", async () => {
    const bus = new ModChain.Registry()
    const log: string[] = []
    load(bus, mod("first", 2), (on) => {
      on("tool.call", { tool: "a" }, async ($, e, next) => (log.push("first:a"), next(e)))
      on("tool.call", { tool: ["a", "b"] }, async ($, e, next) => (log.push("first:ab"), next(e)))
    })
    load(bus, mod("second", 2), (on) => on("tool.call", async ($, e, next) => (log.push("second"), next(e))))
    await emit(bus, "tool.call", { tool: "a" }, () => "x")
    expect(log).toEqual(["first:a", "first:ab", "second"])
  })

  it("matches by value, array and regular expression, against the event as rewritten", async () => {
    const bus = new ModChain.Registry()
    const hits: string[] = []
    load(bus, mod("a", 2), (on) => {
      on(
        "tool.call",
        { tool: "bash" },
        async ($, e, next) => (hits.push("value"), next({ ...e, tool: "mcp__github__x" })),
      )
      on("tool.call", { tool: /^mcp__github__/ }, async ($, e, next) => (hits.push("regex"), next(e)))
      on("tool.call", { tool: ["edit", "write"] }, async ($, e, next) => (hits.push("array"), next(e)))
    })
    await emit(bus, "tool.call", { tool: "bash" }, () => "x")
    expect(hits).toEqual(["value", "regex"])
    hits.length = 0
    await emit(bus, "tool.call", { tool: "write" }, () => "x")
    expect(hits).toEqual(["array"])
    hits.length = 0
    await emit(bus, "tool.call", { tool: "read" }, () => "x")
    expect(hits).toEqual([])
  })

  it("rejects a second bare registration of an event, and allows a different matcher", () => {
    const bus = new ModChain.Registry()
    expect(() =>
      load(bus, mod("a", 2), (on) => {
        on("session.start", async ($, e, next) => next(e))
        on("session.start", async ($, e, next) => next(e))
      }),
    ).toThrow('on("session.start") is registered twice without a matcher')
    expect(bus.has("a")).toBe(false)
    expect(() =>
      load(bus, mod("b", 2), (on) => {
        on("tool.call", { tool: "a" }, async ($, e, next) => next(e))
        on("tool.call", { tool: "b" }, async ($, e, next) => next(e))
      }),
    ).not.toThrow()
  })

  it("wildcards: '*' skips telemetry, 'ns.*' matches by prefix", () => {
    expect(ModChain.nameMatches("*", "tool.call")).toBe(true)
    expect(ModChain.nameMatches("*", "telemetry.log")).toBe(false)
    expect(ModChain.nameMatches("classic.*", "classic.Stop")).toBe(true)
    expect(ModChain.nameMatches("classic.*", "tool.call")).toBe(false)
    expect(ModChain.nameMatches("tool.call", "tool.call")).toBe(true)
  })

  describe("failure", () => {
    it("a hook that throws before next is skipped and the next handler runs in its place", async () => {
      const bus = new ModChain.Registry()
      const reports: string[] = []
      load(bus, mod("bad", 2), (on) =>
        on("tool.call", async () => {
          throw new Error("boom")
        }),
      )
      load(bus, mod("good", 2), (on) => on("tool.call", async ($, e, next) => ({ wrapped: await next(e) })))
      const out = await emit(bus, "tool.call", {}, () => "ran", {
        report: (i) => reports.push(`${i.mod.name}: ${i.reason}`),
      })
      expect(out).toEqual({ wrapped: "ran" })
      expect(reports).toEqual(["bad: tool.call hook skipped: threw Error: boom"])
    })

    it("a hook that throws after next resolved leaves that result standing and runs nothing twice", async () => {
      const bus = new ModChain.Registry()
      let finals = 0
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => {
          await next(e)
          throw new Error("late")
        }),
      )
      const out = await emit(bus, "tool.call", {}, () => (finals++, "ran"))
      expect(out).toBe("ran")
      expect(finals).toBe(1)
    })

    it("an engine failure reaches the typed channel as itself; it is not a hook failure", async () => {
      const bus = new ModChain.Registry()
      let catches = 0
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => next(e)).catch(async () => {
          catches++
          return { deny: "caught" }
        }),
      )
      const failure = new EngineError("engine broke")
      const out = await emitFailure(bus, "tool.call", {}, () => Effect.fail(failure))
      expect(out).toBe(failure)
      expect(catches).toBe(0)
    })

    it("an engine failure still reaches the typed channel when the hook swallows it and throws", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => {
          try {
            await next(e)
          } catch {
            // swallowed on purpose
          }
          throw new Error("hook then threw")
        }),
      )
      const failure = new EngineError("engine broke")
      expect(await emitFailure(bus, "tool.call", {}, () => Effect.fail(failure))).toBe(failure)
    })

    it("an engine defect is not turned into a hook failure either", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) => on("tool.call", async ($, e, next) => next(e)))
      const exit = await Effect.runPromiseExit(
        ModChain.emit(bus, "tool.call", {}, () => Effect.die(new Error("defect"))),
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    })

    it("interrupting the event aborts next.signal and the engine's own work", async () => {
      const bus = new ModChain.Registry()
      let aborted = false
      let engineInterrupted = false
      let started: () => void
      const running = new Promise<void>((resolve) => (started = resolve))
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => {
          next.signal.addEventListener("abort", () => (aborted = true))
          return next(e)
        }),
      )
      const fiber = Effect.runFork(
        ModChain.emit(bus, "tool.call", {}, () =>
          Effect.sync(() => started()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => (engineInterrupted = true))),
          ),
        ),
      )
      await running
      await Effect.runPromise(Fiber.interrupt(fiber))
      await sleep(10)
      expect(aborted).toBe(true)
      expect(engineInterrupted).toBe(true)
    })

    it("a result of the wrong shape counts as a failure", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) => on("tool.call", async () => ({ bogus: true })))
      const out = await emit(bus, "tool.call", {}, () => ({ ok: 1 }), {
        validate: (r) => (r && typeof r === "object" && ("ok" in r || "deny" in r) ? undefined : "needs ok or deny"),
      })
      expect(out).toEqual({ ok: 1 })
    })

    it("returning undefined is a failure, not a silent pass", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) => on("tool.call", async () => undefined))
      expect(await emit(bus, "tool.call", {}, () => "ran")).toBe("ran")
    })

    it(".catch fails closed: it answers in place of the failed hook, with kind and called", async () => {
      const bus = new ModChain.Registry()
      let finals = 0
      load(bus, mod("guard", 2), (on) =>
        on("tool.call", { tool: "bash" }, async () => {
          throw new Error("guard broke")
        }).catch(async ($, e, next) => ({ deny: `guard failed: ${next.error!.kind}, called=${next.called}` })),
      )
      const out = await emit(bus, "tool.call", { tool: "bash" }, () => (finals++, "ran"))
      expect(out).toEqual({ deny: "guard failed: throw, called=false" })
      expect(finals).toBe(0)
    })

    it(".catch sees called=true when the hook had already called next", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => {
          await next(e)
          throw new Error("after")
        }).catch(async ($, e, next) => ({ called: next.called })),
      )
      expect(await emit(bus, "tool.call", {}, () => "ran")).toEqual({ called: true })
    })

    it("times out a hook that holds the thread, with kind 'timeout'", async () => {
      const bus = new ModChain.Registry()
      let kind: string | undefined
      load(bus, mod("slow", 2), (on) =>
        on("tool.call", async () => {
          await sleep(200)
          return "late"
        }).catch(async ($, e, next) => {
          kind = next.error!.kind
          return { deny: "timed out" }
        }),
      )
      const out = await emit(bus, "tool.call", {}, () => "ran", { limitMs: 30 })
      expect(out).toEqual({ deny: "timed out" })
      expect(kind).toBe("timeout")
    })

    it("without .catch a timed-out hook is skipped", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("slow", 2), (on) =>
        on("tool.call", async () => {
          await sleep(200)
          return "late"
        }),
      )
      expect(await emit(bus, "tool.call", {}, () => "ran", { limitMs: 30 })).toBe("ran")
    })

    it("time inside next, and inside a paused mods API call, does not count", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async ($, e, next) => {
          const waited = await ModChain.paused(async () => {
            await sleep(80)
            return "answered"
          })
          const result = await next(e)
          return { waited, result }
        }),
      )
      const out = await emit(
        bus,
        "tool.call",
        {},
        async () => {
          await sleep(80)
          return "ran"
        },
        { limitMs: 40 },
      )
      expect(out).toEqual({ waited: "answered", result: "ran" })
    })

    it("a .catch handler has its own, shorter limit", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) =>
        on("tool.call", async () => {
          throw new Error("x")
        }).catch(async () => {
          await sleep(200)
          return { deny: "never" }
        }),
      )
      expect(await emit(bus, "tool.call", {}, () => "ran", { catchLimitMs: 30 })).toBe("ran")
    })
  })

  describe("scope", () => {
    it("`after` limits a mods API event to the mods that run after the caller", async () => {
      const bus = new ModChain.Registry()
      const seen: string[] = []
      const a = mod("a", 1, "prepend")
      const b = mod("b", 2)
      const c = mod("c", 3, "append")
      for (const m of [a, b, c]) load(bus, m, (on) => on("fs.read", async ($, e, next) => (seen.push(m.name), next(e))))
      await emit(bus, "fs.read", { path: "x" }, () => "data", { after: b, origin: { plugin: "b", tier: "user" } })
      expect(seen).toEqual(["c"])
    })

    it("`only` limits an event to one mod (session.start)", async () => {
      const bus = new ModChain.Registry()
      const seen: string[] = []
      for (const name of ["a", "b"]) {
        load(bus, mod(name, 2), (on) => on("session.start", async ($, e, next) => (seen.push(name), next(e))))
      }
      await emit(bus, "session.start", {}, () => "ok", { only: "b" })
      expect(seen).toEqual(["b"])
    })

    it("next.origin names who fired the event", async () => {
      const bus = new ModChain.Registry()
      let origin: ModChain.Origin | undefined
      load(bus, mod("a", 2), (on) => on("tool.call", async ($, e, next) => ((origin = next.origin), next(e))))
      await emit(bus, "tool.call", {}, () => "x")
      expect(origin).toEqual({ plugin: "engine", tier: "core" })
    })

    it("next.to skips to a later tier, and only a listed mod may call it", async () => {
      const bus = new ModChain.Registry()
      const seen: string[] = []
      load(bus, mod("org", 1, "prepend", true), (on) =>
        on("tool.call", async ($, e, next) => (seen.push("org"), next.to(e, "append"))),
      )
      load(bus, mod("user", 2), (on) => on("tool.call", async ($, e, next) => (seen.push("user"), next(e))))
      load(bus, mod("app", 3, "append"), (on) => on("tool.call", async ($, e, next) => (seen.push("app"), next(e))))
      await emit(bus, "tool.call", {}, () => "x")
      expect(seen).toEqual(["org", "app"])

      const denied = new ModChain.Registry()
      let message = ""
      load(denied, mod("user", 2), (on) =>
        on("tool.call", async ($, e, next) => next.to(e, "core")).catch(async ($, e, next) => {
          message = next.error!.message
          return { deny: "no" }
        }),
      )
      await emit(denied, "tool.call", {}, () => "x")
      expect(message).toContain("may not call next.to")
    })

    it("removing a mod takes its hooks out of the chain", async () => {
      const bus = new ModChain.Registry()
      load(bus, mod("a", 2), (on) => on("tool.call", async () => ({ deny: "a" })))
      expect(await emit(bus, "tool.call", {}, () => "ran")).toEqual({ deny: "a" })
      bus.remove("a")
      expect(await emit(bus, "tool.call", {}, () => "ran")).toBe("ran")
      expect(bus.handles("tool.call")).toBe(false)
    })
  })
})
