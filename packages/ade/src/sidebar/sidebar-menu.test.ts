import { afterEach, describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { type Workspace } from "./workspace-tree"

/*
 * The row menu: the right button on a project or session row (sidebar clicks).
 *
 * Two things are being pinned here. The menu is `role="menu"` bound with
 * `bindMenu`, so Esc closes it and the item under the pointer is the one that
 * runs; and the left button keeps doing exactly what it did before — opening
 * a session, toggling a project — because the menu is an addition and not a
 * change of meaning.
 *
 * Every test carries its own ceiling (regola 25).
 */

if (typeof document === "undefined") {
  GlobalRegistrator.register()
}
compileSolidJsx()

const { createRoot } = await import("solid-js")
const { createComponent, render } = await import("solid-js/web")
const { Sidebar } = await import("./sidebar")
const { t } = await import("../i18n")
type SidebarProps = Parameters<typeof Sidebar>[0]

const WORKSPACES: Workspace[] = [
  {
    id: "ws-ade",
    name: "packages/ade",
    sessions: [
      { id: "s1", title: "Layout della griglia", status: "working" },
      { id: "s2", title: "Voce sospesa", status: "done", suspended: true },
    ],
  },
  { id: "ws-desktop", name: "packages/desktop", sessions: [] },
]

function mount(props: Omit<SidebarProps, "workspaces">, workspaces: Workspace[] = WORKSPACES) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    render(() => createComponent(Sidebar, { workspaces, ...props }), host)
    return dispose
  })
  const menu = () => host.querySelector('[data-slot="ade-row-menu"]')
  const labels = () =>
    [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent?.trim() ?? "")
  return {
    host,
    menu,
    labels,
    cleanup: () => {
      dispose()
      host.remove()
      document.body.innerHTML = ""
      localStorage.clear()
    },
  }
}

