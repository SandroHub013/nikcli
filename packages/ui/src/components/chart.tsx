import { createMemo, createSignal, createUniqueId, For, Show, type ComponentProps, type JSX } from "solid-js"

export type ChartSeries = {
  key: string
  label?: string
  /** Any CSS color. Defaults to the palette slot for this series' position. */
  color?: string
}

export type ChartPoint = Record<string, string | number | undefined>

/** Logical drawing width. The SVG scales to its container, strokes do not. */
const VIEW_W = 1000
const PAD_TOP = 6

type Pt = { x: number; y: number }

/**
 * Fritsch–Carlson monotone cubic. Keeps the curve from overshooting between
 * samples, which a plain cardinal spline does on spiky token counts.
 */
function monotonePath(points: Pt[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`

  const n = points.length
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx)
  }

  const tangents: number[] = new Array(n)
  tangents[0] = slopes[0]
  tangents[n - 1] = slopes[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) tangents[i] = 0
    else tangents[i] = (slopes[i - 1] + slopes[i]) / 2
  }

  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const alpha = tangents[i] / slopes[i]
    const beta = tangents[i + 1] / slopes[i]
    const magnitude = alpha * alpha + beta * beta
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude)
      tangents[i] = scale * alpha * slopes[i]
      tangents[i + 1] = scale * beta * slopes[i]
    }
  }

  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const c1x = points[i].x + dx / 3
    const c1y = points[i].y + (tangents[i] * dx) / 3
    const c2x = points[i + 1].x - dx / 3
    const c2y = points[i + 1].y - (tangents[i + 1] * dx) / 3
    path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${points[i + 1].x} ${points[i + 1].y}`
  }
  return path
}

export interface AreaChartProps {
  data: ChartPoint[]
  series: ChartSeries[]
  /** Key holding the category/date value. */
  xKey?: string
  height?: number
  /** Sum series on top of each other instead of overlaying them. */
  stacked?: boolean
  /** Rows shown in the hover panel. */
  format?: (value: number) => string
  formatX?: (value: string | number) => string
  status?: "loading" | "ready"
  empty?: JSX.Element
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

export function AreaChart(props: AreaChartProps) {
  const uid = createUniqueId()
  const [hoverRaw, setHover] = createSignal<number>()

  /**
   * The hovered index, dropped when the data no longer reaches it.
   *
   * Switching the window from 90 days to 7 leaves the old index behind. `xAt`
   * extrapolates rather than clamping, so a crosshair was drawn thousands of
   * units past the viewBox and the panel grew a horizontal scrollbar many times
   * its own width.
   */
  const hover = createMemo(() => {
    const index = hoverRaw()
    if (index === undefined || index < 0 || index >= props.data.length) return undefined
    return index
  })

  const height = () => props.height ?? 150
  const xKey = () => props.xKey ?? "x"
  const format = (value: number) => (props.format ? props.format(value) : String(value))

  const valueAt = (index: number, key: string) => {
    const raw = props.data[index]?.[key]
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0
  }

  /** Per-point running totals, so a stacked series knows its own baseline. */
  const baselines = createMemo(() => {
    const stacked = props.stacked ?? false
    return props.data.map((_, index) => {
      const list: number[] = []
      let running = 0
      for (const item of props.series) {
        list.push(running)
        if (stacked) running += valueAt(index, item.key)
      }
      return list
    })
  })

  /** Largest stacked or overlaid value in the window; 0 when everything is zero. */
  const peak = createMemo(() => {
    let max = 0
    for (let index = 0; index < props.data.length; index++) {
      if (props.stacked) {
        let sum = 0
        for (const item of props.series) sum += valueAt(index, item.key)
        max = Math.max(max, sum)
      } else {
        for (const item of props.series) max = Math.max(max, valueAt(index, item.key))
      }
    }
    return max
  })

  // Divisor only: a flat-zero window still needs a non-zero denominator.
  const maxY = createMemo(() => peak() || 1)

  const xAt = (index: number) => {
    const count = props.data.length
    if (count <= 1) return VIEW_W / 2
    return (index / (count - 1)) * VIEW_W
  }

  const yAt = (value: number) => {
    const usable = height() - PAD_TOP
    return height() - (value / maxY()) * usable
  }

  const topPoints = (seriesIndex: number): Pt[] =>
    props.data.map((_, index) => ({
      x: xAt(index),
      y: yAt(baselines()[index][seriesIndex] + valueAt(index, props.series[seriesIndex].key)),
    }))

  const basePoints = (seriesIndex: number): Pt[] =>
    props.data.map((_, index) => ({ x: xAt(index), y: yAt(baselines()[index][seriesIndex]) }))

  const areaPath = (seriesIndex: number) => {
    const top = topPoints(seriesIndex)
    if (top.length === 0) return ""
    const bottom = basePoints(seriesIndex).reverse()
    // The floor has to be the same curve as the crest below it. When stacked,
    // `basePoints(k)` is exactly `topPoints(k - 1)`: one band drew that boundary
    // as a cubic and the next drew it as straight chords, so every boundary in
    // the chart showed a seam — a double-painted stripe where the chord sat
    // below the curve, bare background where it sat above.
    //
    // Unstacked, the floor is the flat zero baseline, where the interpolation
    // returns the same straight line either way.
    const back = monotonePath(bottom).replace(/^M/, "L")
    return `${monotonePath(top)} ${back} Z`
  }

  const colorOf = (seriesIndex: number) =>
    props.series[seriesIndex].color ?? `var(--chart-${(seriesIndex % 6) + 1})`

  // Guard on the real peak, not the clamped divisor: testing `maxY() > 1` made any
  // window whose largest value was 1 render as empty.
  const hasData = createMemo(() => props.data.length > 0 && props.series.length > 0 && peak() > 0)

  const onMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || props.data.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setHover(Math.round(ratio * (props.data.length - 1)))
  }

