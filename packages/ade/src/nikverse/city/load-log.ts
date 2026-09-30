/**
 * The world's opening, phase by phase: where an opening that never reaches `ready` stops (the Architect's decision on
 * old PCs, point 3). Only a measure: the opening does the same with it or without it.
 *
 * `window.__nikverseLoad` holds the entries in order, times in ms from the page's start (`performance.now()`). An
 * entry with no `ms` is still running: for a phase, that is where the opening stopped. The pieces (a file fetched, a
 * picture decoded) run in parallel inside their phase, each with its own time. `data-load` on the page's root names
 * the phase running now, and says `ready` at the end.
 */

export interface LoadEntry {
  name: string
  /** A phase follows the one before; a piece runs inside its phase, alongside the others. */
  kind: "phase" | "piece"
  at: number
  ms?: number
  failed?: true
}

export interface LoadLog {
  /** Closes the running phase and opens `name`. */
  phase(name: string): void
  /** Opens a piece of the running phase; the function it gives back closes it. After `done` a piece is not written. */
  piece(name: string): (failed?: boolean) => void
  /** Closes the running phase: the opening is done. */
  done(): void
}

type LogWindow = { performance: { now(): number }; document: { documentElement?: { dataset: DOMStringMap } | null } }

const tenth = (ms: number) => Math.round(ms * 10) / 10

export function createLoadLog(win: LogWindow): LoadLog {
  const entries: LoadEntry[] = []
  ;(win as { __nikverseLoad?: LoadEntry[] }).__nikverseLoad = entries
  let running: LoadEntry | undefined
  let finished = false
  const say = (name: string) => {
    const data = win.document.documentElement?.dataset
    if (data) data.load = name
  }
  const close = (entry: LoadEntry, failed?: boolean) => {
    if (entry.ms !== undefined) return
    entry.ms = tenth(win.performance.now() - entry.at)
    if (failed) entry.failed = true
  }
  return {
    phase(name) {
      if (running) close(running)
      running = { name, kind: "phase", at: tenth(win.performance.now()) }
      entries.push(running)
      say(name)
    },
    piece(name) {
      if (finished) return () => {}
      const entry: LoadEntry = { name, kind: "piece", at: tenth(win.performance.now()) }
      entries.push(entry)
      return (failed) => close(entry, failed)
    },
    done() {
      if (running) close(running)
      running = undefined
      finished = true
      say("ready")
    },
  }
}

/** The last part of an address, for a piece's name: `levels/media/city.glb`, not the whole scheme and host. */
export const shortUrl = (url: string) => url.split(/[?#]/)[0].split("/").slice(-3).join("/")

export interface DrawProbe {
  /** Just before a draw of the loop. */
  before(): void
  /** Just after it; true for the first draw of all (the page's `data-ready`). */
  after(): boolean
}

/**
 * The opening's last phases, around the loop's draws. `first-draw` is the first render call: in JS, every material's
 * shader is built there (TSL to WGSL for WebGPU; WebGL compiles its programs in it too). `first-draw-gpu` is the GPU
 * finishing it, WebGPU's pipelines compiled on the way. Then one `warm-draw` and its `warm-draw-gpu`, with every
 * shader already made: the first draw less the warm one is what compiling cost. Without a queue to wait on (WebGL,
 * which would have to stall for it) the GPU's parts close at once. After that it is two comparisons a draw.
 */
export function drawProbe(log: LoadLog, gpuDone?: () => Promise<unknown>): DrawProbe {
  let step: "first" | "first-gpu" | "warm" | "warm-gpu" | "open" = "first"
  const wait = (then: () => void) => (gpuDone ? void gpuDone().then(then, then) : then())
  return {
    before() {
      if (step === "first") log.phase("first-draw")
      else if (step === "warm") log.phase("warm-draw")
    },
    after() {
      if (step === "first") {
        step = "first-gpu"
        log.phase("first-draw-gpu")
        // Closed as soon as the GPU is done; the warm draw is the loop's next one, whenever it comes.
        wait(() => {
          step = "warm"
          log.phase("warm-wait")
        })
        return true
      }
      if (step === "warm") {
        step = "warm-gpu"
        log.phase("warm-draw-gpu")
        wait(() => {
          step = "open"
          log.done()
        })
      }
      return false
    },
  }
}
