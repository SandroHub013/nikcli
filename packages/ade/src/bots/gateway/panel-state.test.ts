import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { t } from "../../i18n"
import type { AgentFile } from "../ragu"
import { gatewayVisible } from "../../surface/state"
import type { GatewayMessage } from "./controller"
import {
  createGatewayPanel,
  type GatewayPanelApi,
  type GatewayStatus,
  type LinkStatus,
  type PairingInfo,
  type PairingRequest,
} from "./panel-state"
import { forgetTurnFailures, forgetTurnFailuresOf, noteTurnFailure } from "./failures"
import { memoryRemoteStore, REMOTE_OFF, remoteKey } from "./remote"

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
  runner: "ragu",
}

function fakeApi(initial: Partial<GatewayStatus> = {}) {
  const calls: string[] = []
  let status: GatewayStatus = {
    bot: BOT.path,
    platform: "telegram",
    enabled: false,
    running: false,
    connected: false,
    hasToken: false,
    authorized: [],
    ...initial,
  }
  let pairing: PairingInfo = { open: true, pending: [], authorized: [], attemptsLeft: 5 }
  let linkCount = 0
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
    pairingLink: async (bot, platform) => {
      calls.push(`link ${bot} ${platform}`)
      linkCount += 1
      return { url: `https://t.me/mio_bot?start=TOKEN${linkCount}`, svg: "<svg></svg>", expiresMs: Date.UTC(2026, 8, 25, 10, 40) }
    },
    pairingLinkCancel: async (bot, platform) => void calls.push(`cancel ${bot} ${platform}`),
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

type Approve = (
  bot: AgentFile,
  project: string,
) => Promise<{ ok: true; fingerprint: string } | { ok: false; problem?: string }>

function panelWith(
  fake: ReturnType<typeof fakeApi>,
  options: { bot?: AgentFile; approve?: Approve; project?: string; confirm?: boolean } = {},
) {
  const remote = memoryRemoteStore()
  const asked: string[] = []
  const confirmed: string[] = []
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
      confirm: async (question) => {
        confirmed.push(question)
        return options.confirm ?? false
      },
      now: () => Date.UTC(2026, 8, 25, 10, 30),
      linkPollMs: 5,
    }),
  )
  return { panel, remote, asked, confirmed }
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
    const everything = JSON.stringify({
      link: panel.link(),
      pairing: panel.pairing(),
      draft: panel.draft(),
      problem: panel.problem(),
      probed: panel.probed(),
    })
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
    fake.handlers.status!({
      bot: BOT.path,
      platform: "telegram",
      running: false,
      connected: false,
      lastError: "il token è in uso altrove",
    })
    expect(panel.link().running).toBe(false)
    expect(panel.link().lastError).toBe("il token è in uso altrove")
    // A message a key was taken out of is said in the panel too.
    expect(panel.redactedAt()).toBeUndefined()
    fake.handlers.message!({
      bot: BOT.path,
      platform: "telegram",
      chat: "c",
      sender: { id: "42", name: "Ale" },
      text: "x",
      id: "1",
      redacted: true,
      button: false,
      private: true,
    })
    expect(panel.redactedAt()).toBe(Date.UTC(2026, 8, 25, 10, 30))
    panel.dispose()
    expect(fake.stopped()).toBe(true)
  })

  test("the last failed turn of this bot and platform is shown, and follows a new one (S10)", async () => {
    forgetTurnFailures()
    noteTurnFailure(BOT.path, "telegram", "prima del pannello", 1)
    const fake = fakeApi()
    const { panel } = panelWith(fake)
    await panel.ready
    expect(panel.turnFailure()).toEqual({ at: 1, detail: "prima del pannello" })
    noteTurnFailure("C:/altro.md", "telegram", "di un altro bot", 2)
    noteTurnFailure(BOT.path, "discord", "di un'altra piattaforma", 3)
    expect(panel.turnFailure()).toEqual({ at: 1, detail: "prima del pannello" })
    noteTurnFailure(BOT.path, "telegram", "dopo", 4)
    expect(panel.turnFailure()).toEqual({ at: 4, detail: "dopo" })
    panel.choose("discord")
    expect(panel.turnFailure()).toEqual({ at: 3, detail: "di un'altra piattaforma" })
    // It goes away when the bot works again (N7).
    forgetTurnFailuresOf(BOT.path)
    expect(panel.turnFailure()).toBeUndefined()
    panel.dispose()
    noteTurnFailure(BOT.path, "discord", "a pannello chiuso", 5)
    forgetTurnFailures()
  })

  test("a request to pair shows up at once, can be refused, and a code pairs", async () => {
    const fake = fakeApi()
    const { panel } = panelWith(fake)
    await panel.ready
    const request: PairingRequest = {
      bot: BOT.path,
      platform: "telegram",
      request: "r1",
      sender: { id: "42", name: "Ale" },
      createdMs: 1,
      expiresMs: 2,
    }
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
    const fake = fakeApi({ hasToken: true })
    const { panel, asked } = panelWith(fake)
    await panel.ready
    await panel.refresh()
    await panel.setEnabled(true)
    expect(asked).toEqual([`aiuto ${PROJECT}`])
    expect(fake.calls).toEqual([`setEnabled true ${PROJECT}`])
    expect(panel.link().enabled).toBe(true)
    await panel.setEnabled(false)
    expect(fake.calls.at(-1)).toBe("setEnabled false -")

    const refused = fakeApi({ hasToken: true })
    const { panel: other } = panelWith(refused, {
      approve: async () => ({ ok: false, problem: t("gateway.selfGrant", "aiuto", "bash") }),
    })
    await other.refresh()
    await other.setEnabled(true)
    expect(refused.calls).toEqual([])
    expect(other.problem()).toBe(t("gateway.selfGrant", "aiuto", "bash"))

    const nowhere = fakeApi()
    const { panel: lost } = panelWith(nowhere, { project: undefined })
    await lost.setEnabled(true)
    expect(nowhere.calls).toEqual([])
    expect(lost.problem()).toBe(t("gateway.panel.noProject"))
  })

  /* G6 review, BASSI 1-3. */
  test("without a token switching on is refused with the reason, before any trust is asked", async () => {
    const fake = fakeApi()
    const { panel, asked } = panelWith(fake)
    await panel.refresh()
    await panel.setEnabled(true)
    expect(asked).toEqual([])
    expect(fake.calls).toEqual([])
    expect(panel.problem()).toBe(t("gateway.panel.needToken"))
  })

  test("switched on again with another project open, the move is asked about first", async () => {
    const before = "C:/vecchio-progetto"
    const fake = fakeApi({ hasToken: true, project: before })
    const { panel, asked, confirmed } = panelWith(fake)
    await panel.refresh()
    // Off, the panel shows where it would run now, and where it ran before.
    expect(panel.where()).toBe(PROJECT)
    expect(panel.previous()).toBe(before)
    await panel.setEnabled(true)
    expect(confirmed).toEqual([t("gateway.panel.moveProject", before, PROJECT)])
    expect(asked).toEqual([])
    expect(fake.calls).toEqual([])

    const agreed = fakeApi({ hasToken: true, project: before })
    const { panel: moved } = panelWith(agreed, { confirm: true })
    await moved.refresh()
    await moved.setEnabled(true)
    expect(agreed.calls).toEqual([`setEnabled true ${PROJECT}`])
    expect(moved.where()).toBe(PROJECT)
    expect(moved.previous()).toBeUndefined()

    // The same project as before: nothing to ask.
    const same = fakeApi({ hasToken: true, project: PROJECT })
    const { panel: again, confirmed: none } = panelWith(same)
    await again.refresh()
    await again.setEnabled(true)
    expect(none).toEqual([])
    expect(same.calls).toEqual([`setEnabled true ${PROJECT}`])
  })

  test("a stranger gets a code only while the gateway reads: live only switched on and running", async () => {
    const fake = fakeApi({ hasToken: true })
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.refresh()
    expect(panel.live()).toBe(false)
    await panel.setEnabled(true)
    expect(panel.live()).toBe(true)
    fake.handlers.status!({
      bot: BOT.path,
      platform: "telegram",
      running: false,
      connected: false,
      lastError: "il token è in uso altrove",
    })
    expect(panel.live()).toBe(false)
  })

  test("the remote commands go on only after the yes, with the fingerprint checked at that yes", async () => {
    const fake = fakeApi()
    const { panel, remote, asked } = panelWith(fake)
    await panel.ready
    expect(panel.remote()).toEqual(REMOTE_OFF)
    panel.askRemote()
    expect(panel.confirmingRemote()).toBe(true)
    // Asking is not saying yes.
    expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual(REMOTE_OFF)
    panel.cancelRemote()
    expect(panel.confirmingRemote()).toBe(false)
    panel.askRemote()
    await panel.confirmRemote()
    expect(asked).toEqual([`aiuto ${PROJECT}`])
    expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual({ commands: true, fingerprint: "f-1" })
    expect(panel.remote().commands).toBe(true)
    await panel.remoteOff()
    expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual(REMOTE_OFF)
  })

  // Full review 2026-10-06, bots 12: the yes is for the platform shown when it was given.
  test("the yes given on Telegram is not on for Discord, and a yes on Discord is its own", async () => {
    const fake = fakeApi()
    const { panel, remote } = panelWith(fake)
    await panel.ready
    panel.askRemote()
    await panel.confirmRemote()
    expect(panel.remote().commands).toBe(true)
    panel.choose("discord")
    await panel.ready
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(panel.remote()).toEqual(REMOTE_OFF)
    expect(remote.get(remoteKey(BOT.path, "discord"))).toEqual(REMOTE_OFF)
    panel.askRemote()
    await panel.confirmRemote()
    expect(remote.get(remoteKey(BOT.path, "discord"))).toEqual({ commands: true, fingerprint: "f-1" })
    // Turning it off here leaves Telegram's alone.
    await panel.remoteOff()
    expect(remote.get(remoteKey(BOT.path, "discord"))).toEqual(REMOTE_OFF)
    expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual({ commands: true, fingerprint: "f-1" })
  })

  test("a trust refused at the yes leaves the commands off", async () => {
    const fake = fakeApi()
    const { panel, remote } = panelWith(fake, { approve: async () => ({ ok: false, problem: "no" }) })
    panel.askRemote()
    await panel.confirmRemote()
    expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual(REMOTE_OFF)
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
      expect(remote.get(remoteKey(BOT.path, "telegram"))).toEqual(REMOTE_OFF)
    }
  })

  test("the section is off in a release until the live test, on in development", () => {
    expect(gatewayVisible(false, false)).toBe(false)
    expect(gatewayVisible(false, true)).toBe(true)
    expect(gatewayVisible(true, false)).toBe(true)
  })
  /*
   * Two platforms in one card. The Rust side keeps a link per platform, so
   * choosing one here never touches the other: what a test must show is that
   * the panel reads and writes the platform it is showing, and that the other
   * platform's link is still as it was.
   */
  test("the card shows one platform at a time and keeps the other", async () => {
    await createRoot(async () => {
      const seen: string[] = []
      const api: GatewayPanelApi = {
        status: async () => [
          {
            bot: BOT.path,
            platform: "telegram",
            enabled: true,
            running: true,
            connected: true,
            hasToken: true,
            authorized: [],
          },
          {
            bot: BOT.path,
            platform: "discord",
            enabled: false,
            running: false,
            connected: false,
            hasToken: true,
            authorized: [],
          },
        ],
        setToken: async (bot, platform) => void seen.push("setToken:" + platform),
        clearToken: async (bot, platform) => void seen.push("clearToken:" + platform),
        probe: async (bot, platform) => "@" + platform,
        setEnabled: async (bot, platform, enabled) => void seen.push("setEnabled:" + platform + ":" + enabled),
        pairingList: async (bot, platform) => {
          seen.push("pairingList:" + platform)
          return { open: false, pending: [], authorized: [], attemptsLeft: 0 }
        },
        pairingApprove: async () => ({ id: "u1", name: "qualcuno" }),
        pairingReject: async () => {},
        pairingRevoke: async () => {},
        pairingOpen: async () => 0,
        listen: async () => () => {},
      }
      const panel = createGatewayPanel({
        bot: () => BOT,
        api,
        project: () => PROJECT,
        remote: memoryRemoteStore(),
        approve: async () => ({ ok: true, fingerprint: "f" }),
        confirm: async () => true,
      })
      try {
        // Telegram is the default, and it is the one it reads.
        expect(panel.platform()).toBe("telegram")
        await panel.refresh()
        expect(panel.link().enabled).toBe(true)
        expect(panel.link().hasToken).toBe(true)

        // Discord is the other link, and it is a different one.
        panel.choose("discord")
        expect(panel.platform()).toBe("discord")
        await panel.refresh()
        expect(panel.link().enabled).toBe(false)
        expect(panel.link().hasToken).toBe(true)

        // What it writes goes to the platform it is showing.
        panel.setDraft("  token-di-prova  ")
        await panel.saveToken()
        await panel.probe()
        expect(seen).toContain("setToken:discord")
        expect(panel.probed()).toBe("@discord")
        // A token typed for Discord is never shown against Telegram.
        expect(panel.draft()).toBe("")

        // And Telegram's link is still as it was.
        panel.choose("telegram")
        await panel.refresh()
        expect(panel.link().enabled).toBe(true)
        expect(seen).toContain("pairingList:discord")
      } finally {
        panel.dispose()
      }
    })
  })

  /* G10: Slack has a second token, and the manifest of the user's app. */
  test("Slack asks for its App-Level Token, and switching on waits for both tokens", async () => {
    await createRoot(async () => {
      const seen: string[] = []
      let status: GatewayStatus = {
        bot: BOT.path,
        platform: "slack",
        enabled: false,
        running: false,
        connected: false,
        hasToken: true,
        hasAppToken: false,
        authorized: [],
      }
      const api: GatewayPanelApi = {
        status: async () => [status],
        setToken: async (_bot, platform, token, kind) => {
          seen.push(`setToken:${platform}:${kind ?? "bot"}:${token}`)
          if (kind === "app") status = { ...status, hasAppToken: true }
        },
        slackManifest: async (name) => `{"name": "${name}"}`,
        clearToken: async () => {},
        probe: async () => "@bot",
        setEnabled: async (_bot, platform, enabled) => void seen.push(`setEnabled:${platform}:${enabled}`),
        pairingList: async () => ({ open: false, pending: [], authorized: [], attemptsLeft: 0 }),
        pairingApprove: async () => ({ id: "U1", name: "qualcuno" }),
        pairingReject: async () => {},
        pairingRevoke: async () => {},
        pairingOpen: async () => 0,
        listen: async () => () => {},
      }
      const panel = createGatewayPanel({
        bot: () => BOT,
        api,
        project: () => PROJECT,
        remote: memoryRemoteStore(),
        approve: async () => ({ ok: true, fingerprint: "f" }),
        confirm: async () => true,
        platform: "slack",
      })
      try {
        await panel.refresh()
        expect(panel.needsAppToken()).toBe(true)
        expect(panel.tokensReady()).toBe(false)
        // The bot's token alone does not switch Slack on, and says what is missing.
        await panel.setEnabled(true)
        expect(panel.problem()).toBe(t("gateway.panel.needAppToken"))
        expect(seen.some((call) => call.startsWith("setEnabled"))).toBe(false)

        // The second token goes one way too: the draft is emptied first.
        panel.setAppDraft("  xapp-1-FINTO-token  ")
        await panel.saveAppToken()
        expect(panel.appDraft()).toBe("")
        expect(seen).toContain("setToken:slack:app:xapp-1-FINTO-token")
        expect(panel.tokensReady()).toBe(true)
        await panel.setEnabled(true)
        expect(seen).toContain("setEnabled:slack:true")

        // The manifest is made for this bot's name.
        await panel.showManifest()
        expect(panel.manifest()).toContain("aiuto")

        // Telegram needs no second token, and the manifest is Slack's.
        panel.choose("telegram")
        expect(panel.needsAppToken()).toBe(false)
        expect(panel.manifest()).toBeUndefined()
      } finally {
        panel.dispose()
      }
    })
  })

  test("a name probed for one platform is dropped when the other is shown", async () => {
    await createRoot(async () => {
      const api: GatewayPanelApi = {
        status: async () => [],
        setToken: async () => {},
        clearToken: async () => {},
        probe: async () => "@bot_di_prova",
        setEnabled: async () => {},
        pairingList: async () => ({ open: false, pending: [], authorized: [], attemptsLeft: 0 }),
        pairingApprove: async () => ({ id: "u1", name: "qualcuno" }),
        pairingReject: async () => {},
        pairingRevoke: async () => {},
        pairingOpen: async () => 0,
        listen: async () => () => {},
      }
      const panel = createGatewayPanel({
        bot: () => BOT,
        api,
        project: () => PROJECT,
        remote: memoryRemoteStore(),
        approve: async () => ({ ok: true, fingerprint: "f" }),
        confirm: async () => true,
      })
      try {
        await panel.probe()
        expect(panel.probed()).toBe("@bot_di_prova")
        // A probe that failed on one platform says nothing about the other, so
        // the name is dropped rather than shown against the wrong one.
        panel.choose("discord")
        expect(panel.probed()).toBeUndefined()
      } finally {
        panel.dispose()
      }
    })
  })

  /*
   * Who may write is the same on both platforms, and each platform keeps its
   * own list: the Rust side keys a link by bot *and* platform, so Telegram's
   * authorisations must not show up on Discord and the other way round. What
   * this shows is that the panel asks for the list of the platform it is
   * showing, and shows that one.
   */
  test("the authorised list is the one of the platform on show", async () => {
    await createRoot(async () => {
      const asked: string[] = []
      const revoked: string[] = []
      const api: GatewayPanelApi = {
        status: async () => [
          {
            bot: BOT.path,
            platform: "telegram",
            enabled: true,
            running: true,
            connected: true,
            hasToken: true,
            authorized: [],
          },
        ],
        setToken: async () => {},
        clearToken: async () => {},
        probe: async () => "@bot_di_prova",
        setEnabled: async () => {},
        pairingList: async (bot, platform) => {
          asked.push(platform)
          return platform === "telegram"
            ? {
                open: true,
                pending: [],
                authorized: [{ id: "tg1", name: "Sandro su Telegram", addedMs: 0 }],
                attemptsLeft: 0,
              }
            : {
                open: false,
                pending: [],
                authorized: [{ id: "dc1", name: "Sandro su Discord", addedMs: 0 }],
                attemptsLeft: 0,
              }
        },
        pairingApprove: async () => ({ id: "u1", name: "qualcuno" }),
        pairingReject: async () => {},
        pairingRevoke: async (_bot, platform) => void revoked.push(platform),
        pairingOpen: async () => 0,
        listen: async () => () => {},
      }
      const panel = createGatewayPanel({
        bot: () => BOT,
        api,
        project: () => PROJECT,
        remote: memoryRemoteStore(),
        approve: async () => ({ ok: true, fingerprint: "f" }),
        confirm: async () => true,
      })
      try {
        await panel.refresh()
        // The list shown is the first asked; the other platforms are asked after it, for the badges of their tiles.
        expect(asked[0]).toBe("telegram")
        expect(asked.slice().sort()).toEqual(["discord", "slack", "telegram"])
        expect(panel.pairing().authorized.map((who) => who.id)).toEqual(["tg1"])
        expect(panel.pairing().open).toBe(true)

        // Discord has its own list, and the panel asks for that one and shows it.
        panel.choose("discord")
        await panel.refresh()
        expect(asked).toContain("discord")
        expect(panel.pairing().authorized.map((who) => who.id)).toEqual(["dc1"])
        expect(panel.pairing().open).toBe(false)

        // A revoking act goes to the platform it is looking at.
        await panel.revoke("dc1")
        expect(revoked).toEqual(["discord"])
      } finally {
        panel.dispose()
      }
    })
  })

  /*
   * Which platform the card opens on, with nothing new in the bot's file: the
   * one whose link is on, and Telegram when neither is. A choice the user makes
   * is theirs, so no later refresh takes it back.
   */
  const twoLinks = (links: Partial<GatewayStatus>[]) => async (): Promise<GatewayStatus[]> =>
    links.map((link) => ({
      enabled: false,
      running: false,
      connected: false,
      hasToken: false,
      ...link,
      bot: BOT.path,
      platform: link.platform ?? "telegram",
      authorized: [],
    }))

  const panelOver = (status: () => Promise<GatewayStatus[]>) =>
    createGatewayPanel({
      bot: () => BOT,
      api: {
        status,
        setToken: async () => {},
        clearToken: async () => {},
        probe: async () => "@bot",
        setEnabled: async () => {},
        pairingList: async () => ({ open: false, pending: [], authorized: [], attemptsLeft: 0 }),
        pairingApprove: async () => ({ id: "u1", name: "qualcuno" }),
        pairingReject: async () => {},
        pairingRevoke: async () => {},
        pairingOpen: async () => 0,
        listen: async () => () => {},
      },
      project: () => PROJECT,
      remote: memoryRemoteStore(),
      approve: async () => ({ ok: true, fingerprint: "f" }),
      confirm: async () => true,
    })

  test("the card opens on the platform whose link is on", async () => {
    await createRoot(async () => {
      const panel = panelOver(
        twoLinks([
          { platform: "telegram", enabled: false, running: false, connected: false, hasToken: true },
          { platform: "discord", enabled: true, running: true, connected: true, hasToken: true },
        ]),
      )
      try {
        await panel.refresh()
        expect(panel.platform()).toBe("discord")
        expect(panel.link().enabled).toBe(true)
      } finally {
        panel.dispose()
      }
    })
  })

  test("with no link on, the card opens on Telegram", async () => {
    await createRoot(async () => {
      const panel = panelOver(
        twoLinks([
          { platform: "telegram", enabled: false, running: false, connected: false, hasToken: true },
          { platform: "discord", enabled: false, running: false, connected: false, hasToken: true },
        ]),
      )
      try {
        await panel.refresh()
        expect(panel.platform()).toBe("telegram")
      } finally {
        panel.dispose()
      }
    })
  })

  test("a choice the user makes is not taken back by a later refresh", async () => {
    await createRoot(async () => {
      const panel = panelOver(
        twoLinks([
          { platform: "telegram", enabled: false, running: false, connected: false, hasToken: true },
          { platform: "discord", enabled: true, running: true, connected: true, hasToken: true },
        ]),
      )
      try {
        await panel.refresh()
        expect(panel.platform()).toBe("discord")
        // The user looks at Telegram, and Discord is still the one that is on.
        panel.choose("telegram")
        expect(panel.platform()).toBe("telegram")
        await panel.refresh()
        // The choice is the user's, not the state's.
        expect(panel.platform(), "la scelta e' dell'utente, non dello stato").toBe("telegram")
      } finally {
        panel.dispose()
      }
    })
  })
})

