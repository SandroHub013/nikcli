import { describe, expect, test } from "bun:test"
import { Gadget } from "../src/gadget.ts"
import { readFrames } from "../src/transport.ts"
import type { Frame } from "../src/protocol.ts"

describe("Gadget.invoke", () => {
  const gadget = new Gadget({
    name: "test",
    builtins: false,
    log: () => undefined,
    commands: {
      "echo.say": {
        description: "echo",
        args: { type: "object", properties: { text: { type: "string" } } },
        maxOutputBytes: 16,
        async run({ text }: { text: string }) {
          return text
        },
      },
      "slow.wait": {
        description: "wait",
        args: { type: "object" },
        async run(_args, ctx) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000)
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new Error("aborted"))
            })
          })
          return "done"
        },
      },
    },
  })

  test("runs a command and returns its output", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c1",
      command: "echo.say",
      args: { text: "hi" },
      timeoutMs: 1000,
    })
    expect(result).toEqual({ output: "hi" })
  })

  test("truncates at the spec's maxOutputBytes and says so", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c2",
      command: "echo.say",
      args: { text: "x".repeat(40) },
      timeoutMs: 1000,
    })
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith("x".repeat(16))).toBe(true)
    expect(result.output).toMatch(/truncated at 16 bytes/)
  })

  test("aborts the handler at the deadline", async () => {
    const started = Date.now()
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c3",
      command: "slow.wait",
      args: {},
      timeoutMs: 50,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.isError).toBe(true)
    expect(result.exitCode).toBe(124)
  })

  test("an unknown command is an error result, not a throw", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c4",
      command: "nope.x",
      args: {},
      timeoutMs: 1000,
    })
    expect(result).toEqual({ output: "unknown command nope.x", isError: true })
  })

  test("the hello declares the commands and validates itself", () => {
    const hello = gadget.hello()
    expect(hello.commands.map((c) => c.name)).toEqual(["echo.say", "slow.wait"])
    expect(
      () =>
        new Gadget({
          builtins: false,
          commands: { "Bad Name": { description: "x", args: { type: "object" }, run: async () => "" } },
        }),
    ).toThrow(/commands\[0\]\.name/)
  })

  test("builtins are on by default", () => {
    const names = new Gadget({ name: "b", log: () => undefined }).hello().commands.map((c) => c.name)
    expect(names).toEqual(["system.run", "file.read", "file.write", "device.health"])
  })
})

describe("readFrames", () => {
  test("parses data lines split across chunks and skips junk", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"type":"pi',
      'ng","time":1}\n\n:comment\n\ndata: not json\n\ndata: {"type":"bye","reason":"x"}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const frames: Frame[] = []
    for await (const frame of readFrames(stream)) frames.push(frame)
    expect(frames).toEqual([
      { type: "ping", time: 1 },
      { type: "bye", reason: "x" },
    ])
  })
})

describe("fingerprint", () => {
  test("is a stable 32-hex value", async () => {
    const { fingerprint } = await import("../src/state.ts")
    expect(fingerprint()).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprint()).toBe(fingerprint())
  })
})
