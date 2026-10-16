/**
 * The Platforms tab of a bot's page (G6, scelta 2): the bot on Telegram, Discord
 * or Slack, on and off.
 *
 * Three tiles show how each platform stands; opening one starts the procedure in
 * five steps — create the bot, paste its code, try it, turn it on, pair your
 * account — with the point you are at. The instructions come before the field
 * they are for (D3), and a failure shows by the button that caused it (D11).
 *
 * What it does lives in `panel-state.ts` and `steps.ts`; this is how it looks.
 * The bot's code is a password field, emptied the moment it is saved, and nothing
 * shows it again: only whether one is saved.
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { ConfirmAction } from "../confirm"
import { remoteNeverKey } from "../permissions-facts"
import { formatClock } from "../format"
import type { AgentFile } from "../ragu"
import { runnerById } from "../runners"
import { createGatewayPanel, type GatewayPanelDeps, type ProblemArea } from "./panel-state"
import { CREATE_LINK, STEP_IDS, type PlatformId, type StepId, type TileState } from "./steps"

const time = (ms: number) => formatClock(ms)

const PLATFORMS: readonly { readonly id: PlatformId; readonly label: () => string }[] = [
  { id: "telegram", label: () => t("gateway.panel.platformTelegram") },
  { id: "discord", label: () => t("gateway.panel.platformDiscord") },
  { id: "slack", label: () => t("gateway.panel.platformSlack") },
]

const TILE_TEXT: Record<TileState, () => string> = {
  on: () => t("gateway.tile.on"),
  connecting: () => t("gateway.tile.connecting"),
  setup: () => t("gateway.tile.setup"),
  error: () => t("gateway.tile.error"),
}

const TILE_TONE: Record<TileState, string> = { on: "on", connecting: "wait", setup: "off", error: "error" }

const STEP_TITLE: Record<StepId, () => string> = {
  create: () => t("gateway.step.create"),
  paste: () => t("gateway.step.paste"),
  test: () => t("gateway.step.test"),
  on: () => t("gateway.step.on"),
  pair: () => t("gateway.step.pair"),
}

export function GatewaySection(props: { bot: AgentFile; deps: Omit<GatewayPanelDeps, "bot"> }) {
  const panel = createGatewayPanel({ ...props.deps, bot: () => props.bot })
  const [code, setCode] = createSignal("")
  // The tile open: undefined until the user chooses, then the platform (null: closed). Until then the one that is on.
  const [chosen, setChosen] = createSignal<string | null>()
  // The step the user opened by hand; until then the one they are at.
  const [picked, setPicked] = createSignal<StepId>()
  onMount(() => void panel.refresh())
  onCleanup(() => panel.dispose())

  const onDiscord = () => panel.platform() === "discord"
  const onSlack = () => panel.platform() === "slack"
  /** The platform's own text for `key`, the Telegram one when it has none. */
  const said = (telegram: string, discord: string, slack: string) =>
    onSlack() ? slack : onDiscord() ? discord : telegram

  const opened = () => {
    const value = chosen()
    return value === undefined ? panel.link().enabled : value === panel.platform()
  }
  const choose = (id: string) => {
    const closing = opened() && panel.platform() === id
    setChosen(closing ? null : id)
    setPicked(undefined)
    panel.choose(id)
  }
  const stepShown = () => picked() ?? panel.at()
  const stepState = (id: StepId) => {
    const step = panel.steps().find((item) => item.id === id)
    return step?.done ? "done" : panel.at() === id ? "here" : "todo"
  }

  const state = () => {
    const link = panel.link()
    if (!link.enabled) return { tone: "off", text: t("gateway.panel.off") }
    if (!link.running) return { tone: "error", text: t("gateway.panel.stopped") }
    return link.connected
      ? { tone: "on", text: t("gateway.panel.connected") }
      : { tone: "wait", text: t("gateway.panel.connecting") }
  }

  const approve = () => {
    const typed = code()
    setCode("")
    void panel.approve(typed)
  }

  /** A failure, by the button that caused it. */
  const Failure = (area: { of: ProblemArea | undefined }) => (
    <Show when={panel.problemIn(area.of)}>{(text) => <p data-slot="bots-problem" role="alert">{text()}</p>}</Show>
  )

  /** A link to the place the bot is made: the system browser in the app, the address as text elsewhere. */
  const Opener = (link: { label: string }) => {
    const url = () => CREATE_LINK[panel.platform() as PlatformId]
    return (
      <Show
        when={props.deps.openLink}
        fallback={
          <p data-slot="bots-hint">
            {link.label}: <code>{url()}</code>
          </p>
        }
      >
        {(open) => (
          <div data-slot="gateway-row">
            <button type="button" data-slot="bots-btn" onClick={() => open()(url())}>
              {link.label}
            </button>
          </div>
        )}
      </Show>
    )
  }

  return (
    <section data-component="bot-gateway" data-slot="bots-section" aria-labelledby="gateway-heading">
      <h3 data-slot="bots-section-title" id="gateway-heading">
        {t("gateway.panel.heading")}
      </h3>

      {/* Which platform: every link is kept, so this only chooses what is shown below. */}
      <div data-slot="gateway-tiles" role="group" aria-label={t("gateway.panel.platform")}>
        <For each={PLATFORMS}>
          {(item) => {
            const tile = () => panel.tile(item.id)
            return (
              <button
                type="button"
                data-slot="gateway-tile"
                data-state={tile().state}
                aria-pressed={opened() && panel.platform() === item.id}
                aria-label={
                  tile().waiting > 0
                    ? t("gateway.tile.ariaWaiting", item.label(), TILE_TEXT[tile().state](), tile().waiting)
                    : t("gateway.tile.aria", item.label(), TILE_TEXT[tile().state]())
                }
                onClick={() => choose(item.id)}
              >
                <span data-slot="gateway-tile-name">{item.label()}</span>
                <span data-slot="gateway-state" data-tone={TILE_TONE[tile().state]}>
                  <span data-slot="gateway-dot" aria-hidden="true" />
                  <span>{TILE_TEXT[tile().state]()}</span>
                </span>
                <Show when={tile().waiting > 0}>
                  <span data-slot="gateway-badge">{t("gateway.tile.waiting", tile().waiting)}</span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>

      <Show when={!opened()}>
        <p data-slot="bots-hint">{t("gateway.panel.chooseHint")}</p>
      </Show>

      <Show when={opened()}>
        <p data-slot="bots-hint">
          {said(t("gateway.panel.intro"), t("gateway.panel.introDiscord"), t("gateway.panel.introSlack"))}
        </p>

        <div data-slot="gateway-state" data-tone={state().tone} role="status">
          <span data-slot="gateway-dot" aria-hidden="true" />
          <span>{state().text}</span>
          <Show when={panel.link().lastMessageMs}>
            {(at) => <span data-slot="gateway-meta">{t("gateway.panel.lastMessage", time(at()))}</span>}
          </Show>
        </div>
        <Show when={panel.link().enabled && panel.link().lastError}>
          {(error) => <p data-slot="bots-problem">{error()}</p>}
        </Show>
        <Show when={panel.turnFailure()}>
          {(failure) => (
            <p data-slot="bots-problem">{t("gateway.panel.turnFailed", time(failure().at), failure().detail)}</p>
          )}
        </Show>
        <Show when={panel.redactedAt()}>
          {(at) => (
            <p data-slot="bots-hint" data-state="warn">
              {t("gateway.panel.redacted", time(at()))}
            </p>
          )}
        </Show>

        <ol data-slot="gateway-steps" aria-label={t("gateway.step.list")}>
          <For each={STEP_IDS}>
            {(id, index) => (
              <li data-slot="gateway-step" data-step={id} data-state={stepState(id)}>
                <button
                  type="button"
                  data-slot="gateway-step-head"
                  aria-expanded={stepShown() === id}
                  aria-current={panel.at() === id ? "step" : undefined}
                  onClick={() => setPicked(stepShown() === id ? undefined : id)}
                >
                  <span data-slot="gateway-step-number" aria-hidden="true">
                    {index() + 1}
                  </span>
                  <span data-slot="gateway-step-title">{STEP_TITLE[id]()}</span>
                  <span data-slot="gateway-step-status">
                    {stepState(id) === "done"
                      ? t("gateway.step.done")
                      : stepState(id) === "here"
                        ? t("gateway.step.here")
                        : ""}
                  </span>
                </button>

                <Show when={stepShown() === id}>
                  <div data-slot="gateway-step-body">
                    <Show when={id === "create"}>
                      {/* The instructions first; the code is pasted in the next step. */}
                      <p data-slot="bots-hint">
                        {said(
                          t("gateway.step.createTelegram"),
                          t("gateway.panel.portalWhere"),
                          t("gateway.panel.slackManifestHow"),
                        )}
                      </p>
                      <Opener
                        label={said(
                          t("gateway.step.openTelegram"),
                          t("gateway.step.openDiscord"),
                          t("gateway.step.openSlack"),
                        )}
                      />
                      <Show when={onDiscord()}>
                        <p data-slot="bots-hint" data-state="warn">
                          {t("gateway.panel.intentsOff")}
                        </p>
                        <p data-slot="bots-hint">{t("gateway.panel.invite")}</p>
                        <p data-slot="bots-hint" data-state="warn">
                          {t("gateway.noProxy")}
                        </p>
                      </Show>
                      <Show when={onSlack()}>
                        <Show
                          when={panel.manifest()}
                          fallback={
                            <div data-slot="gateway-row">
                              <button
                                type="button"
                                data-slot="bots-btn"
                                disabled={panel.busy()}
                                onClick={() => void panel.showManifest()}
                              >
                                {t("gateway.panel.slackManifestShow")}
                              </button>
                            </div>
                          }
                        >
                          {(manifest) => (
                            <textarea
                              data-slot="bots-input"
                              data-role="manifest"
                              readonly
                              rows={12}
                              spellcheck={false}
                              aria-label={t("gateway.panel.slackManifest")}
                              value={manifest()}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                          )}
                        </Show>
                        <Failure of="create" />
                        <p data-slot="bots-hint" data-state="warn">
                          {t("gateway.panel.slackReinstall")}
                        </p>
                        <p data-slot="bots-hint">{t("gateway.panel.slackInvite")}</p>
                        <p data-slot="bots-hint" data-state="warn">
                          {t("gateway.noProxySlack")}
                        </p>
                      </Show>
                      <div data-slot="gateway-row">
                        <button type="button" data-slot="bots-btn" data-tone="primary" onClick={() => setPicked("paste")}>
                          {t("gateway.step.next")}
                        </button>
                      </div>
                    </Show>

                    <Show when={id === "paste"}>
                      {/* The instructions before the field (D3). */}
                      <p data-slot="bots-hint">
                        {said(
                          t("gateway.panel.tokenHelp"),
                          t("gateway.panel.tokenHelpDiscord"),
                          t("gateway.panel.tokenHelpSlack"),
                        )}
                      </p>
                      <Show when={panel.link().hasToken}>
                        <p data-slot="bots-hint" data-state="saved">
                          {t("gateway.panel.tokenSaved")}
                          <Show when={panel.probed()}>{(name) => <> · {t("gateway.panel.probed", name())}</>}</Show>
                        </p>
                      </Show>
                      {/* A secret zone: a recording covers what is typed here (`record/sensitive.ts`). */}
                      <form
                        data-slot="gateway-row"
                        data-secrets
                        autocomplete="off"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void panel.saveToken()
                        }}
                      >
                        <input
                          data-slot="bots-input"
                          type="password"
                          autocomplete="off"
                          spellcheck={false}
                          placeholder={
                            panel.link().hasToken
                              ? t("gateway.panel.tokenReplace")
                              : said(
                                  t("gateway.panel.tokenPlaceholder"),
                                  t("gateway.panel.tokenPlaceholderDiscord"),
                                  t("gateway.panel.tokenPlaceholderSlack"),
                                )
                          }
                          aria-label={t("gateway.panel.token")}
                          value={panel.draft()}
                          onInput={(event) => panel.setDraft(event.currentTarget.value)}
                        />
                        <button
                          type="submit"
                          data-slot="bots-btn"
                          disabled={panel.busy() || panel.draft().trim() === ""}
                        >
                          {t("gateway.panel.save")}
                        </button>
                      </form>

                      {/* Slack's second code: the one that opens the socket, made by hand in the app. */}
                      <Show when={panel.needsAppToken()}>
                        <span data-slot="gateway-subtitle">{t("gateway.panel.appToken")}</span>
                        <p data-slot="bots-hint">{t("gateway.panel.appTokenHelp")}</p>
                        <Show when={panel.link().hasAppToken}>
                          <p data-slot="bots-hint" data-state="saved">
                            {t("gateway.panel.appTokenSaved")}
                          </p>
                        </Show>
                        <form
                          data-slot="gateway-row"
                          data-secrets
                          autocomplete="off"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void panel.saveAppToken()
                          }}
                        >
                          <input
                            data-slot="bots-input"
                            type="password"
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={
                              panel.link().hasAppToken
                                ? t("gateway.panel.tokenReplace")
                                : t("gateway.panel.appTokenPlaceholder")
                            }
                            aria-label={t("gateway.panel.appToken")}
                            value={panel.appDraft()}
                            onInput={(event) => panel.setAppDraft(event.currentTarget.value)}
                          />
                          <button
                            type="submit"
                            data-slot="bots-btn"
                            disabled={panel.busy() || panel.appDraft().trim() === ""}
                          >
                            {t("gateway.panel.save")}
                          </button>
                        </form>
                      </Show>
                      <Failure of="paste" />
                      <Show when={panel.link().hasToken}>
                        <div data-slot="gateway-row">
                          <ConfirmAction
                            label={t("gateway.panel.clearToken")}
                            question={t("gateway.panel.clearTokenQuestion")}
                            confirm={t("gateway.panel.clearTokenConfirm")}
                            disabled={panel.busy()}
                            onConfirm={() => panel.clearToken()}
                          />
                        </div>
                      </Show>
                    </Show>

                    <Show when={id === "test"}>
                      <p data-slot="bots-hint">{t("gateway.step.testText")}</p>
                      <Show when={panel.probed()}>
                        {(name) => (
                          <p data-slot="bots-hint" data-state="saved">
                            {t("gateway.panel.probed", name())}
                          </p>
                        )}
                      </Show>
                      <div data-slot="gateway-row">
                        <button
                          type="button"
                          data-slot="bots-btn"
                          disabled={panel.busy() || !panel.link().hasToken}
                          onClick={() => void panel.probe()}
                        >
                          {t("gateway.panel.probe")}
                        </button>
                      </div>
                      <Show when={!panel.link().hasToken}>
                        <p data-slot="bots-hint">{t("gateway.panel.needToken")}</p>
                      </Show>
                      <Failure of="test" />
                    </Show>

                    <Show when={id === "on"}>
                      {/* On and off, with the project the turns run in. */}
                      <p data-slot="bots-hint">
                        <Show when={panel.where()} fallback={t("gateway.panel.noProject")}>
                          {(project) => t("gateway.panel.project", project())}
                        </Show>
                      </p>
                      <Show when={panel.previous()}>
                        {(before) => (
                          <p data-slot="bots-hint" data-state="warn">
                            {t("gateway.panel.previousProject", before())}
                          </p>
                        )}
                      </Show>
                      <Show when={!panel.link().enabled && !panel.link().hasToken}>
                        <p data-slot="bots-hint">{t("gateway.panel.needToken")}</p>
                      </Show>
                      <Show when={!panel.link().enabled && panel.link().hasToken && !panel.tokensReady()}>
                        <p data-slot="bots-hint">{t("gateway.panel.needAppToken")}</p>
                      </Show>
                      <div data-slot="gateway-row">
                        <Show
                          when={panel.link().enabled}
                          fallback={
                            <button
                              type="button"
                              data-slot="bots-btn"
                              data-tone="primary"
                              disabled={panel.busy() || !panel.tokensReady() || !panel.where()}
                              onClick={() => void panel.setEnabled(true)}
                            >
                              {t("gateway.panel.switchOn")}
                            </button>
                          }
                        >
                          <button
                            type="button"
                            data-slot="bots-btn"
                            disabled={panel.busy()}
                            onClick={() => void panel.setEnabled(false)}
                          >
                            {t("gateway.panel.switchOff")}
                          </button>
                        </Show>
                      </div>
                      <Failure of="on" />
                    </Show>

                    <Show when={id === "pair"}>
                      {/* Who may write, and who asks to. */}
                      <span data-slot="gateway-subtitle">{t("gateway.panel.authorized")}</span>
                      <Show
                        when={panel.pairing().authorized.length > 0}
                        fallback={
                          <p data-slot="bots-hint">
                            {said(
                              t("gateway.panel.nobody"),
                              t("gateway.panel.nobodyDiscord"),
                              t("gateway.panel.nobodySlack"),
                            )}
                          </p>
                        }
                      >
                        <ul data-slot="gateway-list">
                          <For each={panel.pairing().authorized}>
                            {(account) => (
                              <li>
                                <span>{account.name}</span>
                                <span data-slot="gateway-meta">{account.id}</span>
                                <ConfirmAction
                                  label={t("gateway.panel.revoke")}
                                  question={t("gateway.panel.revokeQuestion", account.name)}
                                  confirm={t("gateway.panel.revokeConfirm")}
                                  disabled={panel.busy()}
                                  onConfirm={() => panel.revoke(account.id)}
                                />
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>

                      <span data-slot="gateway-subtitle">{t("gateway.panel.pairing")}</span>
                      <p data-slot="bots-hint" data-state="warn">
                        {t("gateway.panel.onlyYours")}
                      </p>
                      <Show when={onDiscord() || onSlack()}>
                        <p data-slot="bots-hint" data-state="warn">
                          {t(
                            "gateway.channelIsPublic",
                            onSlack() ? t("gateway.panel.platformSlack") : t("gateway.panel.platformDiscord"),
                          )}
                        </p>
                      </Show>
                      {/* The place of the link or QR that comes later (scelta 3): nothing is drawn here until it exists. */}
                      <div data-slot="gateway-pair-link" />
                      <Show when={panel.pairing().pending.length > 0}>
                        <ul data-slot="gateway-list">
                          <For each={panel.pairing().pending}>
                            {(request) => (
                              <li>
                                <span>{request.sender.name}</span>
                                <span data-slot="gateway-meta">
                                  {request.sender.id} · {t("gateway.panel.expires", time(request.expiresMs))}
                                </span>
                                <ConfirmAction
                                  label={t("gateway.panel.reject")}
                                  question={t("gateway.panel.rejectQuestion", request.sender.name)}
                                  confirm={t("gateway.panel.rejectConfirm")}
                                  disabled={panel.busy()}
                                  onConfirm={() => panel.reject(request.request)}
                                />
                              </li>
                            )}
                          </For>
                        </ul>
                        {/* A secret zone too: the code is short-lived, but a recording has no business keeping it. */}
                        <form
                          data-slot="gateway-row"
                          data-secrets
                          autocomplete="off"
                          onSubmit={(event) => {
                            event.preventDefault()
                            approve()
                          }}
                        >
                          <input
                            data-slot="bots-input"
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={t("gateway.panel.code")}
                            aria-label={t("gateway.panel.code")}
                            value={code()}
                            onInput={(event) => setCode(event.currentTarget.value)}
                          />
                          <button
                            type="submit"
                            data-slot="bots-btn"
                            disabled={panel.busy() || code().trim() === ""}
                          >
                            {t("gateway.panel.approve")}
                          </button>
                        </form>
                      </Show>
                      <Show when={panel.pairing().lockedUntilMs}>
                        {(until) => <p data-slot="bots-problem">{t("gateway.panel.locked", time(until()))}</p>}
                      </Show>
                      <Show
                        when={panel.pairing().open}
                        fallback={
                          <div data-slot="gateway-row">
                            <button
                              type="button"
                              data-slot="bots-link"
                              disabled={panel.busy()}
                              onClick={() => void panel.openPairing()}
                            >
                              {t("gateway.panel.openPairing")}
                            </button>
                          </div>
                        }
                      >
                        <p data-slot="bots-hint">
                          <Show when={panel.live()} fallback={t("gateway.panel.pairingAfterOn")}>
                            <Show when={panel.pairing().openUntilMs} fallback={t("gateway.panel.pairingOpen")}>
                              {(until) => t("gateway.panel.pairingOpenUntil", time(until()))}
                            </Show>
                          </Show>
                        </p>
                      </Show>
                      <Failure of="pair" />
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ol>

        {/* The shell from a chat: off, and for ragu only. */}
        <div data-slot="gateway-block">
          <span data-slot="gateway-subtitle">{t("gateway.panel.remote")}</span>
          <Show
            when={panel.offersRemote()}
            fallback={<p data-slot="bots-hint">{t(remoteNeverKey(props.bot), runnerById(props.bot.runner).label)}</p>}
          >
            <p data-slot="bots-hint">
              {panel.remote().commands
                ? said(t("gateway.panel.remoteOn"), t("gateway.panel.remoteOnDiscord"), t("gateway.panel.remoteOnSlack"))
                : t("gateway.panel.remoteOff")}
            </p>
            <Show
              when={panel.confirmingRemote()}
              fallback={
                <Show
                  when={panel.remote().commands}
                  fallback={
                    <button type="button" data-slot="bots-btn" disabled={panel.busy()} onClick={() => panel.askRemote()}>
                      {t("gateway.panel.remoteAsk")}
                    </button>
                  }
                >
                  <button
                    type="button"
                    data-slot="bots-btn"
                    disabled={panel.busy()}
                    onClick={() => void panel.remoteOff()}
                  >
                    {t("gateway.panel.remoteSwitchOff")}
                  </button>
                </Show>
              }
            >
              <div data-slot="gateway-confirm">
                <p data-slot="bots-hint" data-state="warn">
                  {said(
                    t("gateway.panel.remoteWhat"),
                    t("gateway.panel.remoteWhatDiscord"),
                    t("gateway.panel.remoteWhatSlack"),
                  )}
                </p>
                <div data-slot="gateway-row">
                  <button type="button" data-slot="bots-btn" onClick={() => panel.cancelRemote()}>
                    {t("gateway.panel.cancel")}
                  </button>
                  <button
                    type="button"
                    data-slot="bots-btn"
                    data-tone="danger"
                    disabled={panel.busy()}
                    onClick={() => void panel.confirmRemote()}
                  >
                    {t("gateway.panel.remoteConfirm")}
                  </button>
                </div>
              </div>
            </Show>
            <p data-slot="bots-hint">{t("gateway.panel.mcp")}</p>
          </Show>
          <Failure of="remote" />
        </div>

        {/* A failure that belongs to no button (the status could not be read). */}
        <Failure of={undefined} />
      </Show>
    </section>
  )
}
