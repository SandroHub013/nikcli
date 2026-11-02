import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import "./tray.css"
import { t } from "../i18n"
import { Button } from "../ui/controls"
import { Sheet } from "../ui/sheet"

/**
 * The screenshots you just took, waiting to be handed to an agent.
 *
 * Bottom left, over the grid rather than beside it: a strip that pushed the
 * terminals aside would cost every session a slice of width for something that
 * is empty most of the time. It sits in the corner the sidebar already occupies,
 * where nothing is ever drawn, and folds away to a single word when unwanted.
 *
 * A thumbnail is dragged onto the session that should see it. Dropping writes
 * the path into that terminal and stops — no newline — because which agent gets
 * the picture and what to ask about it are two different decisions, and only the
 * first one is made by the drag.
 */

export interface Shot {
  path: string
  name: string
  modified_ms: number
}

export interface ShotTrayProps {
  shots: Shot[]
  /** Loads the image bytes for a thumbnail. Absent in the browser harness. */
  load?: (path: string) => Promise<Uint8Array | null>
  /** Takes a shot out of the tray without touching the file. */
  onDismiss: (path: string) => void
  /** Moves the file to the Recycle Bin; `false` when it could not be. */
  onDelete?: (path: string) => Promise<boolean>
  /**
   * Types the path into the session that has the focus, the way a drop would (UX-17: a screenshot reached an agent
   * only by dragging). `false` when there is no session to give it to.
   */
  onSend?: (path: string) => boolean
  /**
   * True when this machine has no screenshots folder, so none will ever
   * arrive. The strip then says so in one line instead of staying blank.
   */
  unavailable?: boolean
  /** The folder the host is watching. Shown so a wrong folder is visible. */
  folder?: string
  /** A folder on a share: named, but not read without sending credentials. */
  network?: boolean
  /** Opens the folder picker. Absent in the browser harness. */
  onChoose?: () => void
  /** The picker is open: the button waits, so a second click cannot open a second one. */
  choosing?: boolean
  /** Why the folder just picked was refused, as the host's code. */
  notice?: string
}

/**
 * Which folder the tray is on, the way to change it and why a choice was
 * refused: one markup for the tray with thumbnails and the empty one, so the
 * path and the button look the same in both.
 *
 * A tray that watched the wrong folder looked exactly like a tray with nothing
 * new in it, and finding out meant reading the source. The choice is here too,
 * so moving it never needs a trip to settings.
 */
function Where(props: Pick<ShotTrayProps, "folder" | "network" | "onChoose" | "choosing" | "notice">) {
  return (
    <>
      <Show when={props.folder || props.onChoose}>
        <div data-slot="shot-tray-where">
          <Show when={props.folder}>
            {(folder) => (
              <span data-slot="shot-tray-folder" title={folder()}>
                {/* Left to right inside the right-to-left box that truncates the front of the path. */}
                <bdi dir="ltr">{folder()}</bdi>
              </span>
            )}
          </Show>
          <Show when={props.network}>
            <span data-slot="shot-tray-network">{t("shots.network")}</span>
          </Show>
          <Show when={props.onChoose}>
            <button
              type="button"
              data-slot="shot-tray-choose"
              disabled={props.choosing}
              onClick={() => props.onChoose?.()}
            >
              {t("shots.choose")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={noticeText(props.notice)}>
        {(text) => (
          <span data-slot="shot-tray-notice" role="alert">
            {text()}
          </span>
        )}
      </Show>
    </>
  )
}

const NOTICE_TEXT = {
  "not-a-folder": "shots.error.notAFolder",
  "too-broad": "shots.error.tooBroad",
  system: "shots.error.system",
  "not-saved": "shots.error.notSaved",
} as const

function noticeText(code: string | undefined): string | undefined {
  if (!code) return undefined
  return t(NOTICE_TEXT[code as keyof typeof NOTICE_TEXT] ?? "shots.error.notSaved")
}

/** A thumbnail, loaded once and revoked when it leaves the tray. */
function Thumb(props: { shot: Shot; load?: ShotTrayProps["load"] }) {
  const [url, setUrl] = createSignal<string>()

  onMount(() => {
    let revoked = false
    /*
     * The URL is held in a variable and revoked by a cleanup registered
     * *synchronously*, not by one registered after the await.
     *
     * Solid's owner is only current during the synchronous part of a
     * reactive scope; after an await it is null, and `onCleanup` in that
     * state is a silent no-op — it neither runs nor warns. So the
     * `revokeObjectURL` below the await was never called, and every
     * thumbnail leaked its blob: several megabytes each for a 4K screenshot,
     * held for the lifetime of the window.
     */
    let objectUrl: string | undefined

    void (async () => {
      const bytes = await props.load?.(props.shot.path).catch(() => null)
      if (!bytes || revoked) return
      /*
       * A blob URL rather than a base64 data URL. A screenshot of a 4K display
       * is several megabytes, and base64 makes it a third larger again — as a
       * string, held in the DOM, for every thumbnail on screen.
       */
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }))
      setUrl(objectUrl)
    })()

    onCleanup(() => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    })
  })

  return (
    <Show when={url()} fallback={<span data-slot="shot-loading" aria-hidden="true" />}>
      {(src) => <img data-slot="shot-image" src={src()} alt={props.shot.name} draggable={false} />}
    </Show>
  )
}

