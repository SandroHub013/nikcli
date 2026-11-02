import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { parseCss, rulesFor, winner } from "../test-support/css-rules"
import { setLocalePreference } from "../i18n"
import type { SessionPaneProps } from "./pane"
import { paneActivity } from "./pane-state"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { SessionPane } = await import("./pane")
const { Sidebar } = await import("../sidebar/sidebar")

setLocalePreference("it")

/*
 * The state work, tested on what is drawn and not on what the source says.
 *
 * Its first version checked strings in the sheets and the components, and five
 * things it claimed did not happen: a finished session read «Pronta» in the
 * sidebar while its pane said «Chiusa», the spinner text reached the chip in
 * every state but one, the cost vanished on most panes, the card lost its
 * facts on narrow ones, and the light pill's new ground never applied. These
 * mount the real components and ask the real rules.
 */

const paneCss = parseCss(readFileSync(join(import.meta.dir, "pane.css"), "utf-8"))
const pillTabsCss = readFileSync(join(import.meta.dir, "..", "ui", "pill-tabs.css"), "utf-8")
const chatCss = readFileSync(join(import.meta.dir, "..", "chat", "chat.css"), "utf-8")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(props: Partial<SessionPaneProps> = {}): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => createComponent(SessionPane, { title: "Sessione", status: "idle", lines: [], ...props }),
    host,
  )
  return host.querySelector<HTMLElement>('[data-component="session-pane"]')!
}

const chipText = (pane: HTMLElement) => pane.querySelector(".a-det")?.textContent?.trim() ?? ""
const chipLabel = (pane: HTMLElement) => pane.querySelector(".a-state")?.getAttribute("aria-label") ?? ""

// The audit's chip (screenshot 100547): 40 characters, which is what a report may hold.
const SPINNER_FRAME = "Mustering…Mustering…✻Mustering…3Musterin"

describe("the chip, in every state (DS-18, UX-8)", () => {
  test("the screenshot's spinner frame reaches the chip as one clean word while working", () => {
    expect(SPINNER_FRAME.length).toBe(40)
    const pane = mount({ status: "working", activity: SPINNER_FRAME })
    expect(pane.dataset.state).toBe("work")
    expect(chipText(pane)).toBe("Mustering…")
    expect(chipLabel(pane)).not.toContain("✻")
    expect(pane.querySelector(".a-state")?.getAttribute("title")).not.toContain("Mustering…Mustering")
  })

  test("a permission prompt in a terminal says where the answer goes, whatever the agent last reported", () => {
    const pane = mount({ status: "waiting", terminalId: "t1", activity: SPINNER_FRAME })
    expect(pane.dataset.state).toBe("perm")
    expect(chipText(pane)).toBe("rispondi nel terminale")
    expect(chipLabel(pane)).toContain("scegli la risposta nel terminale")
  })

  test("a report such as «Creating task…» does not turn a permission into a question to another session", () => {
    expect(mount({ status: "waiting", terminalId: "t1", activity: "Creating task…" }).dataset.state).toBe("perm")
  })

  test("a stale frame does not stay on the states after", () => {
    // The agent's last report is handed over only while the session works (paneActivity, used by the renderer).
    expect(paneActivity({ status: "working", activity: "running" }, SPINNER_FRAME)).toBe(SPINNER_FRAME)
    expect(paneActivity({ status: "working", activity: "running" }, undefined)).toBe("running")
    for (const status of ["idle", "waiting", "done", "error"] as const) {
      expect(paneActivity({ status, activity: "ready" }, SPINNER_FRAME)).toBe("ready")
    }
    expect(paneActivity({ status: "working", suspended: true }, SPINNER_FRAME)).toBe("suspended")
    expect(chipText(mount({ status: "idle", activity: paneActivity({ status: "idle", activity: "ready" }, SPINNER_FRAME) }))).toBe("")
  })

  test("a code that only restates the state says nothing twice; one that adds a fact is shown", () => {
    expect(chipText(mount({ status: "idle", activity: "ready" }))).toBe("")
    expect(chipText(mount({ status: "error", exited: true, activity: "exited:1" }))).toBe("Terminata (codice 1)")
    expect(chipText(mount({ status: "error", activity: "startFailed" }))).toBe("Avvio fallito")
  })

  test("a suspended session says «Sospesa» once, not «Sospesa · Sospesa»", () => {
    const pane = mount({ status: "idle", activity: "suspended" })
    expect(pane.dataset.state).toBe("off")
    expect(pane.querySelector(".lbl")?.textContent).toBe("Sospesa")
    expect(chipText(pane)).toBe("")
  })

  test("the chip is named for assistive technology, as an image with the full sentence", () => {
    const chip = mount({ status: "working" }).querySelector(".a-state")!
    expect(chip.getAttribute("role")).toBe("img")
    expect(chip.getAttribute("aria-label")).toBe("Al lavoro: Al lavoro")
  })
})