  /** First, middle and last category — enough to anchor the window in time. */
  const axisTicks = createMemo(() => {
    const count = props.data.length
    if (count === 0) return []
    const label = (index: number) => {
      const raw = props.data[index]?.[xKey()]
      if (raw === undefined) return ""
      return props.formatX ? props.formatX(raw) : String(raw)
    }
    if (count < 3) return [label(0), label(count - 1)]
    return [label(0), label(Math.floor((count - 1) / 2)), label(count - 1)]
  })

  const hoveredX = () => {
    const index = hover()
    if (index === undefined) return undefined
    const raw = props.data[index]?.[xKey()]
    if (raw === undefined) return undefined
    return props.formatX ? props.formatX(raw) : String(raw)
  }

  return (
    <div
      data-component="chart"
      data-status={props.status ?? "ready"}
      classList={{
        ...(props.classList ?? {}),
        [props.class ?? ""]: !!props.class,
      }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(undefined)}
    >
      <Show when={hasData()} fallback={<div data-slot="chart-empty">{props.empty ?? "No data yet"}</div>}>
        <svg
          data-slot="chart-svg"
          viewBox={`0 0 ${VIEW_W} ${height()}`}
          preserveAspectRatio="none"
          style={{ height: `${height()}px` }}
          aria-hidden="true"
        >
          <defs>
            <clipPath id={`chart-reveal-${uid}`}>
              <rect data-slot="chart-reveal" x="0" y="0" width={VIEW_W} height={height()} />
            </clipPath>
            <For each={props.series}>
              {(_, index) => (
                <linearGradient id={`chart-fill-${uid}-${index()}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color={colorOf(index())} stop-opacity="0.38" />
                  <stop offset="100%" stop-color={colorOf(index())} stop-opacity="0.02" />
                </linearGradient>
              )}
            </For>
          </defs>

          <g data-slot="chart-grid">
            <For each={[0.25, 0.5, 0.75]}>
              {(ratio) => (
                <line
                  x1="0"
                  x2={VIEW_W}
                  y1={height() * ratio}
                  y2={height() * ratio}
                  vector-effect="non-scaling-stroke"
                />
              )}
            </For>
          </g>

          <g clip-path={`url(#chart-reveal-${uid})`}>
            <For each={props.series}>
              {(_, index) => (
                <>
                  <path d={areaPath(index())} fill={`url(#chart-fill-${uid}-${index()})`} />
                  <path
                    data-slot="chart-line"
                    d={monotonePath(topPoints(index()))}
                    fill="none"
                    stroke={colorOf(index())}
                    vector-effect="non-scaling-stroke"
                  />
                </>
              )}
            </For>
          </g>

          <Show when={hover() !== undefined}>
            <line
              data-slot="chart-crosshair"
              x1={xAt(hover()!)}
              x2={xAt(hover()!)}
              y1="0"
              y2={height()}
              vector-effect="non-scaling-stroke"
            />
          </Show>
        </svg>

        <Show when={props.data.length > 1}>
          <div data-slot="chart-axis" aria-hidden="true">
            <For each={axisTicks()}>{(tick) => <span>{tick}</span>}</For>
          </div>
        </Show>

        <Show when={hover() !== undefined}>
          <div
            data-slot="chart-tooltip"
            style={{
              left: `${(xAt(hover()!) / VIEW_W) * 100}%`,
              // Flip the panel before it runs off the right edge.
              transform: xAt(hover()!) > VIEW_W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <Show when={hoveredX()}>{(label) => <span data-slot="chart-tooltip-title">{label()}</span>}</Show>
            <For each={props.series}>
              {(item, index) => (
                <Show when={valueAt(hover()!, item.key) > 0}>
                  <span data-slot="chart-tooltip-row">
                    <span data-slot="chart-swatch" style={{ background: colorOf(index()) }} />
                    <span data-slot="chart-tooltip-label">{item.label ?? item.key}</span>
                    <span data-slot="chart-tooltip-value">{format(valueAt(hover()!, item.key))}</span>
                  </span>
                </Show>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export interface ShareBarProps {
  segments: Array<{ key: string; value: number; label?: string; color?: string }>
  format?: (value: number) => string
  class?: string
}

/** A single stacked bar for "what share of the total is each thing". */
export function ShareBar(props: ShareBarProps) {
  const total = createMemo(() => props.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0) || 1)

  return (
    <div data-component="chart-share" class={props.class}>
      <div data-slot="chart-share-track">
        <For each={props.segments}>
          {(segment, index) => (
            <span
              data-slot="chart-share-segment"
              title={`${segment.label ?? segment.key} · ${props.format ? props.format(segment.value) : segment.value}`}
              style={{
                width: `${(Math.max(0, segment.value) / total()) * 100}%`,
                background: segment.color ?? `var(--chart-${(index() % 6) + 1})`,
                "animation-delay": `${index() * 60}ms`,
              }}
            />
          )}
        </For>
      </div>
    </div>
  )
}
