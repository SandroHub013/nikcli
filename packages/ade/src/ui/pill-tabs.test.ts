import { afterEach, describe, expect, test } from "bun:test"
import { createComponent, render } from "solid-js/web"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { PillTabs } = await import("./pill-tabs")
type PillTabItem = import("./pill-tabs").PillTabItem

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})

describe("PillTabs", () => {
  test("renders tablist with role=tab and aria-selected for navigation tabs", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const items: PillTabItem[] = [
      { id: "agent", label: "Agent" },
      { id: "code", label: "Code" },
      { id: "chat", label: "Chat" },
    ]

    let selected: string | undefined
    cleanup = render(
      () =>
        createComponent(PillTabs, {
          role: "tab",
          ariaLabel: "Viste",
          items,
          active: "code",
          onSelect: (id: string) => {
            selected = id
          },
        }),
      root,
    )

    const container = root.querySelector('[data-slot="ade-views"]') as HTMLElement
    expect(container).not.toBeNull()
    expect(container.getAttribute("role")).toBe("tablist")
    expect(container.getAttribute("aria-label")).toBe("Viste")

    const buttons = root.querySelectorAll('button[data-slot="ade-view-tab"]')
    expect(buttons.length).toBe(3)

    const [agent, code] = [...buttons] as HTMLButtonElement[]
    expect(agent.getAttribute("role")).toBe("tab")
    expect(agent.getAttribute("aria-selected")).toBe("false")
    expect(agent.hasAttribute("data-active")).toBe(false)
    expect(agent.textContent).toBe("Agent")

    expect(code.getAttribute("role")).toBe("tab")
    expect(code.getAttribute("aria-selected")).toBe("true")
    expect(code.getAttribute("data-active")).toBe("true")
    expect(code.hasAttribute("aria-haspopup")).toBe(false)

    agent.click()
    expect(selected).toBe("agent")
  })

  test("renders group with role=button, aria-pressed, and dialog popup for queue controls", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const items: PillTabItem[] = [
      {
        id: "decisions",
        label: "Decisioni",
        shortLabel: "Dec",
        badge: 2,
        attention: true,
        active: true,
        title: "Decisioni, 2 per te",
        ariaLabel: "Decisioni, 2 per te",
      },
      {
        id: "design",
        label: "Design",
        shortLabel: "Design",
        badge: 0,
        attention: false,
        active: false,
        title: "Design",
        ariaLabel: "Design",
      },
    ]

    let selected: string | undefined
    cleanup = render(
      () =>
        createComponent(PillTabs, {
          role: "button",
          ariaLabel: "Decisioni · Design",
          items,
          onSelect: (id: string) => {
            selected = id
          },
        }),
      root,
    )

    const container = root.querySelector('[data-slot="ade-views"]') as HTMLElement
    expect(container.getAttribute("role")).toBe("group")
    expect(container.getAttribute("aria-label")).toBe("Decisioni · Design")

    const [dec, des] = [...root.querySelectorAll('button[data-slot="ade-view-tab"]')] as HTMLButtonElement[]

    // Decisioni: active, badge 2, attention dot
    expect(dec.getAttribute("role")).toBe("button")
    expect(dec.getAttribute("aria-pressed")).toBe("true")
    expect(dec.getAttribute("aria-haspopup")).toBe("dialog")
    expect(dec.getAttribute("data-active")).toBe("true")
    expect(dec.getAttribute("data-attention")).toBe("true")
    expect(dec.getAttribute("title")).toBe("Decisioni, 2 per te")
    expect(dec.getAttribute("aria-label")).toBe("Decisioni, 2 per te")

    const dot = dec.querySelector('[data-slot="ade-pill-dot"]')
    expect(dot).not.toBeNull()

    const badgeDec = dec.querySelector('[data-slot="ade-pill-badge"]')
    expect(badgeDec?.textContent).toBe("2")

    const fullLabel = dec.querySelector('[data-slot="ade-pill-label-full"]')
    const shortLabel = dec.querySelector('[data-slot="ade-pill-label-short"]')
    expect(fullLabel?.textContent).toBe("Decisioni")
    expect(shortLabel?.textContent).toBe("Dec")

    // Design: inactive, badge 0 (hidden), no attention dot
    expect(des.getAttribute("role")).toBe("button")
    expect(des.getAttribute("aria-pressed")).toBe("false")
    expect(des.hasAttribute("data-active")).toBe(false)
    expect(des.hasAttribute("data-attention")).toBe(false)
    expect(des.querySelector('[data-slot="ade-pill-dot"]')).toBeNull()
    expect(des.querySelector('[data-slot="ade-pill-badge"]')).toBeNull()

    des.click()
    expect(selected).toBe("design")
  })

  test("does not show badge when badge is 0 or undefined", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const items: PillTabItem[] = [
      { id: "decisions", label: "Decisioni", badge: 0 },
      { id: "design", label: "Design" },
    ]

    cleanup = render(
      () =>
        createComponent(PillTabs, {
          role: "button",
          ariaLabel: "Queue",
          items,
          onSelect: () => {},
        }),
      root,
    )

    const badges = root.querySelectorAll('[data-slot="ade-pill-badge"]')
    expect(badges.length).toBe(0)
  })

  test("preserves button DOM nodes and activeElement when items are replaced with new object instances (Index)", async () => {
    const { createSignal } = await import("solid-js")
    const root = document.createElement("div")
    document.body.append(root)

    const [items, setItems] = createSignal<PillTabItem[]>([
      { id: "decisions", label: "Decisioni", badge: 1 },
      { id: "design", label: "Design", badge: 0 },
    ])

    cleanup = render(
      () =>
        createComponent(PillTabs, {
          role: "button",
          dataSlot: "ade-pill-tabs",
          ariaLabel: "Queue",
          get items() {
            return items()
          },
          onSelect: () => {},
        }),
      root,
    )

    const container = root.querySelector('[data-slot="ade-pill-tabs"]') as HTMLElement
    expect(container).not.toBeNull()
    const initialButtons = [...root.querySelectorAll('button[data-slot="ade-pill-tab"]')] as HTMLButtonElement[]
    expect(initialButtons.length).toBe(2)

    initialButtons[0].focus()
    expect(document.activeElement).toBe(initialButtons[0])

    // Replace items with completely new object references
    setItems([
      { id: "decisions", label: "Decisioni", badge: 2 },
      { id: "design", label: "Design", badge: 1 },
    ])

    const updatedButtons = [...root.querySelectorAll('button[data-slot="ade-pill-tab"]')] as HTMLButtonElement[]
    expect(updatedButtons.length).toBe(2)
    // Same DOM node instances (preserved via Index)
    expect(updatedButtons[0]).toBe(initialButtons[0])
    expect(updatedButtons[1]).toBe(initialButtons[1])
    // Focus is preserved
    expect(document.activeElement).toBe(initialButtons[0])

    // Values inside updated reactively
    expect(updatedButtons[0].querySelector('[data-slot="ade-pill-badge"]')?.textContent).toBe("2")
    expect(updatedButtons[1].querySelector('[data-slot="ade-pill-badge"]')?.textContent).toBe("1")
  })
})
