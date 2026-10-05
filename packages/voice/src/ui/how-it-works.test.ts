import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"

/*
 * A `.tsx` cannot be imported under bun test here (no JSX runtime), so the wiring is held
 * on the source; the opening and closing itself is exercised in ADE's tests, which mount
 * the real settings sheet with this component in it.
 */
const source = codeOf(readFileSync(join(import.meta.dir, "how-it-works.tsx"), "utf8"))
const index = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8")

describe("ui/how-it-works", () => {
  test("it starts closed unless the caller asks otherwise", () => {
    expect(source).toContain(codeOf("createSignal(props.defaultOpen ?? false)"))
  })

  test("the button reports the state and controls the panel", () => {
    expect(source).toContain(codeOf("aria-expanded={open()}"))
    // Only while open: from closed it would point at a panel that does not exist.
    expect(source).toContain(codeOf("aria-controls={open() ? `${id}-panel` : undefined}"))
    expect(source).toContain(codeOf("onClick={() => setOpen((value) => !value)}"))
  })

  test("the panel does not exist while closed, and is named by the button", () => {
    expect(source).toContain(codeOf("<Show when={open()}>"))
    expect(source).toContain(codeOf("aria-labelledby={`${id}-toggle`}"))
  })

  test("the caller owns the words: there is no default label in the component", () => {
    expect(source).not.toContain("Come funziona")
    expect(source).toContain(codeOf("title: string"))
  })

  test("it is exported for ADE", () => {
    expect(index).toContain('export { HowItWorks, type HowItWorksProps } from "./ui/how-it-works"')
  })
})
