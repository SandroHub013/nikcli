import { describe, expect, test } from "bun:test"
import { buildCommands, designVariantCommandId, parseDesignVariantCommand, type CommandContext } from "./commands"
import { createWorkbench } from "./state"

/*
 * D1: «Design: apri la variante…» in the palette, one entry per variant of
 * each proposal still open, so a variant can be opened in a Design-mode pane
 * before the cards have their own button (D3).
 */

const base = {
  recents: [],
  hasHost: true,
  running: new Set<string>(),
  platform: "windows",
  workbench: createWorkbench(),
}
const commandsOf = (extra: Record<string, unknown>) => buildCommands({ ...base, ...extra } as unknown as CommandContext)

describe("«Design: apri la variante…»", () => {
  test("one entry per variant, saying proposal, title and number", () => {
    const commands = commandsOf({
      designVariants: [
        { k: "DS-A", title: "Vetro", variants: ["Uno", "Due"] },
        { k: "DS.B", title: "", variants: ["Solo"] },
      ],
    })
    const variants = commands.filter((command) => command.id.startsWith("design.variant."))
    expect(variants.map((command) => command.id)).toEqual([
      designVariantCommandId("DS-A", 1),
      designVariantCommandId("DS-A", 2),
      designVariantCommandId("DS.B", 1),
    ])
    expect(variants[1]?.title).toBe("Design: apri la variante — DS-A · Vetro · Variante 2 «Due»")
    expect(variants[2]?.title).toBe("Design: apri la variante — DS.B · Variante 1 «Solo»")
  })

  test("nothing when no proposal is open", () => {
    expect(commandsOf({}).some((command) => command.id.startsWith("design.variant."))).toBe(false)
  })

  test("the id gives back proposal and number, a key with dots included", () => {
    expect(parseDesignVariantCommand(designVariantCommandId("DS.B.2", 3))).toEqual({ k: "DS.B.2", variant: 3 })
    expect(parseDesignVariantCommand("design.variant.x")).toBeUndefined()
    expect(parseDesignVariantCommand("project.recent.C:/x")).toBeUndefined()
  })
})
