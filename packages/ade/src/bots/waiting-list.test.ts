import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { mergeApprovals, type ApprovalChoice, type ApprovalRequest } from "./approvals"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { WaitingList } = await import("./waiting-list")
const { setLocalePreference } = await import("../i18n")

setLocalePreference("it")

/* «Aspettano te» at the top of the roster (choice 4). */
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  key: "ade:1",
  bot: "C:/p/a.md",
  botName: "alfa",
  source: "ade",
  permission: "bash",
  patterns: "git push --force",
  reason: "riscrive la storia",
  askedAt: 1000,
  expiresAt: 301_000,
  choices: ["once", "always", "reject"],
  answer: () => {},
  ...over,
})

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(requests: () => ApprovalRequest[], extra: Record<string, unknown> = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(WaitingList, {
        waiting: () => mergeApprovals(requests()),
        onOpen: () => {},
        now: () => 61_000,
        ...extra,
      }),
    host,
  )
  return host
}

describe("«Aspettano te»", () => {
  test("nothing is drawn when nothing waits", () => {
    const host = mount(() => [])
    expect(host.querySelector('[data-slot="bots-waiting"]')).toBeNull()
  })

  test("each request says whose bot, what it wants, why, where from and how long is left", () => {
    const host = mount(() => [request()])
    const item = host.querySelector('[data-slot="bots-waiting-item"]')!
    expect(host.querySelector('[data-slot="bots-waiting-title"]')?.textContent).toBe("Aspettano te")
    expect(item.textContent).toContain("alfa")
    expect(item.textContent).toContain("Vuole eseguire un comando (bash): «git push --force»")
    expect(item.textContent).toContain("riscrive la storia")
    expect(item.textContent).toContain("ADE · restano 4:00")
    expect([...item.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["alfa", "Consenti", "Nega"])
  })

  test("the same request from a phone is one, with both places named", () => {
    const host = mount(() => [request(), request({ key: "tg:1", source: "telegram", choices: ["once", "reject"] })])
    expect(host.querySelectorAll('[data-slot="bots-waiting-item"]')).toHaveLength(1)
    expect(host.textContent).toContain("ADE · Telegram")
  })

  test("Consenti and Nega answer every member; the name opens the bot", () => {
    const answers: [string, ApprovalChoice][] = []
    const opened: [string, string | undefined][] = []
    const host = mount(
      () => [
        request({ answer: (choice) => void answers.push(["ade", choice]) }),
        request({ key: "tg:1", source: "telegram", choices: ["once", "reject"], answer: (choice) => void answers.push(["telegram", choice]) }),
      ],
      { onOpen: (bot: string, room?: string) => void opened.push([bot, room]) },
    )
    const press = (text: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click()
    press("alfa")
    expect(opened).toEqual([["C:/p/a.md", undefined]])
    press("Consenti")
    expect(answers).toEqual([
      ["ade", "once"],
      ["telegram", "once"],
    ])
    press("Nega")
    expect(answers.slice(2)).toEqual([
      ["ade", "reject"],
      ["telegram", "reject"],
    ])
  })

  test("a question asked in a room opens the room", () => {
    const opened: [string, string | undefined][] = []
    const host = mount(() => [request({ room: "uno" })], { onOpen: (bot: string, room?: string) => void opened.push([bot, room]) })
    ;[...host.querySelectorAll("button")].find((button) => button.textContent === "alfa")!.click()
    expect(opened).toEqual([["C:/p/a.md", "uno"]])
  })

  test("it follows the list as requests come and go", () => {
    const [list, setList] = createSignal<ApprovalRequest[]>([])
    const host = mount(list)
    expect(host.querySelector('[data-slot="bots-waiting"]')).toBeNull()
    setList([request()])
    expect(host.querySelectorAll('[data-slot="bots-waiting-item"]')).toHaveLength(1)
    setList([])
    expect(host.querySelector('[data-slot="bots-waiting"]')).toBeNull()
  })

  test("a command that cannot be allowed from here has no Consenti", () => {
    const host = mount(() => [request({ choices: ["reject"] })])
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["alfa", "Nega"])
  })
})

describe("the roster shows it", () => {
  test("lint: the list is at the top of the roster, before the bots, fed by the app's list", () => {
    const view = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    const roster = view.slice(view.indexOf("export function BotsRoster"), view.indexOf("export interface BotsMainProps"))
    expect(roster).toContain("<WaitingList waiting={waitingApprovals} onOpen={openBotByPath} />")
    expect(roster.indexOf("<WaitingList")).toBeLessThan(roster.indexOf('data-slot="bots-pinned"'))
  })
})
