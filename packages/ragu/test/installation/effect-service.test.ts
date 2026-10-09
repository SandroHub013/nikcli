import { describe, expect, it } from "bun:test"
import { Installation } from "@/installation"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"
import { createComponent, createRoot } from "solid-js"
import { consumeGlobalEventStream, SDKProvider, useSDK, type GlobalEnvelope } from "@tui/context/sdk"
import { TERMINAL_RESET_SEQUENCE } from "@ragu/util/win32"

function runInstallation<A, E>(effect: Effect.Effect<A, E, Installation.Service>) {
  return runPromiseWithLayer(Installation.defaultLayer, effect)
}

describe("Installation.Service", () => {
  it("detects the install method through the Effect service boundary, for uninstall", async () => {
    const method = await runInstallation(
      Effect.gen(function* () {
        const installation = yield* Installation.Service
        return typeof installation.method
      }),
    )
    expect(method).toBe("function")
  })
})

describe("terminal teardown", () => {
  it("disables OpenTUI mouse reporting modes", () => {
    for (const mode of [1000, 1002, 1003, 1004, 1006, 1015]) {
      expect(TERMINAL_RESET_SEQUENCE).toContain(`\x1b[?${mode}l`)
    }
  })
})

describe("TUI event stream", () => {
  it("establishes HTTP readiness from server.connected and continues consuming events", async () => {
    const connected: GlobalEnvelope = {
      payload: { type: "server.connected", properties: {} },
    }
    const idle = {
      payload: {
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      },
    } as GlobalEnvelope
    const sequence: string[] = []

    await consumeGlobalEventStream({
      stream: (async function* () {
        yield connected
        yield idle
      })(),
      signal: new AbortController().signal,
      onConnected: () => sequence.push("ready"),
      onEnvelope: (envelope) => sequence.push(envelope.payload.type),
    })

    expect(sequence).toEqual(["ready", "server.connected", "session.idle"])
  })

  it("does not report a stream connected before the server has sent anything", async () => {
    // The generated client resolves `global.event()` before connecting, so a
    // stream to a server that is down fails on first read. Reporting that as
    // "connected" made every retry refetch against nothing — fatally, for a TUI
    // whose shared service another client was restarting.
    let connected = 0
    await consumeGlobalEventStream({
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("Unable to connect")),
        }),
      },
      signal: new AbortController().signal,
      onConnected: () => connected++,
      onEnvelope: () => {},
    }).catch(() => {})
    expect(connected).toBe(0)
  })

  it("mounts SDK provider children without treating subscription readiness as provider readiness", () => {
    let mounted = false
    let dispose = () => {}

    createRoot((cleanup) => {
      dispose = cleanup
      const provider = createComponent(SDKProvider, {
        url: "http://ragu.test",
        events: { subscribe: async () => () => {} },
        get children() {
          useSDK()
          mounted = true
          return null
        },
      })
      ;(provider as unknown as () => unknown)()
    })

    expect(mounted).toBe(true)
    dispose()
  })
})