export function ShotTray(props: ShotTrayProps) {
  const [collapsed, setCollapsed] = createSignal(false)
  const [opened, setOpened] = createSignal<Shot>()
  // The viewer's delete: asked first («Elimina» only opens the question), and said when it failed.
  const [asking, setAsking] = createSignal(false)
  const [deleteFailed, setDeleteFailed] = createSignal(false)
  // Handing the picture to the focused session found none to give it to.
  const [sendFailed, setSendFailed] = createSignal(false)
  // The delete is running: the buttons wait, so a second click cannot ask the host twice.
  const [deleting, setDeleting] = createSignal(false)
  const resetViewer = () => {
    setAsking(false)
    setDeleteFailed(false)
    setSendFailed(false)
    setDeleting(false)
  }
  const closeViewer = () => {
    setOpened(undefined)
    resetViewer()
  }
  // A viewer opens clean: the last one's question or alert is not about this picture.
  const openViewer = (shot: Shot) => {
    resetViewer()
    setOpened(shot)
  }
  const [strip, setStrip] = createSignal<HTMLDivElement>()
  /** Whether there are screenshots past each end of what you can see. */
  const [edges, setEdges] = createSignal({ left: false, right: false })

  const readEdges = () => {
    const el = strip()
    if (!el) return setEdges({ left: false, right: false })
    const slack = el.scrollWidth - el.clientWidth
    // A pixel of tolerance: fractional widths leave a rounding remainder that
    // would keep the arrow lit on a row already scrolled to its end.
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < slack - 1 })
  }

  onMount(() => {
    const el = strip()
    if (!el) return
    // The row's own width changes with the sidebar, and its contents change
    // with every screenshot: both decide whether there is more to reach.
    const observer = new ResizeObserver(readEdges)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    props.shots.length
    queueMicrotask(readEdges)
  })

  return (
    <Show
      when={props.shots.length > 0}
      fallback={
        <Show when={props.unavailable || props.folder}>
          <aside data-component="shot-tray" data-empty="true">
            {/* A share was not read, so "nothing in this folder" would be a claim about what was not looked at. */}
            <Show when={!props.network}>
              <span data-slot="shot-tray-empty">
                {props.unavailable ? t("shots.noFolder") : t("shots.emptyFolder")}
              </span>
            </Show>
            <Where
              folder={props.folder}
              network={props.network}
              onChoose={props.onChoose}
              choosing={props.choosing}
              notice={props.notice}
            />
          </aside>
        </Show>
      }
    >
      <aside
        data-component="shot-tray"
        data-collapsed={collapsed() ? "true" : undefined}
        aria-label={t("shots.tray.aria", props.shots.length)}
      >
        {/*
         * No heading, and nothing to collapse.
         *
         * The tray lives in a strip at the bottom of the sidebar that is
         * reserved for it, so a title was a name for something you recognise
         * by looking at it, and a collapse control was a way to empty a space
         * nothing else can use. The count is in the accessible name, where it
         * is still available to anyone who cannot see the thumbnails.
         */}
        <Show when={!collapsed()}>
          <div
            data-slot="shot-tray-row"
            data-more={`${edges().left ? "l" : ""}${edges().right ? "r" : ""}` || undefined}
          >
            <div
              data-slot="shot-tray-strip"
              ref={setStrip}
              onScroll={readEdges}
              /*
               * The wheel, turned sideways by hand.
               *
               * Chromium only sends a vertical wheel to a row that scrolls
               * sideways when no ancestor can take it, and here the sidebar can:
               * the column scrolled and the tray never moved, so the screenshots
               * past the second one were unreachable with a mouse. Measured in
               * ADE Test: three notches of deltaY 120 left scrollLeft at 0.
               */
              onWheel={(event) => {
                const el = strip()
                if (!el || el.scrollWidth <= el.clientWidth) return
                // A trackpad swipe already arrives as deltaX and the browser
                // handles it; adding it here would move the row twice.
                if (!event.deltaY) return
                const before = el.scrollLeft
                el.scrollLeft = before + event.deltaY
                if (el.scrollLeft !== before) event.preventDefault()
              }}
            >
              <For each={props.shots}>
                {(shot) => (
                  /*
                   * The tile is the drag handle; the picture inside it is the open button.
                   *
                   * It used to wrap a <button> around the thumbnail, and in
                   * Chromium a button swallows the press that would have started
                   * the drag: `draggable` on the ancestor is simply never
                   * honoured, so the thumbnails looked draggable and were not.
                   * So the picture carries the button role instead of being a
                   * <button>. What it no longer does is hold the dismiss: that
                   * was a real button nested inside a `role="button"`, which
                   * assistive technology cannot read (UX-17). The two are
                   * siblings now, and the tile is a plain container.
                   */
                  <figure
                    data-slot="shot"
                    title={[shot.name, t("shots.thumb.tip")].join("\n")}
                    draggable={true}
                    onDragStart={(event) => {
                      /*
                       * The path travels as plain text so any drop target that
                       * accepts text — a pane, the composer, a field ADE does not
                       * own yet — receives something it can use, rather than a
                       * private format only this tray understands.
                       */
                      event.dataTransfer?.setData("text/plain", shot.path)
                      event.dataTransfer?.setData("application/x-ade-shot", shot.path)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
                    }}
                  >
                    <div
                      data-slot="shot-open"
                      role="button"
                      tabindex={0}
                      aria-label={t("shots.open.named", shot.name)}
                      onClick={() => openViewer(shot)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        openViewer(shot)
                      }}
                    >
                      <Thumb shot={shot} load={props.load} />
                    </div>
                    <button
                      type="button"
                      data-slot="shot-dismiss"
                      onClick={() => props.onDismiss(shot.path)}
                      aria-label={t("shots.dismiss.named", shot.name)}
                      title={t("shots.dismiss")}
                    >
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                        <path
                          d="M3 3l6 6M9 3l-6 6"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </figure>
                )}
              </For>
            </div>
            {/*
             * Two ways of saying the row continues, because the scrollbar is
             * hidden: the edge fades out under the thumbnail that is half
             * there, and an arrow sits on the fade for anyone who would rather
             * press than scroll. Both appear only on the side that has more.
             */}
            <For each={["left", "right"] as const}>
              {(side) => (
                <Show when={side === "left" ? edges().left : edges().right}>
                  <button
                    type="button"
                    data-slot="shot-tray-more"
                    data-side={side}
                    aria-label={side === "left" ? t("shots.more.left") : t("shots.more.right")}
                    title={side === "left" ? t("shots.more.left") : t("shots.more.right")}
                    onClick={() => {
                      const el = strip()
                      if (!el) return
                      el.scrollBy({ left: (side === "left" ? -1 : 1) * el.clientWidth * 0.8, behavior: "smooth" })
                    }}
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                      <path
                        d={side === "left" ? "M7.5 2.5L4 6l3.5 3.5" : "M4.5 2.5L8 6l-3.5 3.5"}
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Where
          folder={props.folder}
          network={props.network}
          onChoose={props.onChoose}
          choosing={props.choosing}
          notice={props.notice}
        />
      </aside>

      {/* Opened at full size, over everything: the picture is being looked at for a second, not worked in. It is a
          Sheet, so Esc and a press outside close it, the focus moves into it and comes back to the tile, and the
          page behind is out of reach of Tab (UX-17). */}
      <Show when={opened()}>
        {(shot) => (
          <Sheet component="shot-viewer" surface={false} label={shot().name} onClose={closeViewer}>
            <figure data-slot="shot-viewer-frame">
              <Thumb shot={shot()} load={props.load} />
              <figcaption data-slot="shot-viewer-caption">
                <span data-slot="shot-viewer-name">{shot().name}</span>
                <span data-slot="shot-viewer-hint">{t("shots.hint")}</span>
                {/* The keyboard's way to give the picture to an agent: the same text a drop types, into the session
                    that has the focus. */}
                <Show when={props.onSend && !asking()}>
                  <Button
                    size="sm"
                    data-slot="shot-viewer-send"
                    onClick={() => {
                      const sent = props.onSend?.(shot().path) ?? false
                      setSendFailed(!sent)
                      if (sent) closeViewer()
                    }}
                  >
                    {t("shots.send")}
                  </Button>
                </Show>
                {/* Deleting is offered here and not on the thumbnail: the × in
                    the tray puts a screenshot away, and a click that sends the
                    file to the Recycle Bin must not sit a few pixels from one
                    that does not. It asks first, and says when it did not work. */}
                <Show when={props.onDelete && !asking()}>
                  <Button
                    size="sm"
                    variant="danger"
                    data-slot="shot-viewer-close"
                    onClick={() => {
                      setDeleteFailed(false)
                      setAsking(true)
                    }}
                  >
                    {t("shots.delete")}
                  </Button>
                </Show>
                <Show when={asking()}>
                  <span data-slot="shot-viewer-ask">{t("shots.delete.ask", shot().name)}</span>
                  {/* «Tieni» takes the place «Elimina» had, under the cursor: a double click keeps the file. */}
                  <Button
                    size="sm"
                    data-slot="shot-viewer-close"
                    disabled={deleting()}
                    ref={(button) => queueMicrotask(() => button.focus())}
                    onClick={() => setAsking(false)}
                  >
                    {t("shots.delete.keep")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    data-slot="shot-viewer-close"
                    disabled={deleting()}
                    onClick={async (event) => {
                      // The second click of a double click on «Elimina» lands here: it is not a yes.
                      if (event.detail > 1) return
                      const path = shot().path
                      setDeleting(true)
                      const done = (await props.onDelete?.(path)) ?? false
                      // The viewer may have been closed or moved on meanwhile: its state is not this one's.
                      if (opened()?.path !== path) return
                      setDeleting(false)
                      if (done) {
                        // The tile that opened the viewer is gone, and the viewer gives the focus back to it: a focus
                        // on a detached node is a focus on the page. Moving it to a tile first, while the viewer is
                        // still open, makes that tile the one the focus goes back to.
                        strip()?.querySelector<HTMLElement>('[data-slot="shot-open"]')?.focus({ preventScroll: true })
                        closeViewer()
                      } else {
                        setAsking(false)
                        setDeleteFailed(true)
                      }
                    }}
                  >
                    {t("shots.delete.confirm")}
                  </Button>
                </Show>
                <Show when={deleteFailed()}>
                  <span data-slot="shot-viewer-error" role="alert">
                    {t("shots.delete.failed")}
                  </span>
                </Show>
                <Show when={sendFailed()}>
                  <span data-slot="shot-viewer-error" role="alert">
                    {t("shots.send.failed")}
                  </span>
                </Show>
                <Show when={!asking()}>
                  <Button size="sm" data-slot="shot-viewer-close" onClick={closeViewer}>
                    {t("shots.close")}
                  </Button>
                </Show>
              </figcaption>
            </figure>
          </Sheet>
        )}
      </Show>
    </Show>
  )
}
