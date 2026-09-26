/*
 * A sheet: ADE's dialog, on Kobalte's Dialog (kobalte-overlay, step 1 of the
 * shadcn/bklit proposal the user approved).
 *
 * The hand-made Overlay and Surface (`layout.tsx`) drew the scrim and the
 * panel and left the rest to each sheet: none trapped the focus, Tab walked
 * out into the terminals behind, the focus did not go back to whoever opened
 * the sheet, and the title was not tied to the dialog. Kobalte gives the trap,
 * Esc, a press outside and `aria-hidden` on everything else; this adds what
 * ADE needs on top:
 *
 * - it renders into the shell, not into `body`, so the theme's tokens reach it
 *   and its z-index sits over the terminals like the old overlay's;
 * - the focus goes to the panel itself when it opens (the sheets read their
 *   keys there), and back to what had it when the sheet goes, which Kobalte
 *   does only for a trigger of its own;
 * - `aria-modal`, and the title tied with `aria-labelledby` (`SheetTitle`).
 *
 * The same attributes as before, `data-layout="overlay"` and `"surface"`, so
 * `layout.css` and each sheet's own CSS apply unchanged. Plain TypeScript and
 * not JSX: a `.tsx` file cannot load under `bun test`, and this one is tested.
 */
import { onCleanup, splitProps, type JSX, type ParentProps } from "solid-js"
import { createComponent, Dynamic } from "solid-js/web"
import { Dialog } from "@kobalte/core/dialog"

export interface SheetProps {
  /** On the overlay, as `data-component`: each sheet's CSS keys off it. */
  readonly component: string
  readonly onClose: () => void
  readonly size?: "sm" | "md" | "lg" | "xl"
  readonly place?: "top" | "center"
  /** The panel, for a sheet that moves the focus back to it. */
  readonly ref?: (element: HTMLDivElement) => void
  readonly onKeyDown?: JSX.EventHandler<HTMLDivElement, KeyboardEvent>
  /** Where it renders; the shell by default. */
  readonly mount?: Node
}

/** The shell, where the theme's tokens are; `body` outside ADE (the tests). */
function shell(): Node | undefined {
  if (typeof document === "undefined") return undefined
  return document.querySelector('[data-component="ade-shell"]') ?? document.body
}

export function Sheet(props: ParentProps<SheetProps>): JSX.Element {
  const [own] = splitProps(props, ["component", "onClose", "size", "place", "ref", "onKeyDown", "mount", "children"])
  // What had the focus before: the button, the palette, the terminal. It gets it back.
  const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
  let panel: HTMLDivElement | undefined
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) queueMicrotask(() => opener.focus())
  })

  return createComponent(Dialog, {
    open: true,
    modal: true,
    // The workbench does not scroll; locking `body` would only shift the layout.
    preventScroll: false,
    onOpenChange: (open: boolean) => {
      if (!open) own.onClose()
    },
    get children() {
      return createComponent(Dialog.Portal, {
        get mount() {
          return own.mount ?? shell()
        },
        get children() {
          return createComponent(Dynamic, {
            component: "div",
            "data-layout": "overlay",
            get "data-component"() {
              return own.component
            },
            get "data-place"() {
              return own.place === "center" ? "center" : undefined
            },
            get children() {
              return createComponent(Dialog.Content, {
                "data-layout": "surface",
                get "data-size"() {
                  return own.size ?? "md"
                },
                "aria-modal": "true",
                tabIndex: -1,
                ref: (element: HTMLDivElement) => {
                  panel = element
                  own.ref?.(element)
                },
                get onKeyDown() {
                  return own.onKeyDown
                },
                // The panel itself, not its first button: the sheets read their keys on it.
                // After a tick, as Kobalte's own: the trap has to be listening to see it.
                onOpenAutoFocus: (event: Event) => {
                  event.preventDefault()
                  setTimeout(() => panel?.focus(), 0)
                },
                // Given back by the cleanup above, to the opener rather than to `body`.
                onCloseAutoFocus: (event: Event) => event.preventDefault(),
                get children() {
                  return own.children
                },
              })
            },
          })
        },
      })
    },
  })
}

/** The sheet's title: the element the dialog is named by (`aria-labelledby`). */
export const SheetTitle = Dialog.Title
