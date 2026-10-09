import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { Part } from "@ragu/sdk/httpapi"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { turnOf } from "./sessions"
import type { SessionEntry } from "./sessions"

compileSolidJsx()
const { MessageParts } = await import("./parts")
const { SessionList } = await import("./session-list")

/*
 * Full review 2026-10-06, bots 13: the chat drew a message again at every token, and the whole conversation at every
 * message. What the user had open, selected or was typing in the middle of it was lost.
 */
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ""
})
const mount = (view: () => ReturnType<typeof createComponent>) => {
  cleanup = render(view, document.body.appendChild(document.createElement("div")))
}

describe("a message's parts while it is being written", () => {
  test("a reasoning the user opened stays open, and is the same element, as its text grows", async () => {
    const [state, setState] = createStore({
      parts: [
        { id: "p1", type: "reasoning", text: "Penso a" },
        { id: "p2", type: "text", text: "Ecco:\n```ts\nconst a = 1\n```\nfine" },
      ] as unknown as Part[],
    })
    mount(() => createComponent(MessageParts, { get parts() { return state.parts } }))
    await tick()
    const details = document.querySelector<HTMLDetailsElement>('[data-slot="chat-reasoning"]')!
    const code = document.querySelector('[data-slot="chat-code"]')!
    details.open = true
    expect(details.querySelector('[data-slot="chat-reasoning-text"]')?.textContent).toBe("Penso a")

    // Tokens arrive: the same parts, with more text.
    setState("parts", 0, "text" as never, "Penso a come fare" as never)
    setState("parts", 1, "text" as never, "Ecco:\n```ts\nconst a = 1\nconst b = 2\n```\nfine" as never)
    await tick()

    expect(document.querySelector('[data-slot="chat-reasoning"]')).toBe(details)
    expect(details.open).toBe(true)
    expect(details.querySelector('[data-slot="chat-reasoning-text"]')?.textContent).toBe("Penso a come fare")
    // The code block is the same figure, with its new line.
    expect(document.querySelector('[data-slot="chat-code"]')).toBe(code)
    expect(code.querySelector("pre")?.textContent).toBe("const a = 1\nconst b = 2")
  })

  test("a segment that turns from prose to code is drawn as code", async () => {
    const [state, setState] = createStore({ parts: [{ id: "p1", type: "text", text: "uno" }] as unknown as Part[] })
    mount(() => createComponent(MessageParts, { get parts() { return state.parts } }))
    await tick()
    expect(document.querySelector('[data-slot="chat-prose"]')?.textContent).toBe("uno")
    setState("parts", 0, "text" as never, "```py\nprint(1)\n```" as never)
    await tick()
    expect(document.querySelector('[data-slot="chat-prose"]')).toBeNull()
    expect(document.querySelector('[data-slot="chat-code"] pre')?.textContent).toBe("print(1)")
  })
})

describe("a turn is known by its message", () => {
  test("its parts are read when asked: a new text reaches whoever reads them", () => {
    const [data, setData] = createStore({
      part: { m1: [{ id: "p1", type: "text", text: "a" }] } as unknown as Record<string, Part[]>,
    })
    const info = { id: "m1", role: "assistant" } as never
    const turn = turnOf(data as never, info)
    const seen: string[] = []
    createRoot(() => createEffect(() => seen.push(String((turn.parts[0] as unknown as { text: string }).text))))
    setData("part", "m1", 0, "text" as never, "ab" as never)
    expect(seen).toEqual(["a", "ab"])
    // A message with no parts yet is an empty list, not a crash.
    expect(turnOf(data as never, { id: "m2", role: "user" } as never).parts).toEqual([])
    expect(turn.info).toBe(info)
  })

  test("the conversation is drawn from the messages, not from objects made again at each event", () => {
    const source = readFileSync(join(import.meta.dir, "chat.tsx"), "utf8")
    expect(source).toContain("<For each={messages()}>{(info) => <Turn turn={turnOf(store.state.data, info)} />}</For>")
    expect(source).not.toContain("<For each={turns()}>")
  })
})

describe("the folder's sessions while one is being renamed", () => {
  const entry = (busy: boolean): SessionEntry => ({
    id: "s1",
    title: "Prima",
    updated: 1,
    busy,
    waiting: false,
    chat: true,
  })

  test("a status event does not take away the field the user is typing in", async () => {
    const [entries, setEntries] = createSignal<readonly SessionEntry[]>([entry(false)])
    mount(() =>
      createComponent(SessionList, {
        get entries() {
          return entries()
        },
        current: "s1",
        onOpen: () => {},
        onRename: async () => {},
      }),
    )
    await tick()
    document.querySelector('[data-slot="chat-session-open"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await tick()
    const input = document.querySelector<HTMLInputElement>('[data-slot="chat-session-input"]')!
    expect(input).not.toBeNull()
    input.value = "Seconda scrit"

    // The session goes busy: a new entry object for the same session.
    setEntries([entry(true)])
    await tick()

    expect(document.querySelector('[data-slot="chat-session-input"]')).toBe(input)
    expect(input.value).toBe("Seconda scrit")
  })

  test("a session that goes away takes its row, and one that arrives gets one", async () => {
    const [entries, setEntries] = createSignal<readonly SessionEntry[]>([entry(false)])
    mount(() =>
      createComponent(SessionList, {
        get entries() {
          return entries()
        },
        current: undefined,
        onOpen: () => {},
        onRename: async () => {},
      }),
    )
    await tick()
    expect(document.querySelectorAll('[data-slot="chat-session"]').length).toBe(1)
    setEntries([{ ...entry(false), id: "s2", title: "Altra" }, entry(false)])
    await tick()
    expect([...document.querySelectorAll('[data-slot="chat-session-title"]')].map((el) => el.textContent)).toEqual([
      "Altra",
      "Prima",
    ])
    setEntries([])
    await tick()
    expect(document.querySelectorAll('[data-slot="chat-session"]').length).toBe(0)
  })
})
