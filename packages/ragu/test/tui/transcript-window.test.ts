import { describe, expect, it } from "bun:test"
import { AUTO_WINDOW_TURNS, transcriptWindow, windowingOn } from "@tui/routes/session/message-window"
import { estimateTurnHeight, fromEntries, type ViewEntry } from "@tui/routes/session/view"

/*
 * A session of ~1200 messages with every row mounted needs more text buffers
 * than opentui's native side will make (~16 thousand) and cannot be drawn.
 * Windowing mounts only what is near the viewport, but it was opt-in, so the
 * sessions that needed it never had it.
 */
const SESSION = "ses_grande"

function session(messages: number, options: { writing?: boolean } = {}): ViewEntry[] {
  const entries: ViewEntry[] = []
  for (let i = 0; i < messages; i++) {
    const messageID = `msg_${String(i).padStart(5, "0")}`
    const at = i * 10
    if (i % 2 === 0) {
      entries.push({
        id: `evt_${messageID}_0`,
        sessionID: SESSION,
        messageID,
        type: "user",
        timestamp: at,
        text: `Messaggio ${i}: leggi il file e correggi il test.`,
      })
      continue
    }
    const last = i === messages - 1
    entries.push(
      {
        id: `evt_${messageID}_0`,
        sessionID: SESSION,
        messageID,
        type: "start",
        timestamp: at,
        agent: "build",
        mode: "build",
        modelID: "grok-4.7",
        providerID: "xai",
      },
      {
        id: `evt_${messageID}_1`,
        sessionID: SESSION,
        messageID,
        type: "text",
        timestamp: at + 1,
        ref: `prt_${i}`,
        text: Array.from({ length: (i % 7) + 1 }, (_, line) => `Riga ${line} della risposta ${i}.`).join("\n"),
      },
    )
    if (!(last && options.writing))
      entries.push({
        id: `evt_${messageID}_2`,
        sessionID: SESSION,
        messageID,
        type: "complete",
        timestamp: at + 2,
        finish: "stop",
        tokens: { output: 10 },
        cost: 0,
      })
  }
  return entries
}

const WIDTH = 100
const VIEWPORT = 40

function heightsOf(entries: ViewEntry[]) {
  return fromEntries(entries).map((turn) => estimateTurnHeight(turn, WIDTH))
}

describe("windowing a large session", () => {
  it("is on by itself past the threshold, and only there", () => {
    expect(windowingOn(undefined, 1200)).toBe(true)
    expect(windowingOn(undefined, AUTO_WINDOW_TURNS + 1)).toBe(true)
    expect(windowingOn(undefined, AUTO_WINDOW_TURNS)).toBe(false)
    expect(windowingOn(undefined, 40)).toBe(false)
  })

  it("lets the user's explicit setting win either way", () => {
    expect(windowingOn(false, 1200)).toBe(false)
    expect(windowingOn(true, 3)).toBe(true)
  })

  it("mounts a few turns of a 1200-message session opened at the bottom, the last among them", () => {
    const turns = fromEntries(session(1200))
    expect(turns).toHaveLength(1200)
    expect(windowingOn(undefined, turns.length)).toBe(true)
    const heights = turns.map((turn) => estimateTurnHeight(turn, WIDTH))
    const window = transcriptWindow({ heights, scrollTop: 0, viewportHeight: VIEWPORT, atBottom: true, overscan: 5 })
    expect(window.end).toBe(1200)
    expect(window.end - window.start).toBeLessThan(40)
    const total = heights.reduce((sum, height) => sum + height, 0)
    expect(window.top + heights.slice(window.start, window.end).reduce((a, b) => a + b, 0) + window.bottom).toBe(total)
  })

  it("keeps windowing while the last reply is being written, and keeps that reply mounted", () => {
    // Windowing used to switch off while any turn was open, which mounted all
    // 1200 rows the moment a new reply started.
    const entries = session(1200, { writing: true })
    const turns = fromEntries(entries)
    expect(turns.at(-1)?.completedAt).toBeUndefined()
    const heights = heightsOf(entries)
    // The reply has grown well past its estimate: the scrollbox, held at the
    // bottom, reports a scrollTop the estimates put turns before the end.
    const window = transcriptWindow({
      heights,
      scrollTop: heights.reduce((a, b) => a + b, 0) - VIEWPORT - 200,
      viewportHeight: VIEWPORT,
      atBottom: true,
      overscan: 5,
    })
    expect(window.end).toBe(1200)
    expect(window.end - window.start).toBeLessThan(40)
  })

  it("follows the scroll position away from the bottom", () => {
    const heights = heightsOf(session(1200))
    const window = transcriptWindow({ heights, scrollTop: 0, viewportHeight: VIEWPORT, atBottom: false, overscan: 5 })
    expect(window.start).toBe(0)
    expect(window.top).toBe(0)
    expect(window.end).toBeLessThan(40)
  })
})
