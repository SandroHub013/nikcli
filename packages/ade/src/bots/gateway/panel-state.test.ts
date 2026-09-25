import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import { gatewayVisible } from "../../surface/state"
import type { GatewayMessage } from "./controller"
import { createGatewayPanel, type GatewayPanelApi, type GatewayStatus, type LinkStatus, type PairingInfo, type PairingRequest } from "./panel-state"
import { memoryRemoteStore, REMOTE_OFF } from "./remote"

/*
 * G6: the Gateway section of a bot's card, with a fake Rust side. The token
 * goes one way; the state follows Rust's events; switching on asks for the
 * trust; the remote commands need a yes and keep the file's fingerprint.
 */

const TOKEN = "123456789:FINTO-token-di-prova_AbCdEfGhIjKlMnOp"
const PROJECT = "C:/progetto"
const BOT: AgentFile = {
  identifier: "aiuto",
  path: "C:/Users/me/AppData/Roaming/nikcli/agent/aiuto.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "nikcli",
}

function fakeApi() {
  const calls: string[] = []
  let status: GatewayStatus = { bot: BOT.path, platform: "telegram", enabled: false, running: false, connected: false, hasToken: false, authorized: [] }
  let pairing: PairingInfo = { open: true, pending: [], authorized: [], attemptsLeft: 5 }
  const handlers: {
    status?: (status: LinkStatus) => void
    pairing?: (request: PairingRequest) => void
    message?: (message: GatewayMessage) => void
  } = {}
  let stopped = false
  const api: GatewayPanelApi = {
    status: async () => [status],
    setToken: async (bot, platform, token) => {
      calls.push(`setToken ${bot} ${platform} ${token}`)
      status = { ...status, hasToken: true }
    },
    clearToken: async () => {
      calls.push("clearToken")
      status = { ...status, hasToken: false, enabled: false }
    },
    probe: async () => "@mio_bot",
    setEnabled: async (_bot, _platform, enabled, project) => {
      calls.push(`setEnabled ${enabled} ${project ?? "-"}`)
      status = { ...status, enabled, running: enabled, project: enabled ? project : status.project }
    },
    pairingList: async () => pairing,
    pairingApprove: async (_bot, _platform, code) => {
      calls.push(`approve ${code}`)
      pairing = { ...pairing, pending: [], authorized: [{ id: "42", name: "Ale", addedMs: 1 }] }
      return { id: "42", name: "Ale" }
    },
    pairingReject: async (_bot, _platform, request) => {
      calls.push(`reject ${request}`)
      pairing = { ...pairing, pending: pairing.pending.filter((pending) => pending.request !== request) }
    },
    pairingRevoke: async (_bot, _platform, sender) => void calls.push(`revoke ${sender}`),
    pairingOpen: async () => {
      calls.push("open")
      return 1
    },
    listen: async (on) => {
      Object.assign(handlers, on)
      return () => void (stopped = true)
    },
  }
  return {
    api,
    calls,
    handlers,
    stopped: () => stopped,
    setPairing: (next: PairingInfo) => void (pairing = next),
  }
}

type Approve = (bot: AgentFile, project: string) => Promise<{ ok: true; fingerprint: string } | { ok: false; problem?: string }>

function panelWith(fake: ReturnType<typeof fakeApi>, options: { bot?: AgentFile; approve?: Approve; project?: string } = {}) {
  const remote = memoryRemoteStore()
  const asked: string[] = []
  const approve: Approve =
    options.approve ??
    (async (bot, project) => {
      asked.push(`${bot.identifier} ${project}`)
      return { ok: true, fingerprint: "f-1" }
    })
  const panel = createRoot(() =>
    createGatewayPanel({
      api: fake.api,
      bot: () => options.bot ?? BOT,
      project: () => ("project" in options ? options.project : PROJECT),
      remote,
      approve,
      now: () => Date.UTC(2026, 8, 25, 10, 30),
    }),
  )
  return { panel, remote, asked }
}

