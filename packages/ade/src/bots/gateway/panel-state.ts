/**
 * The Gateway section of a bot's card, without the view (G6): what the panel
 * shows of one bot's gateway on one platform, and what its buttons do.
 *
 * The token goes one way: typed here, handed to Rust, forgotten. Nothing in
 * this state holds it after `saveToken`, the draft included, so the page can
 * never show it again; Rust says only whether there is one (`hasToken`).
 * Slack has a second one, the App-Level Token that opens its socket, which
 * goes the same way (`hasAppToken`); the manifest of the user's Slack app is
 * made by Rust, with the scopes its probe checks.
 *
 * Switching on asks for the trust the turns need (`approve`: the dialogs of
 * B3/B3b, then the check every chat turn repeats), with the project fixed
 * then. The remote commands are the owner's, for nikcli only, off by default,
 * and on only after an explicit confirmation, saved with the fingerprint of
 * the bot's file as it was at that yes (`remote.ts`).
 */

import { createSignal, type Accessor } from "solid-js"
import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import type { GatewayMessage } from "./controller"
import { offersRemoteCommands, REMOTE_OFF, type RemoteStore } from "./remote"

export interface Sender {
  readonly id: string
  readonly name: string
}

/** `gateway_status`, one link. */
export interface GatewayStatus {
  readonly bot: string
  readonly platform: string
  readonly enabled: boolean
  readonly running: boolean
  readonly connected: boolean
  readonly hasToken: boolean
  /** Slack's App-Level Token is saved; absent on the other platforms. */
  readonly hasAppToken?: boolean
  readonly project?: string | null
  readonly lastError?: string | null
  readonly lastMessageMs?: number | null
  readonly authorized: readonly Sender[]
}

/** `gateway:status`, as a running link changes. */
export interface LinkStatus {
  readonly bot: string
  readonly platform: string
  readonly running: boolean
  readonly connected: boolean
  readonly lastError?: string | null
  readonly lastMessageMs?: number | null
}

/** `gateway:pairing`, and one waiting request in `gateway_pairing_list`. Never a code. */
export interface PairingRequest {
  readonly bot: string
  readonly platform: string
  readonly request: string
  readonly sender: Sender
  readonly createdMs: number
  readonly expiresMs: number
}

export interface PairingInfo {
  readonly open: boolean
  readonly openUntilMs?: number | null
  readonly pending: readonly PairingRequest[]
  readonly authorized: readonly (Sender & { readonly addedMs: number })[]
  readonly lockedUntilMs?: number | null
  readonly attemptsLeft: number
}

/** Which of a link's secrets: the bot's token, or Slack's App-Level Token. */
export type TokenKind = "bot" | "app"

/** The Rust side, as the panel sees it. Tests pass a fake. */
export interface GatewayPanelApi {
  status: () => Promise<readonly GatewayStatus[]>
  setToken: (bot: string, platform: string, token: string, kind?: TokenKind) => Promise<void>
  /** The manifest of a Slack app for the bot called `name`. */
  slackManifest?: (name: string) => Promise<string>
  clearToken: (bot: string, platform: string) => Promise<void>
  probe: (bot: string, platform: string) => Promise<string>
  setEnabled: (bot: string, platform: string, enabled: boolean, project?: string) => Promise<void>
  pairingList: (bot: string, platform: string) => Promise<PairingInfo>
  pairingApprove: (bot: string, platform: string, code: string) => Promise<Sender>
  pairingReject: (bot: string, platform: string, request: string) => Promise<void>
  pairingRevoke: (bot: string, platform: string, sender: string) => Promise<void>
  pairingOpen: (bot: string, platform: string) => Promise<number>
  /** `gateway:status`, `gateway:pairing` and `gateway:message`; resolves with the way to stop. */
  listen: (handlers: {
    status: (status: LinkStatus) => void
    pairing: (request: PairingRequest) => void
    message: (message: GatewayMessage) => void
  }) => Promise<() => void>
}

export interface GatewayPanelDeps {
  readonly api: GatewayPanelApi
  readonly bot: Accessor<AgentFile>
  /** The project open now: where the turns would run if switched on now. */
  readonly project: Accessor<string | undefined>
  readonly remote: RemoteStore
  /**
   * The trust a chat's turns need, asked with ADE's dialogs, then checked as
   * every chat turn checks it; with the fingerprint of the file as read.
   */
  readonly approve: (
    bot: AgentFile,
    project: string,
  ) => Promise<{ ok: true; fingerprint: string } | { ok: false; problem?: string }>
  /** Asks the user a yes or no in ADE: switching on in another project than before. */
  readonly confirm: (question: string) => Promise<boolean>
  readonly platform?: string
  readonly now?: () => number
}

