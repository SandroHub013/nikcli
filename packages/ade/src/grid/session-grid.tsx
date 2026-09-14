import { For, type JSX, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { type FocusDirection, focusAfterClose, moveFocus } from "./focus"
import { GRID_GAP, MIN_PANE_HEIGHT, gridColumns, gridRows } from "./layout"

export interface GridPane {
  id: string
  /** Anything the pane should render as its body. */
  render: () => JSX.Element
}

export interface SessionGridProps {
  panes: GridPane[]
  focused: string | undefined
  onFocus: (id: string) => void
  onClose?: (id: string, nextFocus: string | undefined) => void
  /** User-chosen column count. Undefined lets the layout decide. */
  columns?: number
}

const ARROWS: Record<string, FocusDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
}

/**
 * The tiled grid of live agent sessions.
 *
 * Everything about *where* panes go lives in `./layout`, and everything about
 * which one is focused lives in `./focus`. What is left here is measurement and
 * wiring — deliberately, because the two extracted parts are where the bugs are
 * and neither of them needs a DOM to be tested.
 */
export function SessionGrid(props: SessionGridProps) {
  let container!: HTMLDivElement
  const [box, setBox] = createSignal({ width: 0, height: 0 })

  onMount(() => {
    // The column count is a function of the container, so it has to be measured
    // rather than assumed: this grid sits next to a sidebar and a panel that the
    // user drags, and a window resize is not the only thing that changes it.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const rect = entry.contentRect
      setBox({ width: rect.width, height: rect.height })
    })
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })

  const columns = createMemo(() =>
    gridColumns({
      count: props.panes.length,
      width: box().width,
      height: box().height,
      pinned: props.columns,
    }),
  )

  const focusedIndex = createMemo(() => props.panes.findIndex((pane) => pane.id === props.focused))

  /*
   * `close` used to be declared here and never called: the grid does not draw
   * the close control, the pane does, and the pane calls the workbench
   * directly. Removed rather than left as a helper nobody reaches — dead code
   * next to live code reads as a code path, and someone will eventually
   * reason about the system as though this one ran.
   */

  const onKeyDown = (event: KeyboardEvent) => {
    const direction = ARROWS[event.key]
    // Only with a modifier: the arrows belong to whatever has focus inside the
    // pane — a prompt, a scrolled transcript — and stealing them would make the
    // composer unusable.
    if (!direction || !event.altKey) return
    const index = focusedIndex()
    if (index === -1) return
    const next = moveFocus({ count: props.panes.length, columns: columns(), index, direction })
    if (next === index) return
    event.preventDefault()
    const pane = props.panes[next]
    if (pane) props.onFocus(pane.id)
  }

  return (
    <div
      ref={container}
      data-component="session-grid"
      data-empty={props.panes.length === 0 ? "true" : undefined}
      onKeyDown={onKeyDown}
      style={{
        "grid-template-columns": `repeat(${columns()}, minmax(0, 1fr))`,
        "grid-auto-rows": `minmax(${MIN_PANE_HEIGHT}px, calc((100% - ${
          GRID_GAP * (gridRows(props.panes.length, columns()) - 1)
        }px) / ${Math.max(1, gridRows(props.panes.length, columns()))}))`,
      }}
    >
      <For each={props.panes}>
        {(pane) => (
          <div
            data-slot="grid-cell"
            data-focused={pane.id === props.focused ? "true" : undefined}
            onFocusIn={() => props.onFocus(pane.id)}
            onPointerDown={() => props.onFocus(pane.id)}
          >
            {pane.render()}
          </div>
        )}
      </For>
    </div>
  )
}

/** Exposed so a host can drive closing without reimplementing the focus rule. */
export { focusAfterClose, moveFocus }
