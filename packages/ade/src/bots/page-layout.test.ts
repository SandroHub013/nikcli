import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BOT_TABS } from "./tabs"

/*
 * The bot's page (scelta 1, D2, D12). The old card was a column of 260 px on the
 * right, 220 below 1100 px and gone below 860 px: Modifica, Elimina, the platforms,
 * the routines and the memory were out of reach on half a laptop screen. Held as
 * rules, since the layout is the stylesheet's and the markup is a `.tsx`.
 */
const css = readFileSync(join(import.meta.dir, "bots.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
const view = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")

const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf("}", start))
}

/** Every `@media` block of the stylesheet, up to its closing brace. */
const media = () =>
  [...css.matchAll(/@media[^{]*\{/g)].map((match) => {
    let depth = 1
    let at = match.index! + match[0].length
    while (at < css.length && depth > 0) {
      if (css[at] === "{") depth++
      else if (css[at] === "}") depth--
      at++
    }
    return css.slice(match.index!, at)
  })

describe("no column on the right", () => {
  test("lint: the view draws no card beside the page, and the stylesheet has none to size or hide", () => {
    expect(view).not.toContain('<aside data-slot="bots-card">')
    expect(view).not.toContain("function BotCard")
    expect(css).not.toContain('[data-slot="bots-card"] {')
    expect(css).not.toContain('[data-slot="bots-card-body"]')
  })

  test("lint: nothing of the page is hidden at any width of the window", () => {
    for (const block of media()) {
      for (const slot of ["bots-page", "bots-tabs", "bots-tab", "bots-tabpanel", "bots-tab-body", "bots-section"]) {
        const hides = new RegExp(`\\[data-slot="${slot}"\\][^{}]*\\{[^}]*display:\\s*none`).test(block)
        expect(hides, `${slot} in ${block.slice(0, 40)}`).toBe(false)
      }
    }
  })

  test("the tabs wrap instead of scrolling, so none is out of sight", () => {
    expect(rule('[data-slot="bots-tabs"]')).toContain("flex-wrap: wrap")
    expect(rule('[data-slot="bots-tabs"]')).not.toContain("overflow")
  })

  test("a tab's body takes the whole width of the middle, up to a line length that reads", () => {
    const body = rule('[data-slot="bots-tab-body"]')
    expect(body).toContain("width: 100%")
    expect(body).toMatch(/max-width:\s*\d+px/)
  })

  test("a hidden panel is hidden even though the panel is a flex box", () => {
    expect(rule('[data-slot="bots-tabpanel"][hidden]')).toContain("display: none")
  })
})

describe("the page has the six tabs and each section in its own", () => {
  test("lint: the page draws a panel for every tab the strip offers", () => {
    for (const tab of BOT_TABS) expect(view, tab).toContain(`tab="${tab}"`)
  })

  test("lint: the conversation, the settings form, the platforms, the routines, the memory and the permissions are the panels' content", () => {
    const page = view.slice(view.indexOf("function BotPage"), view.indexOf("function SettingsTab"))
    expect(page).toContain("{props.children}")
    expect(page).toContain("<SettingsTab")
    expect(page).toContain("<GatewaySection")
    expect(page).toContain("<RoutineSection")
    expect(page).toContain("<MemorySection")
    expect(page).toContain("<PermissionsSection")
  })

  test("lint: the settings form is there without pressing «Modifica», and so is the deletion", () => {
    const tab = view.slice(view.indexOf("function SettingsTab"), view.indexOf("/* ── the form ─"))
    expect(tab).toContain("<BotSettings")
    expect(tab).not.toContain("editing()")
    expect(tab).toContain("<ConfirmAction")
    expect(tab).toContain('t("bots.delete.button")')
    expect(view).not.toContain('"bots.edit.open"')
  })

  test("lint: the conversation and the settings stay mounted once opened, so a draft is still there", () => {
    const page = view.slice(view.indexOf("function BotPage"), view.indexOf("function SettingsTab"))
    expect(page).toContain('seen().has("settings")')
    expect(view).toContain("hidden={props.shown !== props.tab}")
  })

  test("lint: the page falls back to the conversation when the bot changes", () => {
    const page = view.slice(view.indexOf("function BotPage"), view.indexOf("function SettingsTab"))
    expect(page).toContain('setTab("talk")')
  })
})

describe("the head of the page says it in words (D14)", () => {
  test("lint: no raw mode, no raw level and no session id in the first lines", () => {
    const head = view.slice(view.indexOf("function PageHead"), view.indexOf("function TabPanel"))
    expect(head).not.toContain("props.bot.mode}")
    expect(head).not.toContain("props.bot.effort}")
    expect(head).not.toContain("sessionId")
    expect(head).toContain("metaWords(")
  })

  test("lint: the session and the path are in the Details of the Settings tab", () => {
    const tab = view.slice(view.indexOf("function SettingsTab"), view.indexOf("/* ── the form ─"))
    expect(tab).toContain("<details")
    expect(tab).toContain("sessionId")
    expect(tab).toContain("props.bot.path")
  })
})
