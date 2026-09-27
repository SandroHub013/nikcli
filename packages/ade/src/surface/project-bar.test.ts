import { expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * The bar's line of facts names the version of ADE, because that is the one the
 * user is looking at: it read «v1.399.0 · 12 SESSIONI», and 1.399.0 is nikcli's.
 * One version in the text, and it is ADE's. nikcli's does not disappear: it is
 * what you want in the tooltip when a session misbehaves and you have to say
 * which program started it.
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
  return {
    text: meta?.textContent ?? "",
    title: meta?.querySelector('[data-slot="ade-meta-item"]')?.getAttribute("title") ?? "",
    done: () => {
      dispose()
      host.remove()
    },
  }
}

test("the version in the bar's text is ADE's", () => {
  const bar = mount({
    project,
    adeVersion: "1.2.3",
    nikcliVersion: "v1.399.0",
    sessions: 12,
  })
  try {
    expect([bar.text, bar.text.includes("1.2.3")]).toEqual([bar.text, true])
    expect([bar.text, bar.text.includes("1.399.0")]).toEqual([bar.text, false])
  } finally {
    bar.done()
  }
})

test("nikcli's version is in the tooltip, where it is needed", () => {
  const bar = mount({
    project,
    adeVersion: "1.2.3",
    nikcliVersion: "v1.399.0",
    sessions: 12,
  })
  try {
    expect([bar.title, bar.title.includes("1.399.0")]).toEqual([bar.title, true])
  } finally {
    bar.done()
  }
})

test("with no ADE to name, the bar says no version rather than nikcli's", () => {
  const bar = mount({ project, nikcliVersion: "v1.399.0", sessions: 12 })
  try {
    expect([bar.text, bar.text.includes("1.399.0")]).toEqual([bar.text, false])
    expect([bar.text, bar.text.includes("12 sessioni")]).toEqual([bar.text, true])
  } finally {
    bar.done()
  }
})
