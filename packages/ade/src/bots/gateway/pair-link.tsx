import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { remainingClock, remainingMs } from "../approvals"
import type { PairingLinkInfo } from "./panel-state"

/** The address without what comes after the `?`: `https://t.me/mio_bot?start=…` as `t.me/mio_bot`. Never the token. */
export function addressOf(url: string): string {
  const bare = url.split("?")[0] ?? url
  return bare.replace(/^https?:\/\//, "")
}

/** The QR as an image the page can draw without a script: a data address of the SVG. */
export const qrSource = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`

/**
 * Pairing with a link or a QR (scelta 3), the step 5 of Telegram: the QR to scan with the phone, the link to open on
 * the computer, the time left, «Un altro QR» when it runs out, and under it the way that always works, the code.
 *
 * The token is in the QR and in the link, and nowhere else: the text shows the bot's address only, the picture sits in a
 * zone marked `data-secrets` (a recording has no business keeping it), and nothing here logs.
 */
export function PairLink(props: {
  link: () => PairingLinkInfo | undefined
  /** The name of the account the link just paired, once it did. */
  paired: () => string | undefined
  /** Only a gateway that is reading hears `/start`: the button waits for it. */
  live: () => boolean
  busy: () => boolean
  onMake: () => void
  /** Opens the link in the system browser; absent, the address shows as text. */
  onOpen?: ((url: string) => void) | undefined
  /** Absent, the clock; a test passes its own. */
  now?: () => number
  /** The QR is leaving the screen (the step closed, the card gone): its token is to be cancelled. */
  onGone?: (() => void) | undefined
}) {
  onCleanup(() => props.onGone?.())
  const [tick, setTick] = createSignal(Date.now())
  const now = () => props.now?.() ?? tick()

  // The seconds left count down while a link is shown, and only then.
  createEffect(() => {
    if (props.now || !props.link()) return
    setTick(Date.now())
    const timer = setInterval(() => setTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const expired = (link: PairingLinkInfo) => remainingMs({ expiresAt: link.expiresMs }, now()) === 0

  return (
    <>
      <Show when={props.paired()}>{(name) => <p data-slot="bots-hint" data-state="saved">{t("gateway.panel.linkDone", name())}</p>}</Show>
      <Show
        when={props.link()}
        fallback={
          <div data-slot="gateway-row">
            <button
              type="button"
              data-slot="bots-btn"
              data-tone="primary"
              disabled={props.busy() || !props.live()}
              onClick={() => props.onMake()}
            >
              {t("gateway.panel.linkMake")}
            </button>
            <Show when={!props.live()}>
              <span data-slot="bots-hint">{t("gateway.panel.linkNeedsOn")}</span>
            </Show>
          </div>
        }
      >
        {(link) => (
          <div data-slot="gateway-link-box">
            <Show
              when={!expired(link())}
              fallback={<p data-slot="bots-hint">{t("gateway.panel.linkExpired")}</p>}
            >
              <div data-slot="gateway-qr" data-secrets>
                <img src={qrSource(link().svg)} alt={t("gateway.panel.linkQrAlt")} width="224" height="224" draggable={false} />
              </div>
              <div data-slot="gateway-row">
                <Show
                  when={props.onOpen}
                  fallback={
                    <span data-slot="bots-hint">
                      <code>{addressOf(link().url)}</code>
                    </span>
                  }
                >
                  {(open) => (
                    <button type="button" data-slot="bots-link" onClick={() => open()(link().url)}>
                      {t("gateway.panel.linkOpen", addressOf(link().url))}
                    </button>
                  )}
                </Show>
                <span data-slot="gateway-meta">
                  {t("gateway.panel.linkLeft", remainingClock({ expiresAt: link().expiresMs }, now()))}
                </span>
              </div>
              <p data-slot="bots-hint">{t("gateway.panel.linkHow")}</p>
            </Show>
            <div data-slot="gateway-row">
              <button type="button" data-slot="bots-btn" disabled={props.busy() || !props.live()} onClick={() => props.onMake()}>
                {t("gateway.panel.linkAnother")}
              </button>
            </div>
          </div>
        )}
      </Show>
      <p data-slot="bots-hint">{t("gateway.panel.linkFallback")}</p>
    </>
  )
}
