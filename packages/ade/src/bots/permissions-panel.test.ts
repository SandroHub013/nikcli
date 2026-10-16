import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { en } from "../i18n/en"
import { it as itDict } from "../i18n/it"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { AgentFile } from "./ragu"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { PermissionsSection } = await import("./permissions-panel")
const { remoteKey } = await import("./gateway/remote")
const { setLocalePreference } = await import("../i18n")

setLocalePreference("it")

const BOT: AgentFile = {
  identifier: "contabile",
  path: "C:/u/.nikcli/agent/contabile.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "ragu",
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A switch saved for `fingerprint` on Telegram only. */
const remote = (fingerprint: string) => {
  const saved = new Map([[remoteKey(BOT.path, "telegram"), { commands: true, fingerprint }]])
  return {
    get: (key: string) => saved.get(key) ?? { commands: false },
    set: () => {},
  }
}

async function show(fingerprint: string | undefined, saved: string) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(PermissionsSection, {
        bot: BOT,
        remote: remote(saved),
        fingerprintOf: async () => fingerprint,
      }),
    host,
  )
  await wait()
  await wait()
  return [...document.querySelectorAll("li")].map((item) => item.textContent)
}

describe("Permessi: «Comandi da remoto» as a chat's turn will find it", () => {
  test("on only while the file is the one the owner said yes to", async () => {
    const items = await show("abc", "abc")
    expect(items[0]).toBe("Telegram: comandi da remoto accesi")
    expect(items[1]).toBe("Discord: comandi da remoto spenti")
  })

  test("a file that changed since is off, and the tab says why", async () => {
    const items = await show("def", "abc")
    expect(items[0]).toContain("spenti, perché il file del bot è cambiato")
    expect(items[1]).toBe("Discord: comandi da remoto spenti")
  })

  test("a file that cannot be read is off too", async () => {
    const items = await show(undefined, "abc")
    expect(items[0]).toContain("spenti")
    expect(items[0]).not.toBe("Telegram: comandi da remoto accesi")
  })
})

describe("Permessi: the web is shut from a phone, with the commands on as well", () => {
  test("the phone text says so in both languages", () => {
    expect(String(itDict["bots.permissions.phoneText"])).toContain("nemmeno con i comandi accesi")
    expect(String(itDict["bots.permissions.phoneText"])).not.toMatch(/pagine web e i comandi/i)
    expect(String(en["bots.permissions.phoneText"])).toContain("even with the commands on")
    expect(String(en["bots.permissions.phoneText"])).not.toContain("Web pages and commands only")
  })
})
