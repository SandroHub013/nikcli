import { expect, test } from "bun:test"
import { compileSolidJsx } from "../../test-support/solid-jsx"

/* The vial as the buttons mount it: one canvas, hidden from assistive tech, and the family's tube told the count. */
compileSolidJsx()
const { createRoot, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VialMark } = await import("./vial-mark")
const { resetVialsForTests, vialFor } = await import("./sim")

test("mounts a canvas per button and passes count changes to its tube", async () => {
  resetVialsForTests()
  const host = document.createElement("div")
  document.body.append(host)
  let setCount!: (n: number) => void
  const dispose = createRoot((dispose) => {
    const [count, set] = createSignal(2)
    setCount = set
    render(() => VialMark({ fam: "design", get count() { return count() }, theme: "dark" }), host)
    return dispose
  })
  try {
    const canvas = host.querySelector<HTMLCanvasElement>('canvas[data-slot="vial"]')
    expect(canvas?.getAttribute("aria-hidden")).toBe("true")
    expect(canvas?.dataset.fam).toBe("design")
    // The first count is taken as it is; the next is an arrival.
    expect(vialFor("design", 2, false).drops).toHaveLength(0)
    setCount(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const vial = vialFor("design", 3, false)
    expect(vial.N).toBe(3)
    expect(vial.drops).toHaveLength(1)
  } finally {
    dispose()
    host.remove()
  }
})
