import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useFilteredList } from "./use-filtered-list"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The list has to follow its inputs, not just its filter.
 *
 * `items` is a callback the caller writes, and callers read reactive state in
 * it — the agent list, the open terminals, recent files. If the resource only
 * re-runs when the filter string changes, anything that becomes available while
 * the popover is closed or open is invisible until the user types, and a menu
 * opened on an empty query never updates at all.
 */
describe("useFilteredList", () => {
  test("re-resolves when a signal read inside `items` changes", async () => {
    await createRoot(async (dispose) => {
      const [extra, setExtra] = createSignal<string[]>([])
      let calls = 0
      const list = useFilteredList<string>({
        items: async () => {
          calls += 1
          return ["always", ...extra()]
        },
        key: (x) => x ?? "",
      })
      await settle()
      expect(list.flat()).toEqual(["always"])

      setExtra(["appeared"])
      await settle()

      expect(calls).toBeGreaterThan(1)
      expect(list.flat()).toEqual(["always", "appeared"])
      dispose()
    })
  })

  test("still re-resolves when the filter changes", async () => {
    await createRoot(async (dispose) => {
      const list = useFilteredList<string>({ items: async () => ["alpha", "beta"], key: (x) => x ?? "" })
      await settle()
      expect(list.flat()).toHaveLength(2)
      list.onInput("alp")
      await settle()
      expect(list.flat()).toEqual(["alpha"])
      dispose()
    })
  })
})

describe("mixed item types", () => {
  type Item = { type: "agent"; name: string } | { type: "terminal"; id: string } | { type: "file"; path: string }
  const items: Item[] = [
    { type: "agent", name: "reviewer" },
    { type: "terminal", id: "pty_1" },
    { type: "file", path: "src/index.ts" },
  ]
  const key = (x: Item | undefined) =>
    !x ? "" : x.type === "agent" ? `a:${x.name}` : x.type === "terminal" ? `t:${x.id}` : `f:${x.path}`

  test("every type survives grouping and reaches the flat list", async () => {
    await createRoot(async (dispose) => {
      const list = useFilteredList<Item>({
        items: async () => items,
        key,
        groupBy: (x) => x.type,
        sortGroupsBy: (a, b) => {
          const rank = (c: string) => (c === "agent" ? 0 : c === "terminal" ? 1 : 2)
          return rank(a.category) - rank(b.category)
        },
      })
      await settle()
      expect(list.flat().map(key)).toEqual(["a:reviewer", "t:pty_1", "f:src/index.ts"])
      dispose()
    })
  })

  test("a group ordered by a comparator that does not know it is not dropped", async () => {
    // The comparator ranks unknown categories last rather than throwing; a group
    // it has never heard of has to still be listed.
    await createRoot(async (dispose) => {
      const list = useFilteredList<Item>({
        items: async () => items,
        key,
        groupBy: (x) => x.type,
        sortGroupsBy: (a, b) => (a.category === "agent" ? -1 : b.category === "agent" ? 1 : 0),
      })
      await settle()
      expect(list.flat()).toHaveLength(3)
      dispose()
    })
  })

  test("filtering by a key one type lacks does not delete that type silently", async () => {
    // `filterKeys: ["display"]` is what the composer passes. A type without a
    // `display` field would vanish from every non-empty query.
    await createRoot(async (dispose) => {
      const withDisplay = items.map((x) => ({ ...x, display: key(x) }))
      const list = useFilteredList<(typeof withDisplay)[number]>({
        items: async () => withDisplay,
        key: (x) => (x ? key(x as Item) : ""),
        filterKeys: ["display"],
      })
      await settle()
      expect(list.flat()).toHaveLength(3)
      list.onInput("pty")
      await settle()
      expect(list.flat().map((x) => x.type)).toEqual(["terminal"])
      dispose()
    })
  })
})
