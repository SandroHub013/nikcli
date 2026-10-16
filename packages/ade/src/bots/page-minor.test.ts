import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { en } from "../i18n/en"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { GatewayPanelApi, PairingInfo } from "./gateway/panel-state"
import { routineName } from "./routine"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { createRoot, createSignal } = await import("solid-js")
const { BotTabs } = await import("./bot-tabs")
const { createWaitingCount } = await import("./gateway/waiting")
const { setLocalePreference } = await import("../i18n")
const { tabsOf } = await import("./tabs")
type BotTab = import("./tabs").BotTab

setLocalePreference("it")

/* The small points of the page review (P2-P7). */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

describe("aria-controls only points at a panel that is in the page", () => {
  const mount = (mounted?: ReadonlySet<BotTab>) => {
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () =>
        createComponent(BotTabs, {
          tabs: tabsOf({}, { platforms: true }),
          active: "talk",
          idPrefix: "p",
          ...(mounted ? { mounted } : {}),
          onSelect: () => {},
        }),
      host,
    )
    return (tab: string) => document.querySelector(`[role="tab"][data-tab="${tab}"]`)!.getAttribute("aria-controls")
  }

  test("a tab whose panel is not drawn yet controls nothing; the others control theirs", () => {
    const controls = mount(new Set<BotTab>(["talk", "settings"]))
    expect(controls("talk")).toBe("p-panel-talk")
    expect(controls("settings")).toBe("p-panel-settings")
    expect(controls("memory")).toBeNull()
    expect(controls("platforms")).toBeNull()
  })

  test("without the list, every tab controls its panel as before", () => {
    const controls = mount()
    expect(controls("memory")).toBe("p-panel-memory")
  })
})

describe("the pairings waiting show on the Platforms tab from any tab", () => {
  const info = (waiting: number): PairingInfo => ({
    open: true,
    pending: Array.from({ length: waiting }, (_, index) => ({
      bot: "b",
      platform: "telegram",
      request: `r${index}`,
      sender: { id: "1", name: "x" },
      createdMs: 0,
      expiresMs: 1,
    })),
    authorized: [],
    attemptsLeft: 5,
  })

  test("it counts all three platforms, and again when a request arrives", async () => {
    const waiting: Record<string, number> = { telegram: 1, discord: 0, slack: 2 }
    let onPairing: ((request: { bot: string }) => void) | undefined
    const api = {
      pairingList: async (_bot: string, platform: string) => info(waiting[platform] ?? 0),
      listen: async (handlers: { pairing: (request: never) => void }) => {
        onPairing = handlers.pairing as unknown as (request: { bot: string }) => void
        return () => {}
      },
    } as unknown as GatewayPanelApi
    const [path] = createSignal("C:/u/b.md")
    const { count } = createRoot((disposeRoot) => {
      dispose = disposeRoot
      return createWaitingCount(api, path)
    })
    const settle = async () => {
      for (let turn = 0; turn < 6; turn++) await wait()
    }
    await settle()
    expect(count()).toBe(3)
    waiting["discord"] = 4
    onPairing?.({ bot: "C:/u/b.md" })
    await settle()
    expect(count()).toBe(7)
    // A request for another bot changes nothing.
    waiting["slack"] = 0
    onPairing?.({ bot: "C:/u/other.md" })
    await settle()
    expect(count()).toBe(7)
  })

  test("lint: the page hands the badge to the tabs", () => {
    const page = read("bots.tsx")
    expect(page).toContain("createWaitingCount(props.gateway.api")
    expect(page).toContain("badges={{ platforms: waiting?.count() ?? 0 }}")
    expect(page).toContain("mounted={new Set<BotTab>([...seen(), shown()])}")
  })
})

describe("the small ones", () => {
  test("the English sentences of the bot's screens use the quotes English uses, not «»", () => {
    const wrong = Object.entries(en as Record<string, unknown>)
      .filter(([key]) => /^(bots|gateway)\.|^settings\.bots\./.test(key))
      .filter(([, value]) => /[«»]/.test(typeof value === "function" ? String((value as (...a: string[]) => string)("a", "b", "c")) : String(value)))
      .map(([key]) => key)
    expect(wrong).toEqual([])
  })

  test("a routine's name in the question is cut by letters, not in the middle of an emoji", () => {
    // Since bot-ui-4 (P2-7) the question names it as the head line does: `routineName`, which counts letters.
    expect(read("routine-panel.tsx")).toContain("routineName(routine.prompt, 60)")
    expect(read("routine-panel.tsx")).not.toContain("routine.prompt.slice(0, 60)")
    const cut = routineName("👍".repeat(70), 60)
    expect(Array.from(cut).length).toBe(60)
    expect(cut.endsWith("👍…")).toBe(true)
  })

  test("«Da telefono» is not drawn where there are no messaging apps", () => {
    const panel = read("permissions-panel.tsx")
    expect(panel.indexOf("props.remote !== undefined")).toBeLessThan(panel.indexOf('t("bots.permissions.phone")'))
  })
})