describe("the link or QR of a pairing (scelta 3)", () => {
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

  test("«Mostra il QR» asks Rust for a link of this bot and platform and keeps it; another one replaces it", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    const { panel } = panelWith(fake)
    await panel.ready
    expect(panel.pairLink()).toBeUndefined()
    await panel.makeLink()
    expect(fake.calls).toContain(`link ${BOT.path} telegram`)
    expect(panel.pairLink()?.url).toBe("https://t.me/mio_bot?start=TOKEN1")
    await panel.makeLink()
    expect(panel.pairLink()?.url).toBe("https://t.me/mio_bot?start=TOKEN2")
    panel.dispose()
  })

  test("the account that appears among the authorized while it is shown is the one it paired: the QR goes and the name is said", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    expect(panel.pairLink()).toBeDefined()
    expect(panel.linked()).toBeUndefined()
    // The owner scans it: Rust has a new authorized account, and the panel finds it while it waits.
    fake.setPairing({ open: false, pending: [], authorized: [{ id: "42", name: "Ale", addedMs: 1 }], attemptsLeft: 5, linkedBy: "42" })
    await wait()
    expect(panel.pairLink()).toBeUndefined()
    expect(panel.linked()).toBe("Ale")
    panel.dispose()
  })

  test("an account approved with a code meanwhile is not named: only the one Rust says the link paired", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    // A code is approved for another account: it appears among the authorized, the link is not used.
    fake.setPairing({ open: false, pending: [], authorized: [{ id: "8", name: "Altro", addedMs: 1 }], attemptsLeft: 5 })
    await wait()
    expect(panel.pairLink()).toBeDefined()
    expect(panel.linked()).toBeUndefined()
    // Then the link is used, by another account again: that one is named.
    fake.setPairing({
      open: false,
      pending: [],
      authorized: [
        { id: "8", name: "Altro", addedMs: 1 },
        { id: "42", name: "Ale", addedMs: 2 },
      ],
      attemptsLeft: 5,
      linkedBy: "42",
    })
    await wait()
    expect(panel.linked()).toBe("Ale")
    expect(panel.pairLink()).toBeUndefined()
    panel.dispose()
  })

  test("an account that was already paired does not end it; a new link starts again without the old name", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    fake.setPairing({ open: false, pending: [], authorized: [{ id: "1", name: "Prima", addedMs: 1 }], attemptsLeft: 5 })
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.refresh()
    await panel.makeLink()
    await wait()
    expect(panel.pairLink()).toBeDefined()
    expect(panel.linked()).toBeUndefined()
    panel.dispose()
  })

  test("another platform, or closing the card, ends it and the asking", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    panel.choose("discord")
    expect(panel.pairLink()).toBeUndefined()
    panel.choose("telegram")
    await panel.makeLink()
    panel.dispose()
    const before = fake.calls.length
    await wait(40)
    expect(fake.calls.length).toBe(before)
  })

  test("a Rust side without the command says so instead of failing silently", async () => {
    const fake = fakeApi({ enabled: true, running: true, hasToken: true })
    delete (fake.api as { pairingLink?: unknown }).pairingLink
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    expect(panel.pairLink()).toBeUndefined()
    expect(panel.problemIn("pair")).toBe(t("gateway.panel.linkMissing"))
    panel.dispose()
  })
})

