import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  STATE_LABELS,
  applyEvent,
  applySnapshot,
  chordCommand,
  createRenderer,
  emptyState,
  escAction,
  render,
} from "./world/world.js"

const agent = (paneId: string, over: Record<string, unknown> = {}) => ({
  paneId,
  title: paneId,
  kind: "claude-code",
  shop: "s1",
  state: "work",
  since: 1,
  look: { body: 0, palette: 0 },
  ...over,
})
const shop = (id: string, name = id, slot = 0) => ({ id, name, slot })

const picture = () => ({
  at: 1,
  shops: [shop("s1", "nikcli")],
  agents: [agent("n1"), agent("n2", { state: "perm" })],
  waiting: { decisions: 2 },
})

describe("the world's picture, from what ADE sends", () => {
  test("a snapshot replaces everything", () => {
    const first = applySnapshot(emptyState(), picture())
    expect([...first.shops.keys()]).toEqual(["s1"])
    expect([...first.agents.keys()]).toEqual(["n1", "n2"])
    expect(first.waiting).toBe(2)
    const second = applySnapshot(first, { at: 2, shops: [shop("s2")], agents: [], waiting: { decisions: 0 } })
    expect([...second.shops.keys()]).toEqual(["s2"])
    expect(second.agents.size).toBe(0)
    expect(second.waiting).toBe(0)
  })

  test("events change the picture the way the differ said", () => {
    const state = applySnapshot(emptyState(), picture())
    applyEvent(state, { type: "shop-open", shop: shop("s2", "voice", 1) })
    applyEvent(state, { type: "agent-spawn", agent: agent("n3", { shop: "s2" }) })
    applyEvent(state, { type: "state", paneId: "n1", state: "err", at: 50 })
    applyEvent(state, { type: "waiting", decisions: 5 })
    expect([...state.shops.keys()]).toEqual(["s1", "s2"])
    expect(state.agents.get("n3")?.shop).toBe("s2")
    expect(state.agents.get("n1")).toMatchObject({ state: "err", since: 50 })
    expect(state.waiting).toBe(5)
    applyEvent(state, { type: "agent-close", agent: agent("n2") })
    expect(state.agents.has("n2")).toBe(false)
    // Closing a shop takes its people with it.
    applyEvent(state, { type: "shop-close", shop: shop("s2") })
    expect([...state.shops.keys()]).toEqual(["s1"])
    expect(state.agents.has("n3")).toBe(false)
  })

  test("an event about something unknown, or of a kind it does not know, changes nothing", () => {
    const state = applySnapshot(emptyState(), picture())
    applyEvent(state, { type: "state", paneId: "zz", state: "err", at: 1 })
    applyEvent(state, { type: "mail", from: "a", to: "b" })
    applyEvent(state, { type: "agent-close", agent: agent("zz") })
    expect([...state.agents.keys()]).toEqual(["n1", "n2"])
    expect(state.waiting).toBe(2)
  })

  test("every state ADE can send has a label", () => {
    for (const state of ["work", "perm", "ask", "err", "limit", "idle", "off", "closed"]) {
      expect(typeof (STATE_LABELS as Record<string, string>)[state]).toBe("string")
    }
  })
})

describe("the page", () => {
  const page = () => {
    document.body.innerHTML =
      '<span id="status"></span><p id="empty" hidden></p><section id="shops"></section>'
    return document
  }

  test("shows the projects and the sessions received, and says 'apri sessione' on the channel", () => {
    const doc = page()
    const sent: unknown[] = []
    render(doc, applySnapshot(emptyState(), picture()), (command: unknown) => sent.push(command))
    expect(doc.querySelectorAll(".shop")).toHaveLength(1)
    expect(doc.querySelector(".shop h2")?.textContent).toBe("nikcli")
    expect([...doc.querySelectorAll(".agent")].map((row) => row.getAttribute("data-state"))).toEqual(["work", "perm"])
    expect(doc.getElementById("status")?.textContent).toBe("2 sessioni · 1 progetti · 2 decisioni in attesa")
    const buttons = [...doc.querySelectorAll<HTMLButtonElement>(".agent button")]
    buttons[1]!.click()
    expect(sent).toEqual([{ cmd: "open-session", paneId: "n2" }])
    doc.querySelector<HTMLButtonElement>(".shop > button")!.click()
    expect(sent[1]).toEqual({ cmd: "focus-project", project: "s1" })
  })

  test("titles and names are text, never markup", () => {
    const doc = page()
    const hostile = { ...picture(), shops: [shop("s1", '<img src=x onerror="alert(1)">')], agents: [agent("n1", { title: "<b>x</b>" })] }
    render(doc, applySnapshot(emptyState(), hostile), () => {})
    expect(doc.querySelector("img")).toBeNull()
    expect(doc.querySelector("b")).toBeNull()
    expect(doc.querySelector(".shop h2")?.textContent).toBe('<img src=x onerror="alert(1)">')
    expect(doc.querySelector(".agent .name")?.textContent).toBe("<b>x</b>")
  })

  test("before ADE has said anything it waits; with no projects it says so", () => {
    const doc = page()
    render(doc, emptyState(), () => {})
    expect(doc.getElementById("status")?.textContent).toBe("in attesa di ADE…")
    expect(doc.getElementById("empty")?.hidden).toBe(true)
    render(doc, applySnapshot(emptyState(), { at: 1, shops: [], agents: [], waiting: { decisions: 0 } }), () => {})
    expect(doc.getElementById("empty")?.hidden).toBe(false)
  })
})

