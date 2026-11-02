import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, mapArray } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { TranscriptLine } from "../grid/pane"
import { createLineWriter, withLines } from "./pane-lines"

const MAX = 200
const WORKBENCH = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")

/** The transcript's store, wired as the workbench wires it, with what the pane's `<For>` and the autosave react to. */
function transcript(start: number) {
  const lines: TranscriptLine[] = Array.from({ length: start }, (_, i) => ({ kind: "step", text: `vecchia ${i}` }))
  const [store, setStore] = createStore({ panes: [{ id: "p", lines }] })
  const runs = { list: 0, rows: 0, length: 0, writes: 0 }
  const writer = createLineWriter<TranscriptLine>((id, added) => {
    runs.writes++
    setStore(
      produce((w) => {
        const pane = w.panes.find((p) => p.id === id)
        if (!pane) return
        const next = withLines(unwrap(pane.lines), added, MAX)
        if (next) pane.lines = next
      }),
    )
  })
  const dispose = createRoot((off) => {
    const mapped = mapArray(
      () => store.panes[0].lines,
      (line) => {
        runs.rows++
        return line.text
      },
    )
    createComputed(() => {
      runs.list++
      mapped()
    })
    createComputed(() => {
      runs.length++
      void store.panes[0].lines.length
    })
    return off
  })
  const reset = () => {
    runs.list = runs.rows = runs.length = runs.writes = 0
  }
  reset()
  return { store, writer, runs, reset, dispose }
}

const chunkOf = (count: number, from = 0): TranscriptLine[] =>
  Array.from({ length: count }, (_, i) => ({ kind: "step", text: `L${from + i}` }))

function feed(t: ReturnType<typeof transcript>, lines: TranscriptLine[]) {
  t.writer.together(() => {
    for (const line of lines) t.writer.add("p", line)
  })
}

describe("a flood's chunk, written to the transcript", () => {
  test("one write and one redraw for a chunk of 2560 lines, not 2560", () => {
    const t = transcript(0)
    feed(t, chunkOf(2560))
    expect(t.runs).toEqual({ writes: 1, list: 1, rows: MAX, length: 1 })
    t.dispose()
  })

  test("the cost of a chunk does not grow with the transcript: the same on a full one as on an empty one", () => {
    const empty = transcript(0)
    feed(empty, chunkOf(2560))
    const full = transcript(MAX)
    feed(full, chunkOf(2560))
    expect(full.runs).toEqual(empty.runs)
    empty.dispose()
    full.dispose()
  })

  test("what stays is the end of the output, in order: the tail of a program is there", () => {
    const t = transcript(150)
    feed(t, chunkOf(2560))
    const texts = t.store.panes[0].lines.map((line) => line.text)
    expect(texts).toHaveLength(MAX)
    expect(texts[0]).toBe("L2360")
    expect(texts.at(-1)).toBe("L2559")
    t.dispose()
  })

  test("a short chunk keeps the lines before it", () => {
    const t = transcript(150)
    feed(t, chunkOf(3))
    const texts = t.store.panes[0].lines.map((line) => line.text)
    expect(texts).toHaveLength(153)
    expect(texts[0]).toBe("vecchia 0")
    expect(texts.slice(-3)).toEqual(["L0", "L1", "L2"])
    t.dispose()
  })

  test("a frame redrawn is one entry, within a chunk and across two", () => {
    const t = transcript(0)
    feed(t, [
      { kind: "step", text: "a" },
      { kind: "step", text: "a" },
      { kind: "step", text: "b" },
    ])
    t.reset()
    feed(t, [{ kind: "step", text: "b" }])
    expect(t.store.panes[0].lines.map((line) => line.text)).toEqual(["a", "b"])
    // Nothing new is no redraw.
    expect(t.runs.list).toBe(0)
    t.dispose()
  })

  test("a line added outside a chunk is written at once: an ADE note reads as it did", () => {
    const t = transcript(0)
    t.writer.add("p", { kind: "note", text: "nota" })
    expect(t.store.panes[0].lines.map((line) => line.text)).toEqual(["nota"])
    t.dispose()
  })

  test("a note written while a chunk is read keeps its place among the lines", () => {
    const t = transcript(0)
    t.writer.together(() => {
      t.writer.add("p", { kind: "step", text: "uno" })
      t.writer.add("p", { kind: "note", text: "nota" })
      t.writer.add("p", { kind: "step", text: "due" })
    })
    expect(t.store.panes[0].lines.map((line) => line.text)).toEqual(["uno", "nota", "due"])
    t.dispose()
  })

  test("two panes in one chunk: each gets its own lines", () => {
    const written: Array<[string, string[]]> = []
    const writer = createLineWriter<string>((id, lines) => written.push([id, lines]))
    writer.together(() => {
      writer.add("a", "1")
      writer.add("b", "2")
      writer.add("a", "3")
    })
    expect(written).toEqual([
      ["a", ["1", "3"]],
      ["b", ["2"]],
    ])
  })

  test("a chunk that throws still writes what was read, and the next line is not held for ever", () => {
    const written: string[][] = []
    const writer = createLineWriter<string>((_, lines) => written.push(lines))
    expect(() =>
      writer.together(() => {
        writer.add("a", "letta")
        throw new Error("detector")
      }),
    ).toThrow("detector")
    writer.add("a", "dopo")
    expect(written).toEqual([["letta"], ["dopo"]])
  })

  test("together inside together writes once, at the end of the outer one", () => {
    const written: string[][] = []
    const writer = createLineWriter<string>((_, lines) => written.push(lines))
    writer.together(() => {
      writer.add("a", "1")
      writer.together(() => writer.add("a", "2"))
      expect(written).toEqual([])
    })
    expect(written).toEqual([["1", "2"]])
  })

  test("lint: both of the workbench's panes read their chunks together", () => {
    const sites = WORKBENCH.split("host.spawn({").slice(1).map((site) => site.slice(0, site.indexOf("onExit:")))
    const panes = sites.filter((site) => site.includes("feedTerminal(paneId, chunk, written)"))
    expect(panes.length).toBe(2)
    for (const site of panes) expect(site).toContain("linesTogether: paneLines.together")
  })
})