describe("the QR is cancelled when it leaves the screen", () => {
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
  const cancels = (fake: ReturnType<typeof fakeApi>) => fake.calls.filter((call) => call.startsWith("cancel"))
  const live = () => fakeApi({ enabled: true, running: true, hasToken: true })

  test("closing the card or the page cancels it; with no QR there is nothing to cancel", async () => {
    const fake = live()
    const { panel } = panelWith(fake)
    await panel.ready
    panel.dispose()
    await wait(5)
    expect(cancels(fake)).toEqual([])
    const shown = live()
    const again = panelWith(shown)
    await again.panel.ready
    await again.panel.makeLink()
    again.panel.dispose()
    await wait(5)
    expect(cancels(shown)).toEqual([`cancel ${BOT.path} telegram`])
    expect(again.panel.pairLink()).toBeUndefined()
  })

  test("the step or the tab going away says so once: a second call finds nothing to cancel", async () => {
    const fake = live()
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    await panel.cancelLink()
    await panel.cancelLink()
    expect(cancels(fake)).toHaveLength(1)
    expect(panel.pairLink()).toBeUndefined()
    panel.dispose()
  })

  test("another platform cancels the one that was shown, by its own name", async () => {
    const fake = live()
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    panel.choose("discord")
    await wait(5)
    expect(cancels(fake)).toEqual([`cancel ${BOT.path} telegram`])
    panel.dispose()
  })

  test("the window hidden cancels it too, and the page showing again does not bring it back", async () => {
    const fake = live()
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    const was = Object.getOwnPropertyDescriptor(document, "visibilityState")
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    try {
      document.dispatchEvent(new Event("visibilitychange"))
      await wait(5)
      expect(cancels(fake)).toHaveLength(1)
      expect(panel.pairLink()).toBeUndefined()
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
      document.dispatchEvent(new Event("visibilitychange"))
      await wait(5)
      expect(panel.pairLink()).toBeUndefined()
      expect(cancels(fake)).toHaveLength(1)
    } finally {
      if (was) Object.defineProperty(document, "visibilityState", was)
      else Reflect.deleteProperty(document, "visibilityState")
      panel.dispose()
    }
  })

  test("a QR that paired the account is used up: there is nothing to cancel afterwards", async () => {
    const fake = live()
    const { panel } = panelWith(fake)
    await panel.ready
    await panel.makeLink()
    fake.setPairing({ open: false, pending: [], authorized: [{ id: "42", name: "Ale", addedMs: 1 }], attemptsLeft: 5, linkedBy: "42" })
    await wait()
    expect(panel.linked()).toBe("Ale")
    panel.dispose()

    await wait(5)
    expect(cancels(fake)).toEqual([])
  })

  test("the live status event updates connectedAtMs, reconnecting, and needsAttention with reason without polling", async () => {
    const fake = fakeApi({ enabled: true, running: true })
    const { panel } = panelWith(fake)
    await panel.ready

    fake.handlers.status?.({
      bot: BOT.path,
      platform: "telegram",
      running: true,
      connected: true,
      connectedAtMs: 1727260200000,
      reconnecting: false,
      needsAttention: false,
      lastMessageMs: 1727260210000,
    })
    await wait()

    expect(panel.link().connected).toBe(true)
    expect(panel.link().connectedAtMs).toBe(1727260200000)
    expect(panel.link().reconnecting).toBe(false)
    expect(panel.link().needsAttention).toBe(false)
    expect(panel.link().lastMessageMs).toBe(1727260210000)

    // Reconnecting transiently
    fake.handlers.status?.({
      bot: BOT.path,
      platform: "telegram",
      running: true,
      connected: false,
      connectedAtMs: null,
      reconnecting: true,
      needsAttention: false,
      lastError: "rete non raggiungibile",
    })
    await wait()

    expect(panel.link().connected).toBe(false)
    expect(panel.link().connectedAtMs).toBeNull()
    expect(panel.link().reconnecting).toBe(true)
    expect(panel.link().needsAttention).toBe(false)

    // Needs attention after fatal error
    fake.handlers.status?.({
      bot: BOT.path,
      platform: "telegram",
      running: false,
      connected: false,
      reconnecting: false,
      needsAttention: true,
      attentionReason: "token non valido",
      lastError: "token non valido",
    })
    await wait()

    expect(panel.link().running).toBe(false)
    expect(panel.link().connected).toBe(false)
    expect(panel.link().reconnecting).toBe(false)
    expect(panel.link().needsAttention).toBe(true)
    expect(panel.link().attentionReason).toBe("token non valido")
    panel.dispose()
  })
})

