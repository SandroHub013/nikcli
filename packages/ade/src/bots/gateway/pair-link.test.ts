import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../../test-support/solid-jsx"
import type { PairingLinkInfo } from "./panel-state"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { PairLink, addressOf, qrSource } = await import("./pair-link")
const { setLocalePreference } = await import("../../i18n")

setLocalePreference("it")

/* Scelta 3, the step 5 of Telegram: the QR, the link, the time left, «Un altro QR», and the code as the reserve. */
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const link = (over: Partial<PairingLinkInfo> = {}): PairingLinkInfo => ({
  url: `https://t.me/mio_bot?start=${TOKEN}`,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h1v1H0z"/></svg>',
  expiresMs: 1_000_000 + 600_000,
  ...over,
})

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(props: {
  link?: PairingLinkInfo
  paired?: string
  live?: boolean
  busy?: boolean
  now?: number
  onMake?: () => void
  onOpen?: ((url: string) => void) | undefined
  onGone?: () => void
}) {
  const host = document.createElement("div")
  document.body.append(host)
  const [now, setNow] = createSignal(props.now ?? 1_000_000)
  dispose = render(
    () =>
      createComponent(PairLink, {
        link: () => props.link,
        paired: () => props.paired,
        live: () => props.live ?? true,
        busy: () => props.busy ?? false,
        onMake: props.onMake ?? (() => {}),
        onOpen: props.onOpen,
        onGone: props.onGone,
        now,
      }),
    host,
  )
  const buttons = () => [...host.querySelectorAll("button")]
  const press = (text: string) => buttons().find((button) => button.textContent === text)!.click()
  return { host, buttons, press, setNow }
}

describe("the link or QR", () => {
  test("without one: «Mostra il QR» and the code as the reserve", () => {
    const made: string[] = []
    const { host, buttons, press } = mount({ onMake: () => void made.push("make") })
    expect(buttons().map((button) => button.textContent)).toEqual(["Mostra il QR"])
    expect(host.textContent).toContain("Non riesci? Scrivi al bot e inserisci qui il codice")
    press("Mostra il QR")
    expect(made).toEqual(["make"])
  })

  test("it waits for the gateway to read: only then does the bot hear /start", () => {
    const { buttons, host } = mount({ live: false })
    expect(buttons()[0]!.disabled).toBe(true)
    expect(host.textContent).toContain("Accendi")
  })

  test("with one: the QR as an image, the address with no token, the time left and «Un altro QR»", () => {
    const opened: string[] = []
    const { host, buttons, press } = mount({ link: link(), onOpen: (url) => void opened.push(url) })
    const image = host.querySelector("img")!
    expect(image.getAttribute("src")).toBe(qrSource(link().svg))
    expect(image.getAttribute("src")!.startsWith("data:image/svg+xml;utf8,")).toBe(true)
    expect(image.getAttribute("alt")).toBeTruthy()
    // The token is in the QR and the link, and in no text of the page.
    expect(host.textContent).not.toContain(TOKEN)
    expect(host.innerHTML.replace(/src="[^"]*"/g, "")).not.toContain(TOKEN)
    expect(host.textContent).toContain("restano 10:00")
    expect(host.textContent).toContain("Vale 10 minuti e una volta sola")
    expect(buttons().map((button) => button.textContent)).toEqual(["Apri t.me/mio_bot su questo computer", "Un altro QR"])
    press("Apri t.me/mio_bot su questo computer")
    expect(opened).toEqual([`https://t.me/mio_bot?start=${TOKEN}`])
  })

  test("the QR sits in a zone a recording does not keep", () => {
    const { host } = mount({ link: link() })
    expect(host.querySelector("[data-secrets] img")).not.toBeNull()
  })

  test("where the page cannot open a link, the address shows as text, still without the token", () => {
    const { host } = mount({ link: link(), onOpen: undefined })
    expect(host.querySelector("code")?.textContent).toBe("t.me/mio_bot")
    expect(host.textContent).not.toContain(TOKEN)
  })

  test("the clock runs down, and at zero the QR goes and «Un altro QR» stays", () => {
    const { host, buttons, setNow } = mount({ link: link() })
    setNow(1_000_000 + 540_000)
    expect(host.textContent).toContain("restano 1:00")
    setNow(1_000_000 + 600_000)
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("Il QR è scaduto: fanne un altro.")
    expect(buttons().map((button) => button.textContent)).toEqual(["Un altro QR"])
  })

  test("«Un altro QR» asks for a new one", () => {
    const made: string[] = []
    const { press } = mount({ link: link(), onMake: () => void made.push("make") })
    press("Un altro QR")
    expect(made).toEqual(["make"])
  })

  test("once it paired the account, its name is said", () => {
    const { host } = mount({ paired: "Ale" })
    expect(host.textContent).toContain("Abbinato: Ale.")
  })

  test("when the step closes or the card goes, it says the QR is off the screen, once", () => {
    const gone: string[] = []
    mount({ link: link(), onGone: () => void gone.push("gone") })
    expect(gone).toEqual([])
    dispose?.()
    dispose = undefined
    expect(gone).toEqual(["gone"])
  })

  test("addressOf cuts everything after the question mark", () => {
    expect(addressOf(`https://t.me/mio_bot?start=${TOKEN}`)).toBe("t.me/mio_bot")
    expect(addressOf("t.me/x")).toBe("t.me/x")
  })
})

describe("in the section", () => {
  const panel = readFileSync(join(import.meta.dir, "panel.tsx"), "utf8")

  test("lint: the link is drawn for Telegram only, in the place that is empty for the others", () => {
    const slot = panel.slice(panel.indexOf('<div data-slot="gateway-pair-link">'))
    expect(slot.indexOf('<Show when={panel.platform() === "telegram"}>')).toBeGreaterThan(-1)
    expect(slot.indexOf("<PairLink")).toBeGreaterThan(slot.indexOf('panel.platform() === "telegram"'))
    expect(slot.indexOf("<PairLink")).toBeLessThan(slot.indexOf('data-slot="gateway-list"'))
  })

  test("lint: a hidden tab, a closed step and a gone card all cancel the token", () => {
    expect(panel).toContain("if (props.onScreen && !props.onScreen()) void panel.cancelLink()")
    expect(panel).toContain("onGone={() => void panel.cancelLink()}")
    expect(panel).toContain("onCleanup(() => panel.dispose())")
    const bots = readFileSync(join(import.meta.dir, "..", "bots.tsx"), "utf8")
    expect(bots).toContain('onScreen={() => "platforms" === shown()}')
  })

  test("lint: the token is never logged or put in a text by the page", () => {
    for (const file of ["pair-link.tsx", "panel-state.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8")
      expect(source, file).not.toMatch(/console\.(log|warn|error|info|debug)\([^)]*(url|link)/)
    }
  })
})
