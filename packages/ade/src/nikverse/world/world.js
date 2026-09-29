/*
 * NikVerse's world, the placeholder of the first piece (N1).
 *
 * It runs in a frame of its own, from the `nikverse` scheme: it is not ADE's
 * origin and it has no line to ADE except one MessageChannel port. ADE hands
 * it over once, and only after the world has sent back, in a `hello`, the nonce
 * ADE put in its address: a page that is not the world has not got it. Everything it knows arrives
 * on that port (a snapshot, then events), and everything it asks for leaves on
 * it as a command that ADE checks against an allowlist.
 *
 * Nothing here builds HTML from data: names and titles go in as text.
 *
 * The state and the reducers are plain functions so `world.test.ts` can run
 * them without a page; the page only starts when index.html says it is one.
 */

/** ADE hands the port over in a message with this type, and nothing else on `window` is believed. */
export const PORT_OFFER = "nikverse:port"

/** The world says this to its parent, with the nonce ADE put in its address: the proof it is the world. */
export const HELLO = "nikverse:hello"

/** The nonce in the address fragment (`#n=…`), or nothing. */
export function readNonce(hash) {
  const value = new URLSearchParams(String(hash).replace(/^#/, "")).get("n")
  return value && /^[0-9a-f]{32,}$/.test(value) ? value : undefined
}

export const STATE_LABELS = {
  work: "al lavoro",
  perm: "attende un permesso",
  ask: "attende una risposta",
  err: "errore",
  limit: "limite raggiunto",
  idle: "ferma",
  off: "sospesa",
  closed: "chiusa",
}

export function emptyState() {
  return { shops: new Map(), agents: new Map(), waiting: 0, seen: false }
}

/** The whole picture, replacing whatever was there. */
export function applySnapshot(_state, snapshot) {
  const state = emptyState()
  state.seen = true
  for (const shop of snapshot.shops) state.shops.set(shop.id, shop)
  for (const agent of snapshot.agents) state.agents.set(agent.paneId, agent)
  state.waiting = snapshot.waiting?.decisions ?? 0
  return state
}

/** One change, on top of the picture. An event for something unknown is dropped: the next snapshot fixes it. */
export function applyEvent(state, event) {
  switch (event.type) {
    case "shop-open":
      state.shops.set(event.shop.id, event.shop)
      break
    case "shop-close":
      state.shops.delete(event.shop.id)
      for (const [id, agent] of state.agents) if (agent.shop === event.shop.id) state.agents.delete(id)
      break
    case "agent-spawn":
      state.agents.set(event.agent.paneId, event.agent)
      break
    case "agent-close":
      state.agents.delete(event.agent.paneId)
      break
    case "state": {
      const agent = state.agents.get(event.paneId)
      if (agent) state.agents.set(event.paneId, { ...agent, state: event.state, since: event.at })
      break
    }
    case "waiting":
      state.waiting = event.decisions
      break
  }
  return state
}

/** What one Esc does: a captured mouse is released first, and only then is the focus given back to ADE. */
export function escAction(captured) {
  return captured ? "release-capture" : "release-focus"
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"])

/**
 * The command for a key that ADE should hear: a shortcut with Ctrl, Alt or Meta,
 * which ADE runs as its own (the frame with the focus would otherwise take it).
 * Plain keys stay in the world.
 */
export function chordCommand(event) {
  if (MODIFIER_KEYS.has(event.key)) return undefined
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return undefined
  return {
    cmd: "chord",
    key: event.key,
    ctrl: Boolean(event.ctrlKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    meta: Boolean(event.metaKey),
  }
}

/**
 * Drawing on request, and not at all while paused.
 *
 * `invalidate` asks for a frame; one is scheduled only when the loop runs and
 * none is waiting. `pause` takes back the frame that was waiting, so a hidden
 * panel costs nothing; `resume` draws once if something changed meanwhile.
 */
export function createRenderer({ raf, caf, draw }) {
  let running = true
  let dirty = false
  let handle
  const tick = () => {
    handle = undefined
    if (!running || !dirty) return
    dirty = false
    draw()
  }
  const schedule = () => {
    if (running && dirty && handle === undefined) handle = raf(tick)
  }
  return {
    invalidate() {
      dirty = true
      schedule()
    },
    pause() {
      running = false
      if (handle !== undefined) caf(handle)
      handle = undefined
    },
    resume() {
      running = true
      schedule()
    },
    get running() {
      return running
    },
    get waiting() {
      return handle !== undefined
    },
  }
}

const el = (doc, tag, props = {}, ...children) => {
  const node = doc.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (name === "text") node.textContent = value
    else node.setAttribute(name, value)
  }
  for (const child of children) node.append(child)
  return node
}

/** Redraws the page from the state. Text only: no title or name is ever parsed as markup. */
export function render(doc, state, send) {
  const shops = doc.getElementById("shops")
  const empty = doc.getElementById("empty")
  const status = doc.getElementById("status")
  const shopList = [...state.shops.values()].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.name.localeCompare(b.name))
  empty.hidden = !state.seen || shopList.length > 0
  status.textContent = !state.seen
    ? "in attesa di ADE…"
    : `${state.agents.size} sessioni · ${shopList.length} progetti` +
      (state.waiting > 0 ? ` · ${state.waiting} decisioni in attesa` : "")
  shops.replaceChildren(
    ...shopList.map((shop) => {
      const list = el(doc, "ul")
      for (const agent of [...state.agents.values()].filter((item) => item.shop === shop.id)) {
        const open = el(doc, "button", { type: "button", text: "Apri sessione" })
        open.addEventListener("click", () => send({ cmd: "open-session", paneId: agent.paneId }))
        list.append(
          el(
            doc,
            "li",
            { class: "agent", "data-state": agent.state, "data-pane": agent.paneId },
            el(doc, "span", { class: "dot", "aria-hidden": "true" }),
            el(doc, "span", { class: "name", text: agent.title, title: agent.title }),
            el(doc, "span", { class: "state", text: STATE_LABELS[agent.state] ?? agent.state }),
            open,
          ),
        )
      }
      const focus = el(doc, "button", { type: "button", text: "Vai al progetto" })
      focus.addEventListener("click", () => send({ cmd: "focus-project", project: shop.id }))
      return el(doc, "article", { class: "shop", "data-shop": shop.id }, el(doc, "h2", { text: shop.name }), list, focus)
    }),
  )
}

/** Starts the page: waits for ADE's port, then lives on it. Only ever once per document. */
export function boot(win) {
  const doc = win.document
  let state = emptyState()
  let port
  const send = (command) => port?.postMessage({ type: "command", command })
  const renderer = createRenderer({
    raf: (fn) => win.requestAnimationFrame(fn),
    caf: (handle) => win.cancelAnimationFrame(handle),
    draw: () => render(doc, state, send),
  })
  renderer.invalidate()

  // Without the nonce this is not the world ADE made, and it says nothing: no port will come.
  const nonce = readNonce(win.location?.hash ?? "")
  const onPort = (message) => {
    if (!nonce || port || message.source !== win.parent) return
    if (message.data?.type !== PORT_OFFER || message.ports.length !== 1) return
    port = message.ports[0]
    win.removeEventListener("message", onPort)
    port.onmessage = ({ data }) => {
      if (!data || typeof data !== "object") return
      // Whether this document is still the one at the other end: only it can answer.
      if (data.type === "ping") return port.postMessage({ type: "pong", id: data.id })
      if (data.type === "snapshot") state = applySnapshot(state, data.snapshot)
      else if (data.type === "event") state = applyEvent(state, data.event)
      else if (data.type === "pause") return renderer.pause()
      else if (data.type === "resume") renderer.resume()
      renderer.invalidate()
    }
    port.postMessage({ type: "ready" })
  }
  win.addEventListener("message", onPort)
  if (nonce) win.parent.postMessage({ type: HELLO, nonce }, "*")

  // The focus is the world's once it is clicked; Esc gives it back (a second time if the mouse was captured).
  let captured = false
  win.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (escAction(captured) === "release-capture") captured = false
      else send({ cmd: "release-focus" })
      return
    }
    const chord = chordCommand(event)
    if (!chord) return
    event.preventDefault()
    send(chord)
  })
  doc.getElementById("world")?.addEventListener("pointerdown", () => doc.getElementById("world")?.focus())
  return renderer
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.nikverse === "1") boot(window)