describe("a finished session is one state in the sidebar and in its pane (DS-1)", () => {
  test("done and exited reads «Chiusa» in the pane and the same in the sidebar's icon", () => {
    const pane = mount({ status: "done", exited: true })
    expect(pane.dataset.state).toBe("closed")
    const host = document.createElement("div")
    document.body.append(host)
    const stop = render(
      () =>
        createComponent(Sidebar, {
          workspaces: [
            {
              id: "w",
              name: "Progetto",
              path: "C:/p",
              sessions: [
                { id: "s1", title: "Finita", status: "done", workspaceId: "w", agent: "claude-code" },
                { id: "s2", title: "Pronta", status: "idle", workspaceId: "w", agent: "claude-code" },
                { id: "s3", title: "Sospesa", status: "idle", workspaceId: "w", agent: "claude-code", suspended: true },
              ],
            },
          ],
        }),
      host,
    )
    try {
      const states = new Map(
        [...host.querySelectorAll<HTMLElement>('[data-slot="agent-status-dot"]')].map((dot) => [
          dot.closest("button")?.textContent?.includes("Finita")
            ? "done"
            : dot.closest("button")?.textContent?.includes("Sospesa")
              ? "suspended"
              : "idle",
          dot,
        ]),
      )
      expect(states.get("done")?.dataset.state).toBe("closed")
      expect(states.get("done")?.getAttribute("aria-label")).toBe("Stato: Chiusa")
      expect(states.get("idle")?.dataset.state).toBe("idle")
      expect(states.get("suspended")?.dataset.state).toBe("off")
      // Every icon is a named image holding a drawn shape.
      for (const dot of states.values()) {
        expect(dot.getAttribute("role")).toBe("img")
        expect(dot.querySelector("svg.ic")).not.toBeNull()
      }
    } finally {
      stop()
    }
  })
})

describe("the header keeps four things and the card keeps the rest (DS-19)", () => {
  const facts: Partial<SessionPaneProps> = {
    status: "working",
    mode: "auto",
    tokens: "678,6M token",
    cost: "$67,32",
    tree: { branch: "ade/stati-unici", fidelity: "stale", note: "dal commit" },
  }

  test("title, state, cost and buttons are in the pill; quota, mode, folder and tokens are in the card", () => {
    const pane = mount(facts)
    const card = pane.querySelector('[data-slot="pane-card"]')!
    const outside = (selector: string) => [...pane.querySelectorAll(selector)].filter((one) => !card.contains(one))
    expect(pane.querySelector('[data-slot="pane-title"]')?.textContent).toBe("Sessione")
    expect(outside('[data-slot="pane-cost"]').map((one) => one.textContent)).toEqual(["$67,32"])
    expect(outside(".a-state").length).toBe(1)
    for (const selector of ['[data-slot="pane-mode"]', '[data-slot="pane-tokens"]', '[data-slot="pane-tree"]']) {
      expect([selector, outside(selector).length, card.querySelectorAll(selector).length]).toEqual([selector, 0, 1])
    }
    // The mode wears its name, and the cost is listed in the card too.
    expect(card.textContent).toContain("modalità")
    expect(card.querySelector('[data-slot="pane-cost-card"]')?.textContent).toBe("$67,32")
  })

  test("without a fact the trigger is not drawn; the trigger is a real button that does not take the keyboard", () => {
    expect(mount({ status: "idle" }).querySelector('[data-slot="pane-info-trigger"]')).toBeNull()
    dispose?.()
    const trigger = mount(facts).querySelector<HTMLButtonElement>('[data-slot="pane-info-trigger"]')!
    expect(trigger.tagName).toBe("BUTTON")
    expect(trigger.getAttribute("aria-label")).toBe("Dettagli della sessione")
    expect(trigger.getAttribute("aria-describedby")).toBe(
      document.querySelector('[data-slot="pane-card"]')?.getAttribute("id") ?? null,
    )
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    trigger.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  })

  test("no collapse rule hides anything inside the card, at any width", () => {
    const pane = mount({ ...facts, quota: undefined })
    const card = pane.querySelector('[data-slot="pane-card"]')!
    const hidden: string[] = []
    // The check can see: the card and its rows are matched by rules, some of them inside a container query.
    expect(rulesFor(paneCss, card).length).toBeGreaterThan(0)
    expect(rulesFor(paneCss, card.querySelector('[data-slot="pane-tokens"]')!).length).toBeGreaterThan(0)
    for (const element of card.querySelectorAll("*")) {
      for (const rule of rulesFor(paneCss, element)) {
        if (/display\s*:\s*none/.test(rule.body) && rule.at.length > 0 && !/\.card/.test(rule.selector)) {
          hidden.push(`${element.getAttribute("data-slot") ?? element.className} ← ${rule.at.join(" ")} ${rule.selector}`)
        }
      }
    }
    expect(hidden).toEqual([])
  })

  test("the cost stays in the pill down to 300px, and only then moves to the card", () => {
    const cost = mount(facts).querySelector('[data-slot="pane-cost"]:not([data-slot="pane-cost-card"])')!
    const hiding = rulesFor(paneCss, cost).filter((rule) => /display\s*:\s*none/.test(rule.body))
    const widths = hiding.map((rule) => Number(/max-width:\s*(\d+)px/.exec(rule.at.join(" "))?.[1] ?? Infinity))
    expect(widths.length).toBeGreaterThan(0)
    expect(Math.max(...widths)).toBeLessThanOrEqual(300)
  })
})