const OFF: GatewayStatus = {
  bot: "",
  platform: "",
  enabled: false,
  running: false,
  connected: false,
  hasToken: false,
  authorized: [],
}
const NO_PAIRING: PairingInfo = { open: false, pending: [], authorized: [], attemptsLeft: 0 }

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createGatewayPanel(deps: GatewayPanelDeps) {
  const now = deps.now ?? Date.now
  const path = () => deps.bot().path
  // Which platform this card is looking at. Both links are kept by the Rust
  // side, so switching here never loses the other one.
  //
  // A caller can pin the platform; otherwise the card opens on the one whose
  // link is on, and on Telegram when neither is. Which platform that is can
  // only be known once the status has arrived, so it is decided on the first
  // refresh, and a choice the user makes is never taken back.
  const [platform, setPlatform] = createSignal(deps.platform ?? "telegram")
  const pinned = deps.platform !== undefined
  let chosen = false
  const mine = (item: { bot: string; platform: string }) => item.bot === path() && item.platform === platform()
  /** The platform a link of which is on: enabled, or running. */
  const openOf = (all: readonly GatewayStatus[]) =>
    all.find((link) => link.bot === path() && (link.enabled || link.running))?.platform

  const [link, setLink] = createSignal<GatewayStatus>({ ...OFF, bot: path(), platform: platform() })
  const [pairing, setPairing] = createSignal<PairingInfo>(NO_PAIRING)
  const [draft, setDraft] = createSignal("")
  const [appDraft, setAppDraft] = createSignal("")
  const [manifest, setManifest] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [probed, setProbed] = createSignal<string>()
  const [redactedAt, setRedactedAt] = createSignal<number>()
  const [confirmingRemote, setConfirmingRemote] = createSignal(false)
  const [remote, setRemote] = createSignal(deps.remote.get(path()))

  const refresh = async () => {
    try {
      const all = await deps.api.status()
      if (!pinned && !chosen) {
        // Before anything else: the card opens on the platform that is on.
        const open = openOf(all)
        if (open !== undefined && open !== platform()) setPlatform(open)
      }
      setLink(all.find(mine) ?? { ...OFF, bot: path(), platform: platform() })
      setPairing(await deps.api.pairingList(path(), platform()))
      setRemote(deps.remote.get(path()))
    } catch (error) {
      setProblem(reason(error))
    }
  }

  /** One action at a time; its failure is the panel's problem line. */
  const act = async (work: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      await work()
    } catch (error) {
      setProblem(reason(error))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  let unlisten: (() => void) | undefined
  let disposed = false
  const ready = deps.api
    .listen({
      status: (status) => {
        if (!mine(status)) return
        setLink((current) => ({
          ...current,
          running: status.running,
          connected: status.connected,
          lastError: status.lastError ?? null,
          lastMessageMs: status.lastMessageMs ?? current.lastMessageMs ?? null,
        }))
      },
      pairing: (request) => {
        if (mine(request)) void refresh()
      },
      message: (message) => {
        if (mine(message) && message.redacted) setRedactedAt(now())
      },
    })
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch((error) => setProblem(reason(error)))

  /** On: the project fixed then. Off: the one open now, where switching on would fix it. */
  const where = () => (link().enabled ? link().project : undefined) ?? deps.project()
  /** Off, fixed before on another project than the one open now: switching on moves the turns (G6 review, BASSO 2). */
  const previous = () => {
    const before = link().project
    return !link().enabled && before && before !== deps.project() ? before : undefined
  }
  /** Slack reads through a socket opened with a second token. */
  const needsAppToken = () => platform() === "slack"
  /** Every token the platform needs is saved. */
  const tokensReady = () => link().hasToken && (!needsAppToken() || link().hasAppToken === true)

  return {
    platform,
    setPlatform,
    /**
     * Shows the other platform. The typed token and the name it probed are the
     * other platform's, so they are dropped rather than shown against the wrong
     * one; a token already saved is in the keychain and stays there.
     */
    choose: (next: string) => {
      chosen = true
      if (next === platform()) return
      setPlatform(next)
      setDraft("")
      setAppDraft("")
      setManifest(undefined)
      setProbed(undefined)
      setProblem(undefined)
      setRedactedAt(undefined)
      void refresh()
    },
    link,
    pairing,
    draft,
    setDraft,
    appDraft,
    setAppDraft,
    manifest,
    needsAppToken,
    tokensReady,
    busy,
    problem,
    probed,
    redactedAt,
    remote,
    confirmingRemote,
    /** Whether the remote commands switch means anything for this bot. */
    offersRemote: () => offersRemoteCommands(deps.bot().runner),
    /** Where the chat's turns run: the project fixed when switched on, or the one open now. */
    where,
    previous,
    /** Reading: only then does a stranger writing get a code (G6 review, BASSO 1). */
    live: () => link().enabled && link().running,
    ready,
    refresh,

    /** The token goes to the keychain; the draft is emptied first, whatever happens next. */
    saveToken: () => {
      const token = draft().trim()
      setDraft("")
      if (!token) return Promise.resolve()
      setProbed(undefined)
      return act(() => deps.api.setToken(path(), platform(), token))
    },
    /** Slack's App-Level Token, the same way: the draft emptied first. */
    saveAppToken: () => {
      const token = appDraft().trim()
      setAppDraft("")
      if (!token) return Promise.resolve()
      setProbed(undefined)
      return act(() => deps.api.setToken(path(), platform(), token, "app"))
    },
    /** The Slack app's manifest, made by Rust for this bot's name. */
    showManifest: () =>
      act(async () => {
        const make = deps.api.slackManifest
        if (!make) throw new Error(t("gateway.panel.slackManifestMissing"))
        setManifest(await make(deps.bot().identifier))
      }),
    clearToken: () => act(() => deps.api.clearToken(path(), platform())),
    probe: () =>
      act(async () => {
        setProbed(undefined)
        setProbed(await deps.api.probe(path(), platform()))
      }),

    /** On: the trust asked, the project fixed. Off: at once. */
    setEnabled: (on: boolean) =>
      act(async () => {
        if (!on) return deps.api.setEnabled(path(), platform(), false)
        const project = deps.project()
        if (!project) throw new Error(t("gateway.panel.noProject"))
        if (!link().hasToken) throw new Error(t("gateway.panel.needToken"))
        if (!tokensReady()) throw new Error(t("gateway.panel.needAppToken"))
        const before = previous()
        if (before && !(await deps.confirm(t("gateway.panel.moveProject", before, project)))) return
        const trusted = await deps.approve(deps.bot(), project)
        if (!trusted.ok) {
          if (trusted.problem) throw new Error(trusted.problem)
          return
        }
        await deps.api.setEnabled(path(), platform(), true, project)
      }),

    approve: (code: string) => act(() => deps.api.pairingApprove(path(), platform(), code.trim())),
    reject: (request: string) => act(() => deps.api.pairingReject(path(), platform(), request)),
    revoke: (sender: string) => act(() => deps.api.pairingRevoke(path(), platform(), sender)),
    openPairing: () => act(() => deps.api.pairingOpen(path(), platform())),

    /** The first step: the panel says what turning them on means, and waits for the yes. */
    askRemote: () => {
      if (offersRemoteCommands(deps.bot().runner)) setConfirmingRemote(true)
    },
    cancelRemote: () => setConfirmingRemote(false),
    /** The yes: saved with the fingerprint of the file as checked now, or not at all. */
    confirmRemote: () =>
      act(async () => {
        setConfirmingRemote(false)
        if (!offersRemoteCommands(deps.bot().runner)) return
        const project = where()
        if (!project) throw new Error(t("gateway.panel.noProject"))
        const trusted = await deps.approve(deps.bot(), project)
        if (!trusted.ok) {
          if (trusted.problem) throw new Error(trusted.problem)
          return
        }
        deps.remote.set(path(), { commands: true, fingerprint: trusted.fingerprint })
      }),
    remoteOff: () =>
      act(async () => {
        setConfirmingRemote(false)
        deps.remote.set(path(), REMOTE_OFF)
      }),

    dispose: () => {
      disposed = true
      unlisten?.()
    },
  }
}

export type GatewayPanel = ReturnType<typeof createGatewayPanel>
