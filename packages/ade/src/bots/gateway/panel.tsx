/**
 * The Gateway section of a bot's card (G6): the bot's Telegram, on and off.
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

export function GatewaySection(props: {
  bot: AgentFile
  deps: Omit<GatewayPanelDeps, "bot">
}) {
  const panel = createGatewayPanel({ ...props.deps, bot: () => props.bot })
  const [code, setCode] = createSignal("")
  onMount(() => void panel.refresh())
  onCleanup(() => panel.dispose())

  const onDiscord = () => panel.platform() === "discord"

  const state = () => {
    const link = panel.link()
    if (!link.enabled) return { tone: "off", text: t("gateway.panel.off") }
    if (!link.running) return { tone: "error", text: t("gateway.panel.stopped") }
    return link.connected ? { tone: "on", text: t("gateway.panel.connected") } : { tone: "wait", text: t("gateway.panel.connecting") }
  }

  const approve = () => {
    const typed = code()
    setCode("")
    void panel.approve(typed)
  }

  return (
    <section data-slot="bots-card-section" data-component="bot-gateway">
      <span data-slot="bots-label">{onDiscord() ? t("gateway.panel.titleDiscord") : t("gateway.panel.title")}</span>

      {/* Which platform: both links are kept, so this only chooses what is shown. */}
      <div data-slot="gateway-row" role="group" aria-label={t("gateway.panel.platform")}>
        <button
          type="button"
          data-slot="bots-btn"
          data-tone={onDiscord() ? undefined : "primary"}
          aria-pressed={!onDiscord()}
          onClick={() => panel.choose("telegram")}
        >
          {t("gateway.panel.platformTelegram")}
        </button>
        <button
          type="button"
          data-slot="bots-btn"
          data-tone={onDiscord() ? "primary" : undefined}
          aria-pressed={onDiscord()}
          onClick={() => panel.choose("discord")}
        >
          {t("gateway.panel.platformDiscord")}
        </button>
      </div>

      <p data-slot="bots-hint">{onDiscord() ? t("gateway.panel.introDiscord") : t("gateway.panel.intro")}</p>

      <div data-slot="gateway-state" data-tone={state().tone}>
        <span data-slot="gateway-dot" aria-hidden="true" />
        <span>{state().text}</span>
        <Show when={panel.link().lastMessageMs}>{(at) => <span data-slot="gateway-meta">{t("gateway.panel.lastMessage", time(at()))}</span>}</Show>
      </div>
      <Show when={panel.link().enabled && panel.link().lastError}>{(error) => <p data-slot="bots-problem">{error()}</p>}</Show>
      <Show when={panel.redactedAt()}>
        {(at) => <p data-slot="bots-hint" data-state="warn">{t("gateway.panel.redacted", time(at()))}</p>}
      </Show>

      {/* The token: typed once, never shown again. */}
      <div data-slot="gateway-block">
        <span data-slot="gateway-subtitle">{t("gateway.panel.token")}</span>
        <Show
          when={panel.link().hasToken}
          fallback={
            <p data-slot="bots-hint">{onDiscord() ? t("gateway.panel.tokenHelpDiscord") : t("gateway.panel.tokenHelp")}</p>
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
                : onDiscord()
                  ? t("gateway.panel.tokenPlaceholderDiscord")
                  : t("gateway.panel.tokenPlaceholder")
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
            <button type="button" data-slot="bots-link" data-tone="danger" disabled={panel.busy()} onClick={() => void panel.clearToken()}>
              {t("gateway.panel.clearToken")}
            </button>
          </div>
        </Show>
      </div>

      <Show when={onDiscord()}>
        <div data-slot="gateway-block">
          <span data-slot="gateway-subtitle">{t("gateway.panel.portal")}</span>
          <p data-slot="bots-hint">{t("gateway.panel.portalWhere")}</p>
          <p data-slot="bots-hint" data-state="warn">{t("gateway.panel.intentsOff")}</p>
          <p data-slot="bots-hint">{t("gateway.panel.invite")}</p>
          <p data-slot="bots-hint" data-state="warn">{t("gateway.noProxy")}</p>
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
          {(before) => <p data-slot="bots-hint" data-state="warn">{t("gateway.panel.previousProject", before())}</p>}
        </Show>
        <Show when={!panel.link().enabled && !panel.link().hasToken}>
          <p data-slot="bots-hint">{t("gateway.panel.needToken")}</p>
        </Show>
        <div data-slot="gateway-row">
          <Show
            when={panel.link().enabled}
            fallback={
              <button
                type="button"
                data-slot="bots-btn"
                data-tone="primary"
                disabled={panel.busy() || !panel.link().hasToken || !panel.where()}
                onClick={() => void panel.setEnabled(true)}
              >
                {t("gateway.panel.switchOn")}
              </button>
            }
          >
            <button type="button" data-slot="bots-btn" disabled={panel.busy()} onClick={() => void panel.setEnabled(false)}>
              {t("gateway.panel.switchOff")}
            </button>
          </Show>
        </div>
      </div>

      {/* Who may write, and who asks to. */}
      <div data-slot="gateway-block">
        <span data-slot="gateway-subtitle">{t("gateway.panel.authorized")}</span>
        <Show when={panel.pairing().authorized.length > 0} fallback={<p data-slot="bots-hint">{t("gateway.panel.nobody")}</p>}>
          <ul data-slot="gateway-list">
            <For each={panel.pairing().authorized}>
              {(account) => (
                <li>
                  <span>{account.name}</span>
                  <span data-slot="gateway-meta">{account.id}</span>
                  <button type="button" data-slot="bots-link" data-tone="danger" disabled={panel.busy()} onClick={() => void panel.revoke(account.id)}>
                    {t("gateway.panel.revoke")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <span data-slot="gateway-subtitle">{t("gateway.panel.pairing")}</span>
        <p data-slot="bots-hint" data-state="warn">{t("gateway.panel.onlyYours")}</p>
        <Show when={onDiscord()}>
          <p data-slot="bots-hint" data-state="warn">{t("gateway.channelIsPublic", t("gateway.panel.platformDiscord"))}</p>
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
                  <button type="button" data-slot="bots-link" data-tone="danger" disabled={panel.busy()} onClick={() => void panel.reject(request.request)}>
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
            <button type="button" data-slot="bots-link" disabled={panel.busy()} onClick={() => void panel.openPairing()}>
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
        <Show when={panel.offersRemote()} fallback={<p data-slot="bots-hint">{t("gateway.panel.remoteNever", runnerById(props.bot.runner).label)}</p>}>
          <p data-slot="bots-hint">{panel.remote().commands ? t("gateway.panel.remoteOn") : t("gateway.panel.remoteOff")}</p>
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
                <button type="button" data-slot="bots-btn" disabled={panel.busy()} onClick={() => void panel.remoteOff()}>
                  {t("gateway.panel.remoteSwitchOff")}
                </button>
              </Show>
            }
          >
            <div data-slot="gateway-confirm">
              <p data-slot="bots-hint" data-state="warn">{t("gateway.panel.remoteWhat")}</p>
              <div data-slot="gateway-row">
                <button type="button" data-slot="bots-btn" onClick={() => panel.cancelRemote()}>
                  {t("gateway.panel.cancel")}
                </button>
                <button type="button" data-slot="bots-btn" data-tone="danger" disabled={panel.busy()} onClick={() => void panel.confirmRemote()}>
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
