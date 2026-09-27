/*
 * A chip in the composer and the menu it opens (composer-chip, pezzo 2): the
 * model's and the effort's. A button that says the current choice, and a
 * list the keys move through: arrows, Enter, Escape back to the chip.
 *
 * The chip is plain, in the field's own black: no accent, no ring of colour
 * (the user: «semplice base nero», DS-chat).
 */
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show, type JSX } from "solid-js"
import { moveActive, type ChipMenuItem } from "./picker"

export type { ChipMenuItem }

export interface ChipMenuProps {
  /** What the chip is for, read by a screen reader before its value. */
  readonly label: string
  /** The current choice, as the chip shows it. */
  readonly text: string
  readonly value: string
  readonly items: readonly ChipMenuItem[]
  readonly kind: string
  readonly disabled?: boolean
  /** In a form: the chip fills its field, and the menu opens under it at the field's width. */
  readonly below?: boolean
  /** A search field on top of the list; absent, none. */
  readonly search?: { readonly placeholder: string; readonly query: string; readonly onQuery: (query: string) => void }
  /** Said above the list: loading, or why the list is not there. */
  readonly status?: JSX.Element
  /** After the list: the paid models kept hidden. */
  readonly footer?: JSX.Element
  /** Said when the list has no option. */
  readonly empty?: string
  /** The chip's tooltip, when it says more than its text (a model's id). */
  readonly title?: string
  /** «warn»: the choice cannot be used as it is (a model the catalog no longer has). */
  readonly tone?: "warn"
  readonly onOpen?: () => void
  readonly onChoose: (value: string) => void
}

export function ChipMenu(props: ChipMenuProps) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal<string>()
  let root: HTMLDivElement | undefined
  let chip: HTMLButtonElement | undefined
  let field: HTMLInputElement | undefined
  let list: HTMLUListElement | undefined

  const values = () => props.items.flatMap((item) => (item.kind === "option" ? [item.value] : []))
  const optionId = (value: string) => `${id}-${values().indexOf(value)}`

  const show = () => {
    if (props.disabled || open()) return
    setOpen(true)
    setActive(props.value)
    props.onOpen?.()
    queueMicrotask(() => (field ?? list)?.focus())
  }
  const hide = (refocus: boolean) => {
    if (!open()) return
    setOpen(false)
    props.search?.onQuery("")
    if (refocus) chip?.focus()
  }
  const choose = (value: string) => {
    props.onChoose(value)
    hide(true)
  }

  // A click anywhere else closes it, as a native menu would.
  createEffect(() => {
    if (!open()) return
    const away = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) hide(false)
    }
    document.addEventListener("pointerdown", away, true)
    onCleanup(() => document.removeEventListener("pointerdown", away, true))
  })

  // The active option stays in sight while the arrows move it.
  createEffect(() => {
    const value = active()
    if (!open() || value === undefined) return
    const element = list?.querySelector<HTMLElement>(`#${CSS.escape(optionId(value))}`)
    element?.scrollIntoView?.({ block: "nearest" })
  })

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setActive(
        moveActive(
          values(),
          active() !== undefined && values().includes(active()!) ? active() : undefined,
          event.key === "ArrowDown" ? 1 : -1,
        ),
      )
    } else if (event.key === "Enter") {
      const value = active()
      if (value !== undefined && values().includes(value)) {
        event.preventDefault()
        choose(value)
      }
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      hide(true)
    } else if (event.key === "Tab") {
      hide(false)
    }
  }

  return (
    <div
      data-slot="chip-menu"
      data-kind={props.kind}
      data-below={props.below ? "" : undefined}
      data-tone={props.tone}
      ref={root}
    >
      <button
        type="button"
        data-slot="chip"
        ref={chip}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={`${props.label}: ${props.text}`}
        title={props.title ?? props.text}
        onClick={() => (open() ? hide(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open()) {
            event.preventDefault()
            show()
          }
        }}
      >
        <span data-slot="chip-text">{props.text}</span>
        {/* Drawn, not a ▾: at the chip's size the glyph read as a dot. */}
        <svg data-slot="chip-caret" aria-hidden="true" viewBox="0 0 10 6" width="10" height="6">
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <Show when={open()}>
        <div data-slot="chip-popover" role="dialog" aria-label={props.label}>
          <Show when={props.search}>
            {(search) => (
              <input
                data-slot="chip-search"
                ref={field}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={
                  active() !== undefined && values().includes(active()!) ? optionId(active()!) : undefined
                }
                aria-label={search().placeholder}
                placeholder={search().placeholder}
                value={search().query}
                onInput={(event) => {
                  search().onQuery(event.currentTarget.value)
                  setActive(undefined)
                }}
                onKeyDown={onMenuKey}
              />
            )}
          </Show>
          <Show when={props.status}>
            <div data-slot="chip-status">{props.status}</div>
          </Show>
          <ul
            data-slot="chip-list"
            id={`${id}-list`}
            ref={list}
            role="listbox"
            aria-label={props.label}
            tabIndex={props.search ? -1 : 0}
            aria-activedescendant={
              !props.search && active() !== undefined && values().includes(active()!) ? optionId(active()!) : undefined
            }
            onKeyDown={(event) => {
              if (!props.search) onMenuKey(event)
            }}
          >
            <For each={props.items}>
              {(item) =>
                item.kind === "group" ? (
                  <li data-slot="chip-group" role="presentation">
                    {item.label}
                  </li>
                ) : (
                  <li
                    data-slot="chip-option"
                    id={optionId(item.value)}
                    role="option"
                    aria-selected={item.value === props.value}
                    data-active={item.value === active() ? "" : undefined}
                    title={item.hint ?? item.label}
                    // Chosen on the click, not on the press: the field keeps the focus meanwhile.
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerEnter={() => setActive(item.value)}
                    onClick={() => choose(item.value)}
                  >
                    <span data-slot="chip-option-label">{item.label}</span>
                    <Show when={item.detail}>
                      <span data-slot="chip-option-detail">{item.detail}</span>
                    </Show>
                  </li>
                )
              }
            </For>
            <Show when={values().length === 0 && props.empty}>
              <li data-slot="chip-empty" role="presentation">
                {props.empty}
              </li>
            </Show>
          </ul>
          <Show when={props.footer}>
            <div data-slot="chip-footer">{props.footer}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
