import { afterEach, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { resetLocaleForTests } from "../i18n"

/*
 * A suspended session's pane (P1-C6, point 4): mounted the way the workbench
 * mounts it — the store, the pane renderer, SessionPane — because what it
 * shows is decided between them.
 */
compileSolidJsx()
const { createRoot, For } = await import("solid-js")
const { createStore } = await import("solid-js/store")
const { createComponent, render } = await import("solid-js/web")
const { createPaneRenderer } = await import("./pane-renderer")
const { createPaneRecords } = await import("./pane-records")
const { addPane, createWorkbench } = await import("./state")
const { writeWorkbench } = await import("./workbench-write")

type Workbench = ReturnType<typeof createWorkbench>

const unused = new Proxy({}, { get: () => () => undefined })
const frames = () => new Promise((resolve) => setTimeout(resolve, 50))

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function mountSession(pane: { suspended?: true; status: "idle" | "done"; activity?: string }) {
  resetLocaleForTests("it")
  const calls = { resume: [] as string[], restart: [] as string[] }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    const [store, setStore] = createStore<Workbench>(
      addPane(createWorkbench(), {
        id: "s1",
        title: "Claude",
        model: "claude-code",
        agent: "claude-code",
        mode: "auto",
        resumeId: "5f0c3a52-0000-4000-8000-000000000001",
        lines: [{ kind: "note", text: "testo di prima" }],
        workspaceId: "workspace",
        ...pane,
      }),
    )
    const panes = createPaneRenderer({
      ...unused,
      wb: () => store,
      setWb: (next: (current: Workbench) => Workbench) => writeWorkbench(store, setStore, next),
      project: () => undefined,
      records: createPaneRecords(),
      panels: unused,
      pluginRuntime: { registry: { open: () => [] } },
      liveTerminals: () => new Set(),
      mailWaiting: () => ({}),
      browserControllers: new Map(),
      isRunning: () => false,
      sessionFor: () => undefined,
      suspendCheck: () => ({ ok: false, reason: "notRunning" }),
      resume: (id: string) => void calls.resume.push(id),
      restart: (pane: { id: string }) => void calls.restart.push(pane.id),
    } as never)
    render(
      () => createComponent(For, { get each() { return panes() }, children: (entry: { render: () => unknown }) => entry.render() } as never),
      host,
    )
    return dispose
  })
  cleanup = () => {
    dispose()
    host.remove()
  }
  return { host, calls }
}

test("a suspended pane says Sospesa, offers Riprendi where exited sessions have theirs, and keeps its input off", async () => {
  const { host, calls } = mountSession({ suspended: true, status: "idle", activity: "suspended" })
  await frames()
  expect(host.textContent).toContain("Sospesa")
  expect(host.textContent).toContain("testo di prima")
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="pane-answer"]')]
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Riprendi"])
  const input = host.querySelector<HTMLTextAreaElement>('[data-slot="pane-input"]')
  expect(input?.disabled).toBe(true)
  expect(input?.placeholder).toBe("Riprendi per scrivere")
  buttons[0]!.click()
  expect(calls.resume).toEqual(["s1"])
  expect(calls.restart).toEqual([])
})

test("an exited session that is not suspended keeps its own Riprendi, which restarts it", async () => {
  const { host, calls } = mountSession({ status: "done", activity: "done" })
  await frames()
  expect(host.textContent).not.toContain("Sospesa")
  expect(host.querySelector('[data-slot="pane-input"]')).toBeNull()
  host.querySelector<HTMLButtonElement>('[data-slot="pane-answer"]')!.click()
  expect(calls.restart).toEqual(["s1"])
  expect(calls.resume).toEqual([])
})

test("the header's Sospendi, off, stays visible and says why", async () => {
  const { host } = mountSession({ status: "idle" })
  await frames()
  const button = host.querySelector<HTMLButtonElement>('[data-slot="pane-suspend"]')
  expect(button).not.toBeNull()
  expect(button!.getAttribute("aria-disabled")).toBe("true")
  expect(button!.title).toBe("Sospendi non disponibile: non ha un processo vivo")
})
