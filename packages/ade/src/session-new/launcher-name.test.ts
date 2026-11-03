import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { Host } from "../host/shell"

/*
 * Live test 3, FAIL 4: at 1440 px the cards of the agents to install showed one letter of the name («G», «O», «F.»),
 * because the «Da installare» chip sat in the same row and took the width. The name comes first: the chip goes under it,
 * inside the same column, so the row is only the glyph and the name at every width the launcher reaches.
 * The pixels (the name really readable at the narrowest cell) are for the eyes.
 */
compileSolidJsx()
const { render } = await import("solid-js/web")
const { SessionNew } = await import("./session-new")

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()?.()
  document.body.replaceChildren()
})

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount(installed: string[]): Promise<HTMLElement> {
  const host = {
    probe: async (command: string) => (installed.includes(command) ? `C:\\bin\\${command}.exe` : null),
    refreshPath: async () => false,
  } as unknown as Host
  const root = document.createElement("div")
  document.body.append(root)
  disposers.push(render(() => SessionNew({ workspace: "demo", os: "linux", loadHost: async () => host }), root))
  await settle()
  return root
}

describe("a card of an agent to install", () => {
  test("carries its «Da installare» chip in the column of the name, not beside it", async () => {
    const root = await mount(["claude"])
    const missing = [...root.querySelectorAll<HTMLElement>('[data-slot="new-agent"][data-availability="assente"]')]
    expect(missing.length).toBeGreaterThan(0)
    for (const card of missing) {
      const chip = card.querySelector('[data-slot="new-agent-missing"]')
      expect(chip).not.toBeNull()
      expect(chip!.parentElement?.dataset.slot).toBe("new-agent-body")
      expect(chip!.closest('[data-slot="new-agent-badge-slot"]')).toBeNull()
      // And the name is still there, first.
      expect(card.querySelector('[data-slot="new-agent-body"]')?.firstElementChild?.getAttribute("data-slot")).toBe(
        "new-agent-label",
      )
    }
  })

  test("an installed card has no chip", async () => {
    const root = await mount(["claude"])
    const claude = root.querySelector('[data-slot="new-agent"][data-agent-id="claude-code"]')!
    expect(claude.querySelector('[data-slot="new-agent-missing"]')).toBeNull()
  })
})

describe("the stylesheet of the cards", () => {
  const css = readFileSync(join(import.meta.dir, "session-new.css"), "utf-8").replace(/\r\n/g, "\n")

  test("lint: the chip does not shrink the name and stays on the left, under it", () => {
    const body = /\[data-slot="new-agent-missing"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(body).toMatch(/align-self:\s*flex-start/)
    expect(body).toMatch(/white-space:\s*nowrap/)
  })
})
