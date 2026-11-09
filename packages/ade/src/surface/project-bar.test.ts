import { expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * UX2-15: The bar shows ADE's version («ADE 0.18.0») and the CLI on its own
 * item («CLI Ragù Code 1.431.0»), with tooltip «il programma con cui partono le
 * sessioni». «Ragù Code ADE 0.18.0» is shown in About only.
 */
compileSolidJsx()
const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { ProjectBar } = await import("./project-bar")

const project = { root: "C:/p", name: "p", git: true } as never

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    render(() => ProjectBar(props as never), host)
    return dispose
  })
  const meta = host.querySelector('[data-slot="ade-project-meta"]')
  const items = Array.from(meta?.querySelectorAll('[data-slot="ade-meta-item"]') ?? []).map((el) => ({
    text: el.textContent ?? "",
    title: el.getAttribute("title") ?? "",
  }))
  return {
    meta,
    text: meta?.textContent ?? "",
    items,
    done: () => {
      dispose()
      host.remove()
    },
  }
}

test("the bar shows ADE's version and the CLI version as separate items (UX2-15)", () => {
  const bar = mount({
    project,
    adeVersion: "1.2.3",
    raguVersion: "v1.399.0",
    sessions: 12,
  })
  try {
    const adeItem = bar.items.find((i) => i.text === "ADE 1.2.3")
    expect(adeItem).toBeDefined()
    expect(adeItem?.title).toBe("")

    const cliItem = bar.items.find((i) => i.text === "CLI Ragù Code 1.399.0")
    expect(cliItem).toBeDefined()
    expect(cliItem?.title).toBe("il programma con cui partono le sessioni")
  } finally {
    bar.done()
  }
})

test("with no CLI version, only ADE is shown", () => {
  const bar = mount({
    project,
    adeVersion: "1.2.3",
    sessions: 12,
  })
  try {
    expect(bar.items.some((i) => i.text.includes("CLI Ragù Code"))).toBe(false)
    expect(bar.items.some((i) => i.text === "ADE 1.2.3")).toBe(true)
  } finally {
    bar.done()
  }
})

test("with no ADE version, CLI is still shown as its own item", () => {
  const bar = mount({ project, raguVersion: "v1.399.0", sessions: 12 })
  try {
    expect(bar.items.some((i) => i.text.startsWith("ADE "))).toBe(false)
    const cliItem = bar.items.find((i) => i.text === "CLI Ragù Code 1.399.0")
    expect(cliItem).toBeDefined()
    expect(cliItem?.title).toBe("il programma con cui partono le sessioni")
    expect(bar.text.includes("12 sessioni")).toBe(true)
  } finally {
    bar.done()
  }
})