describe("the Gateway section of a bot's card", () => {
  test("a saved token is handed to Rust and kept nowhere: the draft is emptied, the panel knows only that there is one", async () => {
    const fake = fakeApi()
    const { panel } = panelWith(fake)
    await panel.ready
    panel.setDraft(`  ${TOKEN}  `)
    const saving = panel.saveToken()
    // Emptied at once, before Rust even answers.
    expect(panel.draft()).toBe("")
    await saving
    expect(fake.calls).toEqual([`setToken ${BOT.path} telegram ${TOKEN}`])
    expect(panel.link().hasToken).toBe(true)
    const everything = JSON.stringify({ link: panel.link(), pairing: panel.pairing(), draft: panel.draft(), problem: panel.problem(), probed: panel.probed() })
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain("FINTO")
    // The test says the bot's name, not the token.
    await panel.probe()
    expect(panel.probed()).toBe("@mio_bot")
  })

  test("the state follows Rust's events for this bot, and only this bot", async () => {
    const fake = fakeApi()
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.refresh()
    fake.handlers.status!({ bot: "C:/altro.md", platform: "telegram", running: true, connected: true })
    expect(panel.link().connected).toBe(false)
    fake.handlers.status!({ bot: BOT.path, platform: "telegram", running: true, connected: true, lastMessageMs: 5 })
    expect(panel.link().connected).toBe(true)
    expect(panel.link().lastMessageMs).toBe(5)
    fake.handlers.status!({ bot: BOT.path, platform: "telegram", running: false, connected: false, lastError: "il token è in uso altrove" })
    expect(panel.link().running).toBe(false)
    expect(panel.link().lastError).toBe("il token è in uso altrove")
    // A message a key was taken out of is said in the panel too.
    expect(panel.redactedAt()).toBeUndefined()
    fake.handlers.message!({ bot: BOT.path, platform: "telegram", chat: "c", sender: { id: "42", name: "Ale" }, text: "x", id: "1", redacted: true, button: false })
    expect(panel.redactedAt()).toBe(Date.UTC(2026, 8, 25, 10, 30))
    panel.dispose()
    expect(fake.stopped()).toBe(true)
  })

  test("a request to pair shows up at once, can be refused, and a code pairs", async () => {
    const fake = fakeApi()
    const { panel } = panelWith(fake)
    await panel.ready
    const request: PairingRequest = { bot: BOT.path, platform: "telegram", request: "r1", sender: { id: "42", name: "Ale" }, createdMs: 1, expiresMs: 2 }
    fake.setPairing({ open: true, pending: [request], authorized: [], attemptsLeft: 5 })
    fake.handlers.pairing!(request)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(panel.pairing().pending.map((pending) => pending.request)).toEqual(["r1"])
    await panel.reject("r1")
    expect(panel.pairing().pending).toEqual([])
    fake.setPairing({ open: true, pending: [request], authorized: [], attemptsLeft: 5 })
    await panel.approve(" ABCD-EFGH ")
    expect(fake.calls).toContain("approve ABCD-EFGH")
    expect(panel.pairing().authorized.map((account) => account.id)).toEqual(["42"])
    await panel.revoke("42")
    expect(fake.calls).toContain("revoke 42")
  })

  test("switching on asks for the trust first and fixes the project; refused, nothing starts", async () => {
    const fake = fakeApi()
    const { panel, asked } = panelWith(fake)
    await panel.ready
    await panel.setEnabled(true)
    expect(asked).toEqual([`aiuto ${PROJECT}`])
    expect(fake.calls).toEqual([`setEnabled true ${PROJECT}`])
    expect(panel.link().enabled).toBe(true)
    await panel.setEnabled(false)
    expect(fake.calls.at(-1)).toBe("setEnabled false -")

    const refused = fakeApi()
    const { panel: other } = panelWith(refused, { approve: async () => ({ ok: false, problem: t("gateway.selfGrant", "aiuto", "bash") }) })
    await other.setEnabled(true)
    expect(refused.calls).toEqual([])
    expect(other.problem()).toBe(t("gateway.selfGrant", "aiuto", "bash"))

    const nowhere = fakeApi()
    const { panel: lost } = panelWith(nowhere, { project: undefined })
    await lost.setEnabled(true)
    expect(nowhere.calls).toEqual([])
    expect(lost.problem()).toBe(t("gateway.panel.noProject"))
  })

  test("the remote commands go on only after the yes, with the fingerprint checked at that yes", async () => {
    const fake = fakeApi()
    const { panel, remote, asked } = panelWith(fake)
    await panel.ready
    expect(panel.remote()).toEqual(REMOTE_OFF)
    panel.askRemote()
    expect(panel.confirmingRemote()).toBe(true)
    // Asking is not saying yes.
    expect(remote.get(BOT.path)).toEqual(REMOTE_OFF)
    panel.cancelRemote()
    expect(panel.confirmingRemote()).toBe(false)
    panel.askRemote()
    await panel.confirmRemote()
    expect(asked).toEqual([`aiuto ${PROJECT}`])
    expect(remote.get(BOT.path)).toEqual({ commands: true, fingerprint: "f-1" })
    expect(panel.remote().commands).toBe(true)
    await panel.remoteOff()
    expect(remote.get(BOT.path)).toEqual(REMOTE_OFF)
  })

  test("a trust refused at the yes leaves the commands off", async () => {
    const fake = fakeApi()
    const { panel, remote } = panelWith(fake, { approve: async () => ({ ok: false, problem: "no" }) })
    panel.askRemote()
    await panel.confirmRemote()
    expect(remote.get(BOT.path)).toEqual(REMOTE_OFF)
    expect(panel.problem()).toBe("no")
  })

  test("not offered to a bot on Claude Code or Codex", async () => {
    for (const runner of ["claude", "codex"]) {
      const fake = fakeApi()
      const { panel, remote } = panelWith(fake, { bot: { ...BOT, runner } })
      expect(panel.offersRemote()).toBe(false)
      panel.askRemote()
      expect(panel.confirmingRemote()).toBe(false)
      await panel.confirmRemote()
      expect(remote.get(BOT.path)).toEqual(REMOTE_OFF)
    }
  })

  test("the section is off in a release until the live test, on in development", () => {
    expect(gatewayVisible(false, false)).toBe(false)
    expect(gatewayVisible(false, true)).toBe(true)
    expect(gatewayVisible(true, false)).toBe(true)
  })
})
