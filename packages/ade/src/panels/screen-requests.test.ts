import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Terminal } from "@xterm/xterm"
import { createLineAccumulator } from "../host/line-stream"
import { codeOf } from "../test-support/source-text"
import { parseRequest } from "./protocol"
import { RESTORED_MS, SCREEN_QUIET_MS, alternateRows, createScreenRequests, newRequests } from "./screen-requests"

/*
 * A nikcli pane wrote `@ade keys ask …` and ADE never answered (Verifiche,
 * 2026-09-27). The fixture is the pty stream of nikcli 1.400 on
 * `nemotron-3.5-lightning:free`, 120x30, asked to write only
 * `@ade keys ask ADE_PROVA_FINTA prova di Dario`: the bytes as they arrived,
 * and when each read arrived (`ms size`, one per line).
 */
const FIXTURE = join(import.meta.dir, "fixtures", "nikcli-ade-request")
const bytes = readFileSync(`${FIXTURE}.bin`)
const reads = readFileSync(`${FIXTURE}.chunks`, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split(" ").map(Number) as [number, number])
const REQUEST = "@ade keys ask ADE_PROVA_FINTA prova di Dario"

/** The stream cut where the pty's reads were, decoded as `shell.ts` does. */
function chunks(): { at: number; text: string }[] {
  const decoder = new TextDecoder()
  let offset = 0
  return reads.map(([at, size]) => {
    const text = decoder.decode(bytes.subarray(offset, offset + size), { stream: true })
    offset += size
    return { at, text }
  })
}

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve))
}

/** A clock and timers that move only when told to. */
function clock() {
  let now = 0
  let next = 0
  const due = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = ++next
      due.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: (id: unknown) => void due.delete(id as number),
    advance(to: number) {
      for (;;) {
        const first = [...due.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
        if (!first) break
        due.delete(first[0])
        now = first[1].at
        first[1].run()
      }
      now = Math.max(now, to)
    },
  }
}

/** The capture played into a real terminal at its own pace, the screen read as the workbench reads it. */
async function play() {
  const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true })
  const time = clock()
  const heard: string[] = []
  const screen = createScreenRequests({
    rows: () => alternateRows(terminal),
    onRequest: (_pane, line) => heard.push(line),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  screen.start("p", false)
  for (const { at, text } of chunks()) {
    time.advance(at)
    await write(terminal, text)
    screen.fed("p")
  }
  time.advance(reads.at(-1)![0] + SCREEN_QUIET_MS)
  return { terminal, time, heard, screen }
}

describe("the request of an agent that draws its screen with the cursor", () => {
  test("the cause: what reaches onLine holds no request, and the screen does", async () => {
    const lines = createLineAccumulator()
    const read = [...chunks().flatMap(({ text }) => lines.push(text)), ...lines.flush()]
    // The request is in there, amid the rest of the screen: each word is placed with a cursor move.
    expect(read.some((line) => line.includes("@ade"))).toBe(true)
    expect(read.some((line) => parseRequest(line))).toBe(false)

    const { terminal } = await play()
    const rows = alternateRows(terminal)!
    expect(rows.filter((row) => parseRequest(row)).map((row) => row.trim())).toEqual([REQUEST])
    terminal.dispose()
  })

  test("read from the screen once the pane goes quiet: once, whole", async () => {
    const { terminal, heard } = await play()
    expect(heard).toEqual([REQUEST])
    terminal.dispose()
  })

  test("drawn again — a redraw, a scroll away and back — it is not acted on again", async () => {
    const { terminal, time, heard, screen } = await play()
    const drawn = alternateRows(terminal)!.join("\r\n")
    await write(terminal, "\x1b[2J\x1b[H")
    screen.fed("p")
    time.advance(time.now() + SCREEN_QUIET_MS)
    await write(terminal, `\x1b[H${drawn}`)
    screen.fed("p")
    time.advance(time.now() + SCREEN_QUIET_MS)
    expect(heard).toEqual([REQUEST])
    terminal.dispose()
  })

  test("written again while the first is still on the screen, it is read again", async () => {
    const { terminal, time, heard, screen } = await play()
    await write(terminal, `\x1b[22;5H${REQUEST}`)
    screen.fed("p")
    time.advance(time.now() + SCREEN_QUIET_MS)
    expect(heard).toEqual([REQUEST, REQUEST])
    terminal.dispose()
  })

  test("a conversation reopened shows its old requests: not acted on, a new one is", async () => {
    const drawn = alternateRows((await play()).terminal)!.join("\r\n")
    // The same screen drawn at once, as a conversation reopened comes back.
    const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true })
    const time = clock()
    const heard: string[] = []
    const screen = createScreenRequests({
      rows: () => alternateRows(terminal),
      onRequest: (_pane, line) => heard.push(line),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    screen.start("p", true)
    time.advance(2_000)
    await write(terminal, `\x1b[?1049h\x1b[H${drawn}`)
    screen.fed("p")
    time.advance(time.now() + SCREEN_QUIET_MS)
    expect(heard).toEqual([])
    time.advance(RESTORED_MS)
    await write(terminal, `\x1b[22;5H${REQUEST}`)
    screen.fed("p")
    time.advance(time.now() + SCREEN_QUIET_MS)
    expect(heard).toEqual([REQUEST])
    terminal.dispose()
  })

  test("an agent that prints lines is left to onLine: no screen is read", async () => {
    const terminal = new Terminal({ cols: 80, rows: 10 })
    await write(terminal, `${REQUEST}\r\n`)
    expect(alternateRows(terminal)).toBeUndefined()
    terminal.dispose()
  })

  test("a row half drawn is not what a quiet screen shows: a request needs the whole row", () => {
    const peak = new Map<string, number>()
    expect(newRequests(["┃  Output exactly this line: @ade keys ask X", "    Thought: 1.5s"], peak)).toEqual([])
    expect(newRequests([`    ${REQUEST}`, `    ${REQUEST}`], peak)).toEqual([REQUEST, REQUEST])
  })
})

describe("lint: the workbench reads the screen and leaves those lines out of onLine", () => {
  const workbench = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")

  test("lint: every chunk fed to a terminal arms the screen reading", () => {
    const feed = workbench.slice(
      workbench.indexOf("const feedTerminal = "),
      workbench.indexOf("const feedTerminal = ") + 1500,
    )
    expect(codeOf(feed)).toContain(codeOf("writeToTerminal(paneId, chunk)\n    screenRequests.fed(paneId)"))
  })

  test("lint: a process started says whether it reopened a conversation, and a closed pane is forgotten", () => {
    expect(codeOf(workbench)).toContain(codeOf("screenRequests.start(paneId, resumed ||"))
    expect(codeOf(workbench)).toContain(codeOf("forgetQuiet(id)\n    screenRequests.forget(id)"))
  })
})
