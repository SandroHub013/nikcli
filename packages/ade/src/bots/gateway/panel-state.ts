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
 * then. The remote commands are the owner's, for ragu only, off by default,
 * and on only after an explicit confirmation, saved with the fingerprint of
 * the bot's file as it was at that yes (`remote.ts`).
 */

import { createSignal, type Accessor } from "solid-js"
import { t } from "../../i18n"
import type { AgentFile } from "../ragu"
import type { GatewayMessage } from "./controller"
import { onTurnFailure, turnFailureOf } from "./failures"
import { offersRemoteCommands, REMOTE_OFF, remoteKey, type RemoteStore } from "./remote"
import { currentStep, PLATFORM_IDS, stepsOf, tileState, type StepId, type TileState } from "./steps"

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
  readonly connectedAtMs?: number | null
  readonly reconnecting?: boolean
  readonly needsAttention?: boolean
  readonly attentionReason?: string | null
  readonly authorized: readonly Sender[]
}

/** `gateway:status`, as a running link changes. */
export interface LinkStatus {
  readonly bot: string
  readonly platform: string
  readonly enabled?: boolean
  readonly running: boolean
  readonly connected: boolean
  readonly lastError?: string | null
  readonly lastMessageMs?: number | null
  readonly connectedAtMs?: number | null
  readonly reconnecting?: boolean
  readonly needsAttention?: boolean
  readonly attentionReason?: string | null
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

/** A link and a QR for the owner's phone (Telegram): the address with the token in it, its picture, and when it stops. */
export interface PairingLinkInfo {
  readonly url: string
  readonly svg: string
  readonly expiresMs: number
}

export interface PairingInfo {
  readonly open: boolean
  readonly openUntilMs?: number | null
  readonly pending: readonly PairingRequest[]
  readonly authorized: readonly (Sender & { readonly addedMs: number })[]
  readonly lockedUntilMs?: number | null
  readonly attemptsLeft: number
  /** The id of the account the last link or QR paired (Rust forgets it when a new link is made). */
  readonly linkedBy?: string | null
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
  /** A link and a QR for the owner's phone: good for ten minutes and once, a new one cancels the old. Telegram only. */
  pairingLink?: (bot: string, platform: string) => Promise<PairingLinkInfo>
  /** The QR left the screen: its token is cancelled, so a photo of it pairs nobody. Nothing to cancel is no error. */
  pairingLinkCancel?: (bot: string, platform: string) => Promise<void>
  /** Wakes all gateways or relaunches them immediately (network restore or wake from sleep). */
  wake?: () => Promise<void>
  /** Retries a specific bot gateway immediately, resetting backoff if waiting. */
  retry?: (bot: string, platform: string) => Promise<void>
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
  /** Opens a page (BotFather, the developer portal) in the system browser; absent, the step shows the address. */
  readonly openLink?: (url: string) => void
  /** How often the panel asks whether the link was used while one is shown. Absent, 2.5 seconds; a test passes its own. */
  readonly linkPollMs?: number
}

const OFF: GatewayStatus = {
  bot: "",
  platform: "",
  enabled: false,
  running: false,
  connected: false,
  hasToken: false,
  authorized: [],
  connectedAtMs: null,
  reconnecting: false,
  needsAttention: false,
  attentionReason: null,
}

const NO_PAIRING: PairingInfo = { open: false, pending: [], authorized: [], attemptsLeft: 0 }

/**
 * Where on the screen a failure belongs (D11): the step whose button caused it. A failure shows by that button, not
 * at the foot of the section; `remote` is the commands' switch below the steps.
 */
export type ProblemArea = StepId | "remote"

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
  const [problemArea, setProblemArea] = createSignal<ProblemArea>()
  // Every platform of this bot, for the tiles: what each one is doing and how many requests wait on it.
  const [links, setLinks] = createSignal<Readonly<Record<string, GatewayStatus>>>({})
  const [waiting, setWaiting] = createSignal<Readonly<Record<string, number>>>({})
  const [probed, setProbed] = createSignal<string>()
  const [redactedAt, setRedactedAt] = createSignal<number>()
  // The last chat turn that failed (S10): read again whenever one is noted or the platform changes.
  const [failureTick, setFailureTick] = createSignal(0)
  const stopFailures = onTurnFailure(() => setFailureTick((tick) => tick + 1))
  const turnFailure = () => (failureTick(), turnFailureOf(path(), platform()))
  const [confirmingRemote, setConfirmingRemote] = createSignal(false)
  // The link or QR being shown, and the name of the account it paired once it did. Only in memory: the token is in `url`.
  const [pairLink, setPairLink] = createSignal<PairingLinkInfo>()
  const [linked, setLinked] = createSignal<string>()
  let poll: ReturnType<typeof setInterval> | undefined
  /** The window hidden (closed to the tray, minimized) is the QR off the screen too. */
  const onHidden = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") void cancelLink()
  }
  const stopPoll = () => {
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHidden)
  }
  /**
   * The link or QR left the screen (another tab, step, platform or bot, the card closed, the window hidden): the token is
   * cancelled in Rust, so a photo of the QR or a shared screen pairs nobody later. Idempotent; a failure is not shown, the
   * token runs out in ten minutes anyway.
   */
  const cancelLink = async (on: string = platform()) => {
    stopPoll()
    if (!pairLink()) return
    setPairLink(undefined)
    try {
      await deps.api.pairingLinkCancel?.(path(), on)
    } catch {
      // Nothing to show: the token has its own end.
    }
  }
  const [remote, setRemote] = createSignal(deps.remote.get(remoteKey(path(), platform())))

  const refresh = async () => {
    try {
      const all = await deps.api.status()
      if (!pinned && !chosen) {
        // Before anything else: the card opens on the platform that is on.
        const open = openOf(all)
        if (open !== undefined && open !== platform()) setPlatform(open)
      }
      setLink(all.find(mine) ?? { ...OFF, bot: path(), platform: platform() })
      setLinks(Object.fromEntries(all.filter((item) => item.bot === path()).map((item) => [item.platform, item])))
      setPairing(await deps.api.pairingList(path(), platform()))
      setRemote(deps.remote.get(remoteKey(path(), platform())))
      await refreshWaiting()
    } catch (error) {
      setProblem(reason(error))
      setProblemArea(undefined)
    }
  }

  const onOnline = () => {
    void deps.api.wake?.()
    void refresh()
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline)
  }


  /** The requests waiting on the platforms the panel is not looking at: a badge on their tiles. */
  const refreshWaiting = async () => {
    const counts: Record<string, number> = {}
    for (const other of PLATFORM_IDS) {
      if (other === platform()) continue
      try {
        counts[other] = (await deps.api.pairingList(path(), other)).pending.length
      } catch {
        // A platform that cannot be read has no badge; the tile still shows its state.
        counts[other] = 0
      }
    }
    setWaiting(counts)
  }

  /** One action at a time; its failure is the panel's problem line, shown by the button of `area` (D11). */
  const act = async (work: () => Promise<unknown>, area?: ProblemArea) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    setProblemArea(undefined)
    try {
      await work()
    } catch (error) {
      setProblem(reason(error))
      setProblemArea(area)
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
        if (status.bot === path()) {
          setLinks((current) => ({
            ...current,
            [status.platform]: {
              ...(current[status.platform] ?? { ...OFF, bot: status.bot, platform: status.platform }),
              running: status.running,
              connected: status.connected,
              lastError: status.lastError ?? null,
              lastMessageMs: status.lastMessageMs ?? current[status.platform]?.lastMessageMs ?? null,
              connectedAtMs: status.connectedAtMs !== undefined ? status.connectedAtMs : current[status.platform]?.connectedAtMs ?? null,
              reconnecting: status.reconnecting ?? false,
              needsAttention: status.needsAttention ?? false,
              attentionReason: status.attentionReason ?? null,
            },
          }))
        }
        if (!mine(status)) return
        setLink((current) => ({
          ...current,
          running: status.running,
          connected: status.connected,
          lastError: status.lastError ?? null,
          lastMessageMs: status.lastMessageMs ?? current.lastMessageMs ?? null,
          connectedAtMs: status.connectedAtMs !== undefined ? status.connectedAtMs : current.connectedAtMs ?? null,
          reconnecting: status.reconnecting ?? false,
          needsAttention: status.needsAttention ?? false,
          attentionReason: status.attentionReason ?? null,
        }))
      },

      pairing: (request) => {
        // Another platform's request is a badge on its tile; this one's is the list.
        if (request.bot === path()) void refresh()
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
      const was = platform()
      setPlatform(next)
      setDraft("")
      setAppDraft("")
      setManifest(undefined)
      setProbed(undefined)
      setProblem(undefined)
      setProblemArea(undefined)
      setRedactedAt(undefined)
      // The link was for the other platform's bot.
      void cancelLink(was)
      setLinked(undefined)
      void refresh()
    },
    link,
    pairing,
    pairLink,
    /** The account the link just paired, until the next one is made. */
    linked,
    draft,
    setDraft,
    appDraft,
    setAppDraft,
    manifest,
    needsAppToken,
    tokensReady,
    busy,
    problem,
    /** The failure, only if it belongs to `area`; the ones without an area are `problemIn(undefined)`. */
    problemIn: (area: ProblemArea | undefined) => (problemArea() === area ? problem() : undefined),
    probed,
    /** What a tile shows for `platform`: its state, and the pairing requests waiting on it. */
    tile: (id: string): { readonly state: TileState; readonly waiting: number } => {
      const here = id === platform()
      return {
        state: tileState(here ? link() : links()[id]),
        waiting: here ? pairing().pending.length : (waiting()[id] ?? 0),
      }
    },
    /** The five steps and which are done, for the platform shown. */
    steps: () =>
      stepsOf({
        hasToken: link().hasToken,
        tokensReady: tokensReady(),
        probed: probed() !== undefined,
        enabled: link().enabled,
        authorized: pairing().authorized.length,
      }),
    /** The step the user is at. */
    at: () =>
      currentStep(
        stepsOf({
          hasToken: link().hasToken,
          tokensReady: tokensReady(),
          probed: probed() !== undefined,
          enabled: link().enabled,
          authorized: pairing().authorized.length,
        }),
      ),
    redactedAt,
    turnFailure,
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
      return act(() => deps.api.setToken(path(), platform(), token), "paste")
    },
    /** Slack's App-Level Token, the same way: the draft emptied first. */
    saveAppToken: () => {
      const token = appDraft().trim()
      setAppDraft("")
      if (!token) return Promise.resolve()
      setProbed(undefined)
      return act(() => deps.api.setToken(path(), platform(), token, "app"), "paste")
    },
    /** The Slack app's manifest, made by Rust for this bot's name. */
    showManifest: () =>
      act(async () => {
        const make = deps.api.slackManifest
        if (!make) throw new Error(t("gateway.panel.slackManifestMissing"))
        setManifest(await make(deps.bot().identifier))
      }, "create"),
    clearToken: () => act(() => deps.api.clearToken(path(), platform()), "paste"),
    probe: () =>
      act(async () => {
        setProbed(undefined)
        setProbed(await deps.api.probe(path(), platform()))
      }, "test"),

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
      }, "on"),

    approve: (code: string) => act(() => deps.api.pairingApprove(path(), platform(), code.trim()), "pair"),
    reject: (request: string) => act(() => deps.api.pairingReject(path(), platform(), request), "pair"),
    revoke: (sender: string) => act(() => deps.api.pairingRevoke(path(), platform(), sender), "pair"),
    openPairing: () => act(() => deps.api.pairingOpen(path(), platform()), "pair"),
    /**
     * A new link and QR (the old one is cancelled by Rust). While it is shown the panel asks every few seconds whether it
     * was used: Rust says which account the link paired (not whichever appeared, a code approved meanwhile is not it),
     * and the QR goes.
     */
    makeLink: () =>
      act(async () => {
        const make = deps.api.pairingLink
        if (!make) throw new Error(t("gateway.panel.linkMissing"))
        stopPoll()
        setLinked(undefined)
        const made = await make(path(), platform())
        setPairLink(made)
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHidden)
        poll = setInterval(() => {
          if (disposed || now() >= made.expiresMs) return stopPoll()
          void refresh().then(() => {
            const id = pairing().linkedBy
            if (!id || pairLink() !== made) return
            // Used up by that account: nothing left to cancel.
            setLinked(pairing().authorized.find((account) => account.id === id)?.name ?? id)
            setPairLink(undefined)
            stopPoll()
          })
        }, deps.linkPollMs ?? 2500)
      }, "pair"),

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
        deps.remote.set(remoteKey(path(), platform()), { commands: true, fingerprint: trusted.fingerprint })
      }, "remote"),
    remoteOff: () =>
      act(async () => {
        setConfirmingRemote(false)
        deps.remote.set(remoteKey(path(), platform()), REMOTE_OFF)
      }, "remote"),

    /** The link or QR left the screen: see `cancelLink`. */
    cancelLink: () => cancelLink(),
    /** Retries connecting immediately, resetting backoff if waiting or relaunching if stopped. */
    retry: () =>
      act(async () => {
        await deps.api.retry?.(path(), platform())
        await refresh()
      }),
    dispose: () => {
      disposed = true
      void cancelLink()
      stopFailures()
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline)
      }
      unlisten?.()
    },
  }
}

export type GatewayPanel = ReturnType<typeof createGatewayPanel>