describe("the keyboard: focus and shortcuts", () => {
  test("Esc lets go of a captured mouse first, and only then gives the focus back to ADE", () => {
    expect(escAction(true)).toBe("release-capture")
    expect(escAction(false)).toBe("release-focus")
  })

  test("a shortcut with Ctrl, Alt or Meta is forwarded to ADE; a plain key stays in the world", () => {
    const key = (init: Record<string, unknown>) => chordCommand({ key: "k", ...init })
    expect(key({ ctrlKey: true })).toEqual({ cmd: "chord", key: "k", ctrl: true, alt: false, shift: false, meta: false })
    expect(key({ altKey: true, shiftKey: true })).toMatchObject({ alt: true, shift: true })
    expect(key({ metaKey: true })).toMatchObject({ meta: true })
    for (const plain of [{}, { shiftKey: true }]) expect(key(plain)).toBeUndefined()
    for (const movement of ["w", "a", "s", "d", "e", "ArrowUp", "ArrowLeft", " "])
      expect(chordCommand({ key: movement })).toBeUndefined()
  })

  test("pressing Ctrl alone is not a shortcut", () => {
    for (const modifier of ["Control", "Alt", "Shift", "Meta"])
      expect(chordCommand({ key: modifier, ctrlKey: true, altKey: true, metaKey: true })).toBeUndefined()
  })
})

describe("pausing stops the drawing", () => {
  function frames() {
    const queue = new Map<number, () => void>()
    let next = 1
    return {
      raf: (fn: () => void) => {
        const id = next++
        queue.set(id, fn)
        return id
      },
      caf: (id: number) => void queue.delete(id),
      run: () => {
        for (const [id, fn] of [...queue]) {
          queue.delete(id)
          fn()
        }
      },
      pending: () => queue.size,
    }
  }

  test("a change draws one frame, on request, and none when nothing changed", () => {
    const loop = frames()
    let drawn = 0
    const renderer = createRenderer({ raf: loop.raf, caf: loop.caf, draw: () => void drawn++ })
    expect(loop.pending()).toBe(0)
    renderer.invalidate()
    renderer.invalidate()
    expect(loop.pending()).toBe(1)
    loop.run()
    loop.run()
    expect(drawn).toBe(1)
  })

  test("pausing takes back the frame that was waiting, and a change while paused asks for none", () => {
    const loop = frames()
    let drawn = 0
    const renderer = createRenderer({ raf: loop.raf, caf: loop.caf, draw: () => void drawn++ })
    renderer.invalidate()
    expect(loop.pending()).toBe(1)
    renderer.pause()
    expect(loop.pending()).toBe(0)
    expect(renderer.running).toBe(false)
    renderer.invalidate()
    renderer.invalidate()
    expect(loop.pending()).toBe(0)
    loop.run()
    expect(drawn).toBe(0)
  })

  test("resuming draws once for what changed while it slept, and not at all if nothing did", () => {
    const loop = frames()
    let drawn = 0
    const renderer = createRenderer({ raf: loop.raf, caf: loop.caf, draw: () => void drawn++ })
    renderer.pause()
    renderer.invalidate()
    renderer.resume()
    expect(loop.pending()).toBe(1)
    loop.run()
    expect(drawn).toBe(1)
    renderer.pause()
    renderer.resume()
    expect(loop.pending()).toBe(0)
  })
})

describe("what the world's page is allowed to be", () => {
  const dir = join(import.meta.dir, "world")
  const html = readFileSync(join(dir, "index.html"), "utf8")
  const script = readFileSync(join(dir, "world.js"), "utf8")

  test("lint: the page loads its own files only, with no inline script, style or handler", () => {
    for (const tag of html.split("<script").slice(1)) expect(tag.split(">")[0]).toContain('src="world.js"')
    expect(html).not.toMatch(/<style|\son[a-z]+=|https?:\/\//)
    expect(html).toContain('href="world.css"')
  })

  test("lint: the world never builds HTML from what ADE sends, and never talks to the network", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|importScripts/)
  })

  test("lint: it keeps nothing in the browser: an opaque origin has no storage, and the position is ADE's to save", () => {
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./)
  })

  test("lint: it takes the port only from its parent, only once, and speaks nowhere else on `window`", () => {
    expect(script).toContain("message.source !== win.parent")
    expect(script).toContain("if (port ||")
    expect(script).not.toMatch(/postMessage\([^)]*,\s*["']\*["']/)
    expect(script).not.toMatch(/win(dow)?\.parent\.postMessage|top\.postMessage/)
  })
})