describe("Escape closes the card once and then belongs to the agent again (R2)", () => {
  test("the first Escape is taken and closes the card; a second one, pointer still on the icon, is not", () => {
    const pane = mount({ status: "working", mode: "auto", tokens: "1M token" })
    const info = pane.querySelector<HTMLElement>('[data-slot="pane-info"]')!
    // happy-dom does not track :hover; the pointer is on the icon.
    info.matches = () => true
    const press = () => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      return event
    }
    expect(press().defaultPrevented).toBe(true)
    expect(info.hasAttribute("data-dismissed")).toBe(true)
    expect(press().defaultPrevented).toBe(false)
    // The pointer leaves: the card may open again, and the next Escape is taken again.
    info.dispatchEvent(new Event("pointerleave"))
    expect(info.hasAttribute("data-dismissed")).toBe(false)
    expect(press().defaultPrevented).toBe(true)
  })

  test("with the card closed by nothing but absence of hover, Escape is left alone", () => {
    const pane = mount({ status: "working", mode: "auto" })
    pane.querySelector<HTMLElement>('[data-slot="pane-info"]')!.matches = () => false
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe("the light pill is grounded in a crema step (DS-24)", () => {
  test("the rule that wins the pill's background is the one with the crema step", () => {
    const pane = mount({ status: "idle" })
    const header = pane.querySelector<HTMLElement>('[data-slot="pane-header"]')!
    const win = winner(paneCss, header, "background")
    expect(win?.selector).toBe(".pill.hA")
    expect(win?.body).toContain("light-dark(var(--ade-surface), var(--ade-raised)) 92%")
  })

  test("the focused pane's ring is the same border step, not a weaker one", () => {
    const pane = mount({ status: "idle", focused: true })
    const header = pane.querySelector<HTMLElement>('[data-slot="pane-header"]')!
    const win = winner(paneCss, header, "box-shadow")
    expect(win?.body).toContain("light-dark(var(--ade-border), var(--ade-border-subtle))")
  })
})

describe("«needs you» is blue in the bar and in the chat too (DS-1)", () => {
  test("the Decisions and Design counts, the attention dot and a waiting chat session wear the state's blue", () => {
    const badge = parseCss(pillTabsCss).filter((rule) => /ade-pill-badge/.test(rule.selector) && /data-family/.test(rule.selector))
    expect(badge.map((rule) => rule.selector).sort()).toEqual([
      '[data-family="decisions"] [data-slot="ade-pill-badge"]',
      '[data-family="design"] [data-slot="ade-pill-badge"]',
    ])
    for (const rule of badge) {
      expect(rule.body).toContain("background: var(--ade-state-perm)")
      expect(rule.body).toContain("color: var(--ade-on-status)")
    }
    const dot = parseCss(pillTabsCss).find((rule) => rule.selector === '[data-slot="ade-pill-dot"]' && rule.at.length === 0)
    expect(dot?.body).toContain("background: var(--ade-state-perm)")
    const chat = parseCss(chatCss).find((rule) => rule.selector === '[data-slot="chat-session-mark"][data-kind="waiting"]')
    expect(chat?.body).toContain("color: var(--ade-state-perm)")
  })

  test("no state mark in the bar is pomodoro or ochre", () => {
    for (const rule of parseCss(pillTabsCss).filter((one) => /ade-pill-(badge|dot)/.test(one.selector))) {
      expect(rule.body).not.toMatch(/--ade-(accent|warning|working)/)
    }
  })
})
