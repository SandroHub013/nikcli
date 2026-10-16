import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../../test-support/solid-jsx"
import { t, setLocalePreference } from "../../i18n"
import { createStateAside, type StateAside, type StateAsideDeps } from "./state-aside"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { StateAsideNotice } = await import("./state-aside-notice")

setLocalePreference("it")

/* N-A11a: the unreadable state put aside is said once, with where the copy is, and never what it holds. */

const COPY = "C:/Users/Ale/AppData/Roaming/ai.nikcli.ade/gateway/state.corrupt-1760000000000.json"

function harness(taken: readonly string[] = []) {
  let heard: ((path: string) => void) | undefined
  const state = { stopped: 0, takes: 0, takeFails: false }
  const deps: StateAsideDeps = {
    take: async () => {
      state.takes += 1
      if (state.takeFails) throw new Error("niente")
      return taken
    },
    listen: async (on) => {
      heard = on
      return () => void (state.stopped += 1)
    },
  }
  return { deps, state, hear: (path: string) => heard?.(path) }
}

describe("what the panel is told", () => {
  test("a copy put aside before the page listened is taken at start, once", async () => {
    const aside = createStateAside()
    const h = harness([COPY])
    await aside.start(h.deps)
    expect(aside.copies()).toEqual([COPY])
    expect(h.state.takes).toBe(1)
  })

  test("one put aside while the page listens comes by the event, and the same one again says nothing more", async () => {
    const aside = createStateAside()
    const h = harness()
    await aside.start(h.deps)
    expect(aside.copies()).toEqual([])
    h.hear(COPY)
    h.hear(COPY)
    expect(aside.copies()).toEqual([COPY])
    // The question at the next start gives the same copy back (Rust empties its list only when asked): told already.
    const again = harness([COPY])
    await aside.start(again.deps)
    expect(aside.copies()).toEqual([COPY])
  })

  test("once read, it goes and does not come back for that copy; another copy is another notice", async () => {
    const aside = createStateAside()
    const h = harness()
    await aside.start(h.deps)
    h.hear(COPY)
    aside.dismiss()
    expect(aside.copies()).toEqual([])
    h.hear(COPY)
    expect(aside.copies()).toEqual([])
    h.hear(COPY.replace("1760000000000", "1760000009999"))
    expect(aside.copies()).toHaveLength(1)
  })

  test("a question that gets no answer leaves the event to say it, and stopping stops listening", async () => {
    const aside = createStateAside()
    const h = harness()
    h.state.takeFails = true
    const stop = await aside.start(h.deps)
    h.hear(COPY)
    expect(aside.copies()).toEqual([COPY])
    stop()
    expect(h.state.stopped).toBe(1)
  })

  test("what is not a path is not a notice", async () => {
    const aside = createStateAside()
    const h = harness()
    await aside.start(h.deps)
    h.hear("")
    h.hear(undefined as unknown as string)
    expect(aside.copies()).toEqual([])
  })
})

describe("the notice", () => {
  let dispose: (() => void) | undefined
  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.body.innerHTML = ""
  })
  const mount = (aside: StateAside) => {
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(() => createComponent(StateAsideNotice, { aside }), host)
    return host
  }

  test("it says the state was put aside and the pairings are to be redone, with the copy's place, and goes when read", () => {
    const aside = createStateAside()
    const host = mount(aside)
    expect(host.textContent).toBe("")
    aside.add(COPY)
    expect(host.textContent).toContain("Lo stato delle app di messaggi era rovinato ed è stato messo da parte; gli abbinamenti vanno rifatti.")
    expect(host.textContent).toContain(COPY)
    ;(host.querySelector("button") as HTMLButtonElement).click()
    expect(host.textContent).toBe("")
  })

  test("both languages say it, and neither has a place for what was in the file", () => {
    for (const language of ["it", "en"] as const) {
      setLocalePreference(language)
      const said = t("gateway.panel.stateAside", COPY)
      expect(said).toContain(COPY)
      expect(said.length).toBeLessThan(300)
    }
    setLocalePreference("en")
    expect(t("gateway.panel.stateAside", "x")).toContain("set aside")
    setLocalePreference("it")
  })

  test("lint: it is drawn in the platforms tab above the tiles, and the app starts it from Rust's event and question", () => {
    const panel = readFileSync(join(import.meta.dir, "panel.tsx"), "utf8")
    expect(panel.indexOf("<StateAsideNotice />")).toBeGreaterThan(panel.indexOf('t("gateway.panel.heading")'))
    expect(panel.indexOf("<StateAsideNotice />")).toBeLessThan(panel.indexOf('data-slot="gateway-tiles"'))
    const bridge = readFileSync(join(import.meta.dir, "bridge.ts"), "utf8")
    expect(bridge).toContain('invoke<string[]>("gateway_state_set_aside")')
    expect(bridge).toContain('listen<string>("gateway:state-aside"')
    expect(bridge).toContain("stopAside()")
  })
})
