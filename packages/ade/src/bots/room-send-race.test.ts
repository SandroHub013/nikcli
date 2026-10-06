import { expect, test } from "bun:test"
import { EMPTY_LOG } from "./room"
import { createRoomRunner, memoryRoomStore, type RoomRecord } from "./room-app"

/*
 * Full review 2026-10-06, bots 9: two messages sent while a run is still stopping. Both `send`s waited for the same
 * `done`, then each started a run: the second overwrote the first in `runs`, the first could no longer be stopped,
 * and two members spoke at once, each with its own spending cap.
 */
test("two messages sent while a run stops start one run, and both messages are in the log", async () => {
  const room: RoomRecord = { id: "r", name: "s", members: ["a.md", "b.md"], log: EMPTY_LOG, needsYou: false, createdAt: 0 }
  const store = memoryRoomStore({ rooms: [room] })
  const live = new Set<string>()
  let maxLive = 0
  const pending: Array<() => void> = []
  const bot = (path: string) => ({ path, identifier: path, scope: "global" }) as never
  const runner = createRoomRunner({
    store,
    seats: async (r) => r.members.map((path) => ({ member: { id: path, name: path }, bot: bot(path), pay: "plan" as const })),
    turns: {
      room: (b: { path: string }) => {
        if (live.has(b.path)) return undefined
        live.add(b.path)
        maxLive = Math.max(maxLive, live.size)
        let done!: (value: unknown) => void
        const result = new Promise<unknown>((resolve) => (done = resolve))
        const finish = () => {
          live.delete(b.path)
          done({ status: "done", text: "ciao", costUsd: 0, tokens: 0 })
        }
        pending.push(finish)
        return { result, stop: finish }
      },
      stop: () => pending.splice(0).forEach((finish) => finish()),
    } as never,
    testBuild: () => false,
  })

  void runner.send("r", "primo")
  await new Promise((resolve) => setTimeout(resolve, 10))
  // A is speaking and is slow to stop: two more messages arrive before it has.
  const slowStop = pending.splice(0)
  const second = runner.send("r", "secondo")
  const third = runner.send("r", "terzo")
  slowStop.forEach((finish) => finish())
  await new Promise((resolve) => setTimeout(resolve, 30))

  expect(maxLive).toBe(1)
  // The older of the two does not start a run of its own: the room answers the newest.
  expect(await second).toBeUndefined()
  const said = store
    .get()
    .rooms[0]!.log.entries.filter((entry) => entry.from.kind === "user")
    .map((entry) => entry.text)
  expect(said).toEqual(["primo", "secondo", "terzo"])
  // «Ferma» reaches the run that is going, whichever message started it.
  await runner.stop("r")
  pending.splice(0).forEach((finish) => finish())
  await third
  expect(runner.running("r")).toBe(false)
})
