import { describe, expect, it } from "bun:test"
import { ModGuard } from "@/mod/guard"

describe("ModGuard.analyze", () => {
  it("lists the events a module hooks and the mods API calls it makes, written in full", () => {
    const uses = ModGuard.analyze(`
      export function register(on) {
        on("tool.call", { tool: "bash" }, async ($, e, next) => {
          const text = await $.fs.read("notes.md")
          await $.ui.log("read " + text.length)
          return next(e)
        })
        on('prompt.submit', async ($, e, next) => next(e))
        on(\`session.start\`, async ($, e, next) => next(e))
      }
    `)
    expect(uses.hooks).toEqual(["tool.call", "prompt.submit", "session.start"])
    expect(uses.calls).toEqual(["fs.read", "ui.log"])
    expect(uses.unreadable).toEqual([])
  })

  it("reads environment variables by name, and marks a computed name", () => {
    const uses = ModGuard.analyze(`
      export function register(on) {
        on("tool.call", async ($, e, next) => {
          await $.env.get("HOME")
          await $.env.set("MY_FLAG", "1")
          await $.env.get(e.name)
          return next(e)
        })
      }
    `)
    expect(uses.envReads).toEqual(["HOME", "(computed)"])
    expect(uses.envWrites).toEqual(["MY_FLAG"])
  })

  it("ignores what is only mentioned in a comment", () => {
    const uses = ModGuard.analyze(`
      // never call $.process.run here
      /* $.fs.write is also off limits */
      export function register(on) { on("tool.call", async ($, e, next) => next(e)) }
    `)
    expect(uses.calls).toEqual([])
  })

  it("lets $ be passed to a helper, since the calls inside it are still written in full", () => {
    const uses = ModGuard.analyze(`
      async function check($, e, next) { return (await $.process.run(["git", "status"])).stdout ? next(e) : next(e) }
      export function register(on) { on("tool.call", check) }
    `)
    expect(uses.unreadable).toEqual([])
    expect(uses.calls).toEqual(["process.run"])
  })

  it.each([
    ["a computed key", `on("tool.call", async ($, e, next) => { await $["fs"].read("x"); return next(e) })`],
    ["a computed method", `on("tool.call", async ($, e, next) => { await $.fs["read"]("x"); return next(e) })`],
    ["destructured", `on("tool.call", async ($, e, next) => { const { fs } = $; return next(e) })`],
    ["stored in a variable", `on("tool.call", async ($, e, next) => { const api = $\n return next(e) })`],
    ["a namespace used without a method", `on("tool.call", async ($, e, next) => { const fs = $.fs; return next(e) })`],
    ["an event name that is not a literal", `const name = "tool.call"\non(name, async ($, e, next) => next(e))`],
  ])("cannot read %s, so the module is refused", (reason, body) => {
    const uses = ModGuard.analyze(`export function register(on) { ${body} }`)
    expect(uses.unreadable.length).toBeGreaterThan(0)
    expect(uses.unreadable.join(" ")).toContain(reason.split(" ").slice(-2).join(" ").replace("a ", ""))
  })
})

describe("ModGuard.validate", () => {
  const good = `export function register(on) { on("tool.call", async ($, e, next) => next(e)) }`

  it("accepts a mod that exports register and hooks an event nikcli fires", () => {
    const report = ModGuard.validate(good)
    expect(report).toMatchObject({ ok: true, errors: [], warnings: [] })
  })

  it("rejects a module that does not export register, or does not parse", () => {
    expect(ModGuard.validate(`export const x = 1`).errors).toEqual(["the module does not export register(on, options)"])
    expect(ModGuard.validate(`export function register(on) {`).errors[0]).toContain("does not parse")
  })

  it("warns about an event nikcli does not fire yet, an unknown one, and an API nikcli lacks", () => {
    const report = ModGuard.validate(`export function register(on) {
      on("turn.step", async ($, e, next) => next(e))
      on("tool.cal", async ($, e, next) => next(e))
      on("tool.call", async ($, e, next) => { await $.model.complete({ prompt: "x" }); return next(e) })
    }`)
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([
      "turn.step is not fired by nikcli yet, so this hook never runs",
      "tool.cal is not an event nikcli knows",
      "$.model.complete is not available in nikcli yet",
    ])
  })

  it("accepts wildcards and mods API events", () => {
    const report = ModGuard.validate(`export function register(on) {
      on("*", async ($, e, next) => next(e))
      on("fs.*", async ($, e, next) => next(e))
      on("process.run", async ($, e, next) => next(e))
    }`)
    expect(report.warnings).toEqual([])
  })

  it("marks an unreadable use of $ as an error, not a warning", () => {
    const report = ModGuard.validate(
      `export function register(on) { on("tool.call", async ($, e, next) => { const { fs } = $; return next(e) }) }`,
    )
    expect(report.ok).toBe(false)
    expect(report.errors[0]).toContain("cannot be reviewed")
  })
})
