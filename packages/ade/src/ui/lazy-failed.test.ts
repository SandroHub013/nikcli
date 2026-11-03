import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createComponent, render } from "solid-js/web"
import { resetLocaleForTests } from "../i18n"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { lazyComponent } = await import("./lazy-component")

/*
 * prova 4, item 16: a chunk that did not load left a bare box, with a grey
 * «Riprova» on the pane's ground: no frame, no heading, and no «Chiudi», because
 * the pane's own header is inside the module that never arrived, so the pane
 * could be closed only once the chunk came. The failed box now has a frame, a
 * heading, «Riprova» and, when the pane or sheet can be closed, «Chiudi», which
 * closes it without the module.
 */
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})
const mount = (component: () => unknown) => {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(component as () => never, host)
  return host
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("the box of a screen that did not load", () => {
  const Never = lazyComponent<(props: { onClose?: () => void }) => any>(() => Promise.reject(new Error("chunk missing")))

  test("it is a framed box with a heading, «Riprova» and «Chiudi», and «Chiudi» closes without the module", async () => {
    resetLocaleForTests("it")
    let closed = 0
    const host = mount(() => createComponent(Never, { onClose: () => closed++ }))
    await settle()
    const box = host.querySelector('[data-slot="lazy-failed"]')
    expect(box).not.toBeNull()
    expect(box!.getAttribute("data-component")).toBe("lazy-failed")
    expect(box!.querySelector("h3")?.textContent).toBe("Questa schermata non si è caricata.")
    expect(box!.querySelector('[data-slot="lazy-retry"]')?.textContent).toBe("Riprova")
    const close = box!.querySelector<HTMLButtonElement>('[data-slot="lazy-close"]')
    expect(close?.textContent).toBe("Chiudi")
    close!.click()
    expect(closed).toBe(1)
  })

  test("English words too", async () => {
    resetLocaleForTests("en")
    const host = mount(() => createComponent(Never, { onClose: () => {} }))
    await settle()
    expect(host.querySelector('[data-slot="lazy-failed"] h3')?.textContent).toBe("This screen did not load.")
    expect(host.querySelector('[data-slot="lazy-close"]')?.textContent).toBe("Close")
    resetLocaleForTests("it")
  })

  test("a screen with nothing to close has no «Chiudi», only «Riprova»", async () => {
    const host = mount(() => createComponent(Never, {}))
    await settle()
    expect(host.querySelector('[data-slot="lazy-retry"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="lazy-close"]')).toBeNull()
  })

  test("the frame is styled: a sheet of its own, in tokens, not the browser's bare button", () => {
    const css = readFileSync(new URL("./lazy-failed.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    expect(css).toContain('[data-slot="lazy-failed"]')
    expect(css).toMatch(/border:\s*1px solid var\(--ade-border/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
