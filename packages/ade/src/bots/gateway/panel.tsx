/**
 * The Gateway section of a bot's card (G6): the bot's Telegram, Discord or
 * Slack, on and off.
 *
 * What it does lives in `panel-state.ts`; this is how it looks. The token
 * field is a password field, emptied the moment it is saved, and nothing
 * shows a token again: only whether one is saved.
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import type { AgentFile } from "../nikcli"
import { runnerById } from "../runners"
import { createGatewayPanel, type GatewayPanelDeps } from "./panel-state"

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export function GatewaySection(props: { bot: AgentFile; deps: Omit<GatewayPanelDeps, "bot"> }) {
  const panel = createGatewayPanel({ ...props.deps, bot: () => props.bot })
  const [code, setCode] = createSignal("")
  onMount(() => void panel.refresh())
  onCleanup(() => panel.dispose())

  const onDiscord = () => panel.platform() === "discord"
  const onSlack = () => panel.platform() === "slack"
  /** The platform's own text for `key`, the Telegram one when it has none. */
  const said = (telegram: string, discord: string, slack: string) =>
    onSlack() ? slack : onDiscord() ? discord : telegram
  const platforms = [
    { id: "telegram", label: () => t("gateway.panel.platformTelegram") },
    { id: "discord", label: () => t("gateway.panel.platformDiscord") },
    { id: "slack", label: () => t("gateway.panel.platformSlack") },
  ]

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

  return (
    <section data-slot="bots-card-section" data-component="bot-gateway">
      <span data-slot="bots-label">
        {said(t("gateway.panel.title"), t("gateway.panel.titleDiscord"), t("gateway.panel.titleSlack"))}
      </span>

      {/* Which platform: every link is kept, so this only chooses what is shown. */}
      <div data-slot="gateway-row" role="group" aria-label={t("gateway.panel.platform")}>
        <For each={platforms}>
          {(item) => (
            <button
              type="button"
              data-slot="bots-btn"
              data-tone={panel.platform() === item.id ? "primary" : undefined}
              aria-pressed={panel.platform() === item.id}
              onClick={() => panel.choose(item.id)}
            >
              {item.label()}
            </button>
          )}
        </For>
      </div>

      <p data-slot="bots-hint">
        {said(t("gateway.panel.intro"), t("gateway.panel.introDiscord"), t("gateway.panel.introSlack"))}
      </p>

      <div data-slot="gateway-state" data-tone={state().tone}>
        <span data-slot="gateway-dot" aria-hidden="true" />
        <span>{state().text}</span>
        <Show when={panel.link().lastMessageMs}>
          {(at) => <span data-slot="gateway-meta">{t("gateway.panel.lastMessage", time(at()))}</span>}
        </Show>
      </div>
      <Show when={panel.link().enabled && panel.link().lastError}>
        {(error) => <p data-slot="bots-problem">{error()}</p>}
      </Show>
      <Show when={panel.redactedAt()}>
        {(at) => (
          <p data-slot="bots-hint" data-state="warn">
            {t("gateway.panel.redacted", time(at()))}
          </p>
        )}
      </Show>

      {/* The token: typed once, never shown again. */}
      <div data-slot="gateway-block">
        <span data-slot="gateway-subtitle">{t("gateway.panel.token")}</span>
        <Show
          when={panel.link().hasToken}
          fallback={
            <p data-slot="bots-hint">
              {said(
                t("gateway.panel.tokenHelp"),
                t("gateway.panel.tokenHelpDiscord"),
                t("gateway.panel.tokenHelpSlack"),
              )}
            </p>
          }
        >
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
          <button type="submit" data-slot="bots-btn" disabled={panel.busy() || panel.draft().trim() === ""}>
            {t("gateway.panel.save")}
          </button>
        </form>
        <Show when={panel.link().hasToken}>
          <div data-slot="gateway-row">
            <button type="button" data-slot="bots-btn" disabled={panel.busy()} onClick={() => void panel.probe()}>
              {t("gateway.panel.probe")}
            </button>
            <button
              type="button"
              data-slot="bots-link"
              data-tone="danger"
              disabled={panel.busy()}
              onClick={() => void panel.clearToken()}
            >
              {t("gateway.panel.clearToken")}
            </button>
          </div>
        </Show>
      </div>

      {/* Slack's second token: the one that opens the socket, made by hand in the app. */}
      <Show when={panel.needsAppToken()}>
        <div data-slot="gateway-block">
          <span data-slot="gateway-subtitle">{t("gateway.panel.appToken")}</span>
          <Show
            when={panel.link().hasAppToken}
            fallback={<p data-slot="bots-hint">{t("gateway.panel.appTokenHelp")}</p>}
          >
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
                panel.link().hasAppToken ? t("gateway.panel.tokenReplace") : t("gateway.panel.appTokenPlaceholder")
              }
              aria-label={t("gateway.panel.appToken")}
              value={panel.appDraft()}
              onInput={(event) => panel.setAppDraft(event.currentTarget.value)}
            />
            <button type="submit" data-slot="bots-btn" disabled={panel.busy() || panel.appDraft().trim() === ""}>
              {t("gateway.panel.save")}
            </button>
          </form>
        </div>

        <div data-slot="gateway-block">
          <span data-slot="gateway-subtitle">{t("gateway.panel.slackSetup")}</span>
          <p data-slot="bots-hint">{t("gateway.panel.slackManifestHow")}</p>
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
          <p data-slot="bots-hint" data-state="warn">
            {t("gateway.panel.slackReinstall")}
          </p>
          <p data-slot="bots-hint">{t("gateway.panel.slackInvite")}</p>
          <p data-slot="bots-hint" data-state="warn">
            {t("gateway.noProxySlack")}
          </p>
        </div>
      </Show>

      <Show when={onDiscord()}>
        <div data-slot="gateway-block">
          <span data-slot="gateway-subtitle">{t("gateway.panel.portal")}</span>
          <p data-slot="bots-hint">{t("gateway.panel.portalWhere")}</p>
          <p data-slot="bots-hint" data-state="warn">
            {t("gateway.panel.intentsOff")}
          </p>
          <p data-slot="bots-hint">{t("gateway.panel.invite")}</p>
          <p data-slot="bots-hint" data-state="warn">
            {t("gateway.noProxy")}
          </p>
        </div>
      </Show>

      {/* On and off, with the project the turns run in. */}
      <div data-slot="gateway-block">
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
      </div>

      {/* Who may write, and who asks to. */}
      <div data-slot="gateway-block">
        <span data-slot="gateway-subtitle">{t("gateway.panel.authorized")}</span>
        <Show
          when={panel.pairing().authorized.length > 0}
          fallback={
            <p data-slot="bots-hint">
              {said(t("gateway.panel.nobody"), t("gateway.panel.nobodyDiscord"), t("gateway.panel.nobodySlack"))}
            </p>
          }
        >
          <ul data-slot="gateway-list">
            <For each={panel.pairing().authorized}>
              {(account) => (
                <li>
                  <span>{account.name}</span>
                  <span data-slot="gateway-meta">{account.id}</span>
                  <button
                    type="button"
                    data-slot="bots-link"
                    data-tone="danger"
                    disabled={panel.busy()}
                    onClick={() => void panel.revoke(account.id)}
                  >
                    {t("gateway.panel.revoke")}
                  </button>
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
        <Show when={panel.pairing().pending.length > 0}>
          <ul data-slot="gateway-list">
            <For each={panel.pairing().pending}>
              {(request) => (
                <li>
                  <span>{request.sender.name}</span>
                  <span data-slot="gateway-meta">
                    {request.sender.id} · {t("gateway.panel.expires", time(request.expiresMs))}
                  </span>
                  <button
                    type="button"
                    data-slot="bots-link"
                    data-tone="danger"
                    disabled={panel.busy()}
                    onClick={() => void panel.reject(request.request)}
                  >
                    {t("gateway.panel.reject")}
                  </button>
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
            <button type="submit" data-slot="bots-btn" disabled={panel.busy() || code().trim() === ""}>
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
            <button
              type="button"
              data-slot="bots-link"
              disabled={panel.busy()}
              onClick={() => void panel.openPairing()}
            >
              {t("gateway.panel.openPairing")}
            </button>
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
      </div>

      {/* The shell from a chat: off, and for nikcli only. */}
      <div data-slot="gateway-block">
        <span data-slot="gateway-subtitle">{t("gateway.panel.remote")}</span>
        <Show
          when={panel.offersRemote()}
          fallback={<p data-slot="bots-hint">{t("gateway.panel.remoteNever", runnerById(props.bot.runner).label)}</p>}
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
      </div>

      <Show when={panel.problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
    </section>
  )
}
