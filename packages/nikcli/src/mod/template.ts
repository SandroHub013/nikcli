/**
 * The source of a new mod: one file that draws for every client.
 *
 * A mod runs in the nikcli server and answers `ui.render` with a tree of plain data. The terminal, the
 * phone, the desktop app and ADE each ask with their own `surface`, so one mod gives each a layout
 * made for it — nothing is written per client, and nothing is installed on them. `nikcli mod create`
 * writes this; it is meant to be edited, and it reloads on save.
 */
export namespace ModTemplate {
  /** Lowercase words joined by dashes: it names a folder, a pane and a toast, and has to be safe in all three. */
  export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

  export function valid(name: string) {
    return NAME.test(name)
  }

  /** The `index.ts` of a mod called `name` (already checked with `valid`). */
  export function source(name: string) {
    const id = JSON.stringify(name)
    return `import type { ModRegister } from "@nikcli-ai/plugin/mod"

/**
 * ${name}: a pane that draws on every nikcli client from this one file.
 *
 * It runs in the nikcli server. Save the file and it reloads: the terminal, the phone app, the desktop
 * app and ADE redraw it without a restart. \`e.surface\` says who is asking, so each gets its own layout.
 */
export const register: ModRegister = (on) => {
  let clicks = 0

  // A docked pane: the sidebar in the terminal and on desktop, a card on the phone and in ADE.
  on("session.start", async ($, e, next) => {
    $.ui.open({ id: ${id}, title: ${id}, placement: "dock" })
    return next(e)
  })

  on("ui.render", { component: "Pane", requestId: ${id} }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const count = Text({ color: clicks > 0 ? "success" : "muted" }, \`clicked \${clicks} \${clicks === 1 ? "time" : "times"}\`)
    const click = Button({ key: ${JSON.stringify(`${name}:click`)}, label: "Click me" })

    switch (e.surface) {
      // Narrow and touch-first: a roomy column with a big target.
      case "mobile":
        return { tree: Box({ gap: 2 }, Text({ bold: true }, "Hello from ${name}"), count, click) }
      // A cell grid: one dense row.
      case "terminal":
        return { tree: Box({ direction: "row", gap: 2 }, count, click) }
      // Desktop and ADE: a window with room to breathe.
      default:
        return { tree: Box({ gap: 1 }, Text({ bold: true }, "Hello from ${name}"), count, click) }
    }
  })

  on("ui.press", { key: ${JSON.stringify(`${name}:click`)} }, async ($) => {
    clicks++
    // Every client that is showing this pane draws it again.
    $.ui.invalidate("Pane", ${id})
    return { handled: true }
  })
}
`
  }
}
