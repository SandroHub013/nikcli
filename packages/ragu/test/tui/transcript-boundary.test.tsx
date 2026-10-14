import { afterAll, describe, expect, test } from "bun:test"
import { resolveRenderLib, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Log } from "@ragu/util/log"

const [{ Harness }, { UserMessage }, { loadBuiltInTheme }, { createStandaloneTheme }, boundary, solid, { translate }] =
  await Promise.all([
    import("@ragu/tui-storybook/harness.tsx"),
    import("@tui/routes/session/parts"),
    import("@tui/context/theme-catalog"),
    import("@tui/context/theme"),
    import("@tui/routes/session/transcript-boundary"),
    import("solid-js"),
    import("@tui/context/language"),
  ])

const document = await loadBuiltInTheme("ragu")
const style = createStandaloneTheme({ document, mode: "dark" }).component("session.user-message")
const T0 = 1_700_000_000_000
const MESSAGE = translate("it", "session.transcript.failed")

/*
 * A session of some 1200 messages, with every row mounted, needs more text
 * buffers than opentui's native side will make: past ~16 thousand,
 * `createTextBuffer` fails with "Failed to create TextBuffer". The error went
 * up to the App's ErrorBoundary, which threw away the whole App, prompt
 * included, and the rows already built were never destroyed, so not even the
 * fallback could be drawn: a frozen screen with nothing on it.
 *
 * The native limit is replayed here with a budget on the same entry point, so
 * the failure happens where it happens in the app: while `<For>` builds the
 * rows of a session that arrived all at once.
 */
const lib = resolveRenderLib() as unknown as {
  createTextBuffer: (...args: unknown[]) => unknown
  destroyTextBuffer: (...args: unknown[]) => unknown
}
const nativeCreate = lib.createTextBuffer
const nativeDestroy = lib.destroyTextBuffer
let live = 0
let budget = Number.POSITIVE_INFINITY
lib.createTextBuffer = (...args: unknown[]) => {
  if (live >= budget) throw new Error("Failed to create TextBuffer")
  const buffer = nativeCreate.apply(lib, args)
  live++
  return buffer
}
lib.destroyTextBuffer = (...args: unknown[]) => {
  live--
  return nativeDestroy.apply(lib, args)
}
afterAll(() => {
  lib.createTextBuffer = nativeCreate
  lib.destroyTextBuffer = nativeDestroy
})

const logger = Log.create({ service: "tui.transcript" })
const logged: string[] = []
const logError = logger.error
logger.error = (message?: unknown, extra?: Record<string, unknown>) => {
  logged.push(`${String(message)} ${JSON.stringify(extra ?? {})}`)
}
afterAll(() => {
  logger.error = logError
})

function userTurn(i: number) {
  return {
    messageID: `msg_${String(i).padStart(5, "0")}`,
    sessionID: "storybook",
    role: "user" as const,
    createdAt: T0 + i,
    compacted: false,
    body: [
      {
        id: `e${i}`,
        sessionID: "storybook",
        messageID: `msg_${String(i).padStart(5, "0")}`,
        type: "text",
        timestamp: T0 + i,
        text: `Messaggio ${i}: leggi il file, correggi il test e dimmi cosa hai cambiato.`,
      },
    ],
  }
}

async function scene() {
  const [turns, setTurns] = solid.createSignal<ReturnType<typeof userTurn>[]>([])
  const [sessionID, setSessionID] = solid.createSignal("ses_grande")
  const view = await testRender(
    () => (
      // The App's own boundary, as in app.tsx: what the error reached before.
      <solid.ErrorBoundary fallback={() => <text>APP CADUTA</text>}>
        <Harness document={document} mode="dark" width={100} height={30}>
          <box flexDirection="column" width={100} height={30}>
            <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
              <boundary.TranscriptBoundary
                sessionID={sessionID()}
                message={MESSAGE}
                color={RGBA.fromInts(200, 200, 200, 255)}
              >
                <solid.For each={turns()}>
                  {(turn, index) => (
                    <UserMessage style={style} index={index()} onMouseUp={() => {}} turn={turn as never} />
                  )}
                </solid.For>
              </boundary.TranscriptBoundary>
            </scrollbox>
            <text>PROMPT PRONTO</text>
          </box>
        </Harness>
      </solid.ErrorBoundary>
    ),
    { width: 100, height: 30 },
  )
  await view.renderOnce()
  return { ...view, setTurns, setSessionID }
}

async function settle(view: { renderOnce: () => Promise<void> }) {
  // Orphaned rows are destroyed on the next tick, the notice is drawn after.
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(5)
    await view.renderOnce()
  }
}

describe("a transcript the native side cannot hold", () => {
  test("says so on screen, keeps the prompt, logs the error and gives the buffers back", async () => {
    const view = await scene()
    const before = live
    budget = before + 600
    logged.length = 0

    // A 1200-message session arriving at once, as sync delivers it.
    view.setTurns(Array.from({ length: 1200 }, (_, i) => userTurn(i)))
    await settle(view)

    const frame = view.captureCharFrame()
    // The rows built before the failure are destroyed, not left holding the budget.
    expect(live - before).toBeLessThan(200)
    expect(frame).not.toContain("APP CADUTA")
    expect(frame).toContain("PROMPT PRONTO")
    expect(frame.replace(/\s+/g, " ")).toContain(MESSAGE.slice(0, 40))
    expect(logged.join("\n")).toContain("Failed to create TextBuffer")
    expect(logged.join("\n")).toContain("ses_grande")

    // Another session gets a fresh try.
    budget = Number.POSITIVE_INFINITY
    view.setTurns(Array.from({ length: 3 }, (_, i) => userTurn(i)))
    view.setSessionID("ses_piccola")
    await settle(view)
    const next = view.captureCharFrame()
    expect(next).toContain("Messaggio 2")
    expect(next).toContain("PROMPT PRONTO")
    view.renderer.destroy()
  }, 60_000)

  test("draws a session that fits as if the boundary were not there", async () => {
    budget = Number.POSITIVE_INFINITY
    const view = await scene()
    view.setTurns(Array.from({ length: 5 }, (_, i) => userTurn(i)))
    await settle(view)
    const frame = view.captureCharFrame()
    expect(frame).toContain("Messaggio 4")
    expect(frame).not.toContain(MESSAGE.slice(0, 20))
    view.renderer.destroy()
  })
})