const rightClick = (element: Element, x = 40, y = 120) => {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

const menuKey = (key: string, init: KeyboardEventInit = {}) => {
  const menu = document.querySelector('[data-slot="ade-row-menu"]')
  ;(menu ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  )
}

afterEach(() => {
  document.body.innerHTML = ""
  localStorage.clear()
})

describe("the session row's menu", () => {
  test("the right button opens it with the verbs wired, and Esc closes it", () => {
    const closeCalls: string[] = []
    const renameCalls: string[] = []
    const view = mount({
      onSelectSession: () => {},
      onRenameSession: (id) => renameCalls.push(id),
      onCloseSession: (id) => closeCalls.push(id),
      onRestartSession: () => {},
      onCopySessionId: () => {},
    })

    const row = view.host.querySelector('[data-slot="session-row"]') as HTMLElement
    expect(row).not.toBeNull()
    rightClick(row)

    expect(view.menu()).not.toBeNull()
    expect(view.menu()!.getAttribute("role")).toBe("menu")
    expect(view.menu()!.getAttribute("aria-label")).toBe(t("sidebar.menu.session"))
    // No "Riprendi": this session is not suspended. No "Riavvia" either: it is
    // at work, and restarting it would do nothing (review sidebar-clic, MEDIO 3).
    expect(view.labels()).toEqual([
      t("sidebar.menu.rename"),
      t("sidebar.menu.close"),
      t("sidebar.menu.copyId"),
      t("sidebar.menu.openSession"),
    ])

    menuKey("Escape")
    expect(view.menu()).toBeNull()
    // Esc is close, not a verb: nothing ran.
    expect(closeCalls).toEqual([])
    expect(renameCalls).toEqual([])

    view.cleanup()
  }, 5000)

  test("a suspended session is offered Riprendi, and only one menu is ever open", () => {
    const view = mount({
      onSelectSession: () => {},
      onResumeSession: () => {},
      onRestartSession: () => {},
      onCloseSession: () => {},
    })

    const rows = view.host.querySelectorAll('[data-slot="session-row"]')
    rightClick(rows[0]!)
    rightClick(rows[1]!)

    expect(view.host.querySelectorAll('[data-slot="ade-row-menu"]')).toHaveLength(1)
    expect(view.labels()).toContain(t("sidebar.menu.resume"))

    view.cleanup()
  }, 5000)

  test("an item runs its verb, with the row's own id, and closes the menu", () => {
    const closeCalls: string[] = []
    const view = mount({ onCloseSession: (id) => closeCalls.push(id) })

    rightClick(view.host.querySelector('[data-slot="session-row"]')!)
    const items = [...view.menu()!.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    const close = items.find((item) => item.textContent?.trim() === t("sidebar.menu.close"))
    expect(close).toBeDefined()

    close!.click()
    expect(closeCalls).toEqual(["s1"])
    expect(view.menu()).toBeNull()

    view.cleanup()
  }, 5000)

  test("the left button still opens the session, and opens no menu", () => {
    const selected: string[] = []
    const view = mount({
      onSelectSession: (id) => selected.push(id),
      onCloseSession: () => {},
    })

    const row = view.host.querySelector('[data-slot="session-row"]') as HTMLElement
    row.click()
    expect(selected).toEqual(["s1"])
    expect(view.menu()).toBeNull()

    view.cleanup()
  }, 5000)

  test("Shift+F10 opens the same menu from the keyboard", () => {
    const view = mount({ onCloseSession: () => {}, onCopySessionId: () => {} })

    const row = view.host.querySelector('[data-slot="session-row"]') as HTMLElement
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }))

    expect(view.menu()).not.toBeNull()
    expect(view.labels()).toEqual([t("sidebar.menu.close"), t("sidebar.menu.copyId")])

    view.cleanup()
  }, 5000)

  test("a row with no verb wired opens no menu at all", () => {
    const view = mount({})

    rightClick(view.host.querySelector('[data-slot="session-row"]')!)
    expect(view.menu()).toBeNull()

    view.cleanup()
  }, 5000)

  /*
   * «Riavvia» was offered on every session, while `reopen` returns at once on
   * one whose process is alive: the verb was there and did nothing (review
   * sidebar-clic, MEDIO 3). It is offered where the pane's own button is.
   */
  test("«Riavvia» is offered only on a session that can be restarted", () => {
    const view = mount({ onRestartSession: () => {}, onCloseSession: () => {} }, [
      {
        id: "ws",
        name: "ws",
        sessions: [
          { id: "s-run", title: "al lavoro", status: "working" },
          { id: "s-done", title: "finita", status: "done" },
          { id: "s-failed", title: "fallita", status: "error" },
          { id: "s-susp", title: "sospesa", status: "done", suspended: true },
        ],
      },
    ])

    const rows = view.host.querySelectorAll('[data-slot="session-row"]')
    const offersRestart = (index: number) => {
      rightClick(rows[index]!)
      return view.labels().includes(t("sidebar.menu.restart"))
    }

    expect(offersRestart(0)).toBe(false)
    expect(offersRestart(1)).toBe(true)
    expect(offersRestart(2)).toBe(true)
    expect(offersRestart(3)).toBe(false)

    view.cleanup()
  }, 5000)

  test("leaving the menu with the keyboard closes it", () => {
    const view = mount({ onCloseSession: () => {} })

    rightClick(view.host.querySelector('[data-slot="session-row"]')!)
    expect(view.menu()).not.toBeNull()

    const outside = document.createElement("button")
    document.body.append(outside)
    const focusout = new FocusEvent("focusout", { bubbles: true, cancelable: true })
    Object.defineProperty(focusout, "relatedTarget", { value: outside })
    view.menu()!.dispatchEvent(focusout)

    expect(view.menu() === null).toBe(true)

    view.cleanup()
  }, 5000)

  test("the left button on the row that opened the menu closes it, and still opens the session", () => {
    const selected: string[] = []
    const view = mount({ onSelectSession: (id) => selected.push(id), onCloseSession: () => {} })

    const row = view.host.querySelector('[data-slot="session-row"]') as HTMLElement
    rightClick(row)
    expect(view.menu()).not.toBeNull()

    row.click()

    expect(view.menu() === null).toBe(true)
    expect(selected).toEqual(["s1"])

    view.cleanup()
  }, 5000)

  test("the keyboard's own context menu does not open the menu a second time", () => {
    const view = mount({ onCloseSession: () => {} })

    const row = view.host.querySelector('[data-slot="session-row"]') as HTMLElement
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }))
    const first = view.menu()
    expect(first).not.toBeNull()

    // What the browser follows with: no pointer behind it, so no coordinates.
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, detail: 0 }),
    )

    expect(view.menu() === first).toBe(true)

    view.cleanup()
  }, 5000)
})

describe("the project row's menu", () => {
  test("offers the project's verbs in order, with a separator before the last", () => {
    const view = mount({
      onNewSession: () => {},
      onSelectProject: () => {},
      onCloseProjectSessions: () => {},
    })

    rightClick(view.host.querySelector('[data-slot="workspace-header"]')!)

    expect(view.menu()!.getAttribute("aria-label")).toBe(t("sidebar.menu.workspace"))
    expect(view.labels()).toEqual([
      t("sidebar.menu.newSession"),
      t("sidebar.menu.openProject"),
      t("sidebar.menu.closeProjectSessions"),
    ])
    expect(view.menu()!.querySelectorAll('[role="separator"]')).toHaveLength(1)

    view.cleanup()
  }, 5000)

  test("an item closes the menu and calls the workbench's own callback", () => {
    let newSession = 0
    const view = mount({ onNewSession: () => (newSession += 1) })

    rightClick(view.host.querySelector('[data-slot="workspace-header"]')!)
    const item = [...view.menu()!.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === t("sidebar.menu.newSession"),
    )
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    expect(newSession).toBe(1)
    expect(view.menu()).toBeNull()

    view.cleanup()
  }, 5000)

  test("the left button still toggles the project, and opens no menu", () => {
    const view = mount({
      onNewSession: () => {},
      onSelectProject: () => {},
      onCloseProjectSessions: () => {},
    })

    const header = view.host.querySelector('[data-slot="workspace-header"]') as HTMLElement
    const before = header.getAttribute("data-expanded")
    header.click()

    expect(header.getAttribute("data-expanded")).not.toBe(before)
    expect(view.menu()).toBeNull()

    view.cleanup()
  }, 5000)
})
