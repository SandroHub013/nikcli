import { expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * A link to a file already open moves its cursor (audit 0.7.7, MEDIO 12).
 *
 * `openFile` found the pane and wrote a new `fileGoTo`, the focus moved, and
 * the cursor did not. Each piece on its own passed a new goTo along; only the
 * whole chain — the workbench store written by `reconcile`, the pane renderer,
 * FilePane, Editor — lost it, so the chain is what is mounted here.
 */
compileSolidJsx()
const { createRoot, For } = await import("solid-js")
const { createStore } = await import("solid-js/store")
const { createComponent, render } = await import("solid-js/web")
const { createPaneRenderer } = await import("./pane-renderer")
const { createPaneRecords } = await import("./pane-records")
const { addPane, createWorkbench, updatePane } = await import("./state")
const { writeWorkbench } = await import("./workbench-write")

type Workbench = ReturnType<typeof createWorkbench>

/** Every dependency the file pane does not use: a function that does nothing. */
const unused = new Proxy({}, { get: () => () => undefined })

const frames = () => new Promise((resolve) => setTimeout(resolve, 50))

/**
 * One file pane, mounted the way the workbench mounts it: the store written by
 * `writeWorkbench`, the pane renderer, FilePane, Editor. `link` does what
 * `openFile` does for a file already open.
 */
function mountFile(path: string, fileGoTo?: { line: number; at: number }) {
  const moved: number[] = []
  const original = HTMLTextAreaElement.prototype.setSelectionRange
  HTMLTextAreaElement.prototype.setSelectionRange = function (start: number) {
    moved.push(start)
  }
  const text = "a\nb\nc\nd\ne\n"
  const records = createPaneRecords()
  records.buffers.set("f1", { path, saved: text, draft: text, dirty: false } as never)
  const host = document.createElement("div")
  document.body.append(host)
  let setWb!: (next: (current: Workbench) => Workbench) => void
  const dispose = createRoot((dispose) => {
    const [store, setStore] = createStore<Workbench>(
      addPane(createWorkbench(), {
        id: "f1",
        title: path,
        status: "done",
        model: "—",
        mode: "file",
        filePath: path,
        ...(fileGoTo ? { fileGoTo } : {}),
        lines: [],
        workspaceId: "workspace",
      } as never),
    )
    setWb = (next) => writeWorkbench(store, setStore, next)
    const panes = createPaneRenderer({
      ...unused,
      wb: () => store,
      setWb,
      project: () => undefined,
      records,
      panels: unused,
      pluginRuntime: { registry: { open: () => [] } },
      liveTerminals: () => new Set(),
      mailWaiting: () => ({}),
      browserControllers: new Map(),
    } as never)
    render(
      () => createComponent(For, { get each() { return panes() }, children: (pane: { render: () => unknown }) => pane.render() } as never),
      host,
    )
    return dispose
  })
  return {
    moved,
    link: async (line: number, at: number) => {
      setWb((w) => ({ ...updatePane(w, "f1", { fileGoTo: { line, at } }), focusedId: "f1" }))
      await frames()
    },
    showsText: () => host.querySelector("textarea") !== null,
    toggle: async () => {
      host.querySelector<HTMLButtonElement>('[data-slot="pane-view-toggle"]')!.click()
      await frames()
    },
    unmount: () => {
      dispose()
      host.remove()
      HTMLTextAreaElement.prototype.setSelectionRange = original
    },
  }
}

test("a second link to an open file moves the editor's cursor to its line", async () => {
  const pane = mountFile("C:/p/x.ts", { line: 2, at: 1 })
  try {
    await frames()
    await pane.link(4, 2)
    // And the same line again, clicked later: a new goTo too.
    await pane.link(4, 3)
  } finally {
    pane.unmount()
  }
  // Lines 2 and 4 start at offsets 2 and 6.
  expect(pane.moved).toEqual([2, 6, 6])
})

test("every link with a line turns a markdown preview back to its text, not only the first", async () => {
  const pane = mountFile("C:/p/notes.md")
  const seen: boolean[] = []
  try {
    await frames()
    await pane.toggle()
    seen.push(pane.showsText())
    await pane.link(3, 2)
    seen.push(pane.showsText())
    // The reader goes back to the preview; the next link brings the text again.
    await pane.toggle()
    seen.push(pane.showsText())
    await pane.link(5, 3)
    seen.push(pane.showsText())
  } finally {
    pane.unmount()
  }
  expect(seen).toEqual([false, true, false, true])
})
