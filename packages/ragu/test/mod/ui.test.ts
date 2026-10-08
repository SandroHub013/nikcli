import { describe, expect, it } from "bun:test"
import { ModUi } from "@/mod/ui"

describe("ModUi.builders", () => {
  const { Box, Text, Button, Input, Select, Link, Code, Markdown } = ModUi.builders()

  it("builds plain data: props first or children first, and a key moves out of props", () => {
    expect(Text("hello")).toEqual({ type: "Text", props: {}, children: ["hello"] })
    expect(Text({ bold: true, key: "t" }, "hi", " there")).toEqual({
      type: "Text",
      key: "t",
      props: { bold: true },
      children: ["hi", " there"],
    })
    expect(Box({ gap: 1 }, Text("a"), Text("b"))).toEqual({
      type: "Box",
      props: { gap: 1 },
      children: [
        { type: "Text", props: {}, children: ["a"] },
        { type: "Text", props: {}, children: ["b"] },
      ],
    })
    expect(Button({ key: "go", label: "Go" })).toEqual({ type: "Button", key: "go", props: { label: "Go" } })
    // An element as the first argument is a child, not props.
    expect((Box(Text("only")) as { children: unknown[] }).children).toEqual([
      { type: "Text", props: {}, children: ["only"] },
    ])
  })

  it("flattens arrays of children, so a map result can be passed directly", () => {
    const rows = ["a", "b"].map((name) => Text(name))
    expect((Box({}, rows as never) as { children: unknown[] }).children).toHaveLength(2)
  })

  it("makes nothing executable: a tree survives JSON unchanged", () => {
    const tree = Box(
      { gap: 1 },
      Text({ color: "success" }, "ok"),
      Button({ key: "x", label: "X" }),
      Link({ href: "https://a.b" }),
      Code({ text: "1" }),
      Markdown({ text: "# h" }),
      Input({ key: "i" }),
      Select({ key: "s", options: [{ value: "a" }] }),
    )
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree)
  })
})

describe("ModUi.validate", () => {
  const { Box, Text, Button, Input, Select } = ModUi.builders()

  it("accepts a normal tree, strings, numbers and holes", () => {
    expect(
      ModUi.validate(Box({}, Text("hi"), null, false, "plain", 3, Button({ key: "k", label: "L" }))),
    ).toBeUndefined()
    expect(ModUi.validate(null)).toBeUndefined()
  })

  it("rejects a tree a client could not draw in bounded time", () => {
    let deep: ModUi.Node = Text("leaf")
    for (let i = 0; i < ModUi.MAX_DEPTH + 2; i++) deep = Box({}, deep)
    expect(ModUi.validate(deep)).toContain("deeper than")

    const wide = Box({}, ...Array.from({ length: ModUi.MAX_NODES + 1 }, () => Text("x")))
    expect(ModUi.validate(wide)).toContain("more than")

    expect(ModUi.validate(Text("x".repeat(ModUi.MAX_TEXT + 1)))).toContain("longer than")
    expect(ModUi.validate({ type: "Markdown", props: { text: "x".repeat(ModUi.MAX_TEXT + 1) } })).toContain(
      "longer than",
    )
  })

  it("rejects shapes that are not elements, controls without a key, and odd colors", () => {
    expect(ModUi.validate({ not: "an element" })).toContain("not an element")
    expect(ModUi.validate({ type: "Script", props: {} })).toContain("unknown element")
    expect(ModUi.validate({ type: "Button", key: "", props: { label: "x" } })).toContain("needs a key")
    expect(ModUi.validate({ type: "Button", key: "k", props: {} })).toContain("needs a label")
    expect(ModUi.validate(Input({}))).toContain("needs a key")
    expect(ModUi.validate(Select({ key: "s" }))).toContain("needs options")
    expect(ModUi.validate(Text({ color: "rgb(0,0,0); drop table" }, "x"))).toContain("color")
  })

  it("treeOf tells a drawing from the event passed through", () => {
    expect(ModUi.treeOf({ tree: Text("a") })).toEqual(Text("a"))
    expect(ModUi.treeOf({ tree: null })).toBeNull()
    expect(ModUi.treeOf({ component: "Pane" })).toBeUndefined()
  })
})
