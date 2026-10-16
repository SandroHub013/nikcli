import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n/locale"
import { EMPTY_BOOK, routineHeadText, routineHeadline, routineName, type Routine, type RoutineBook } from "./routine"
import { forgetBotTraces } from "./forget"
import { memoryAccountStore } from "./account"
import { volatileMemoryStore } from "./memory"
import { memoryRemoteStore } from "./gateway/remote"
import {
  forgetNotice,
  lastNewsAt,
  muteBot,
  noticeOf,
  parseNoticeBook,
  seenUpTo,
  unread,
  type NoticeBook,
} from "./notice"
import { appendMessage, emptyTalk, sendMessage, type Talk } from "./talk"
import { it as itText } from "../i18n/it"
import { en as enText } from "../i18n/en"
import {
  avatarKey,
  COLORS,
  faceOf,
  FACE_IMAGE_MAX_URL,
  parseAvatar,
  parseFaceImage,
  randomAvatar,
  SHAPES,
  sniffFaceImage,
  squareCrop,
} from "./avatar"
import { FACE_IMAGE_MAX_INPUT, loadFaceImage, type FaceImageDeps } from "./face-image"
import { readAgentFile, serializeAgentFile } from "./ragu"
import { newBotSummary } from "./page-meta"
import {
  attachPath,
  BOT_ATTACH_MAX,
  botFilesDir,
  checkedFileParts,
  pastedExtension,
  pastedFileName,
  savePasted,
  withFilePaths,
} from "./attach"
import { createBotTurns } from "./controller"
import type { Turn, TurnRequest } from "./turn"
import type { Attachment } from "../chat/attachments"

/*
 * The second page of choices (design/ade-bot-2, the user's answers of 2026-10-16). What is layout is held as rules on
 * the source, since `bots.tsx` cannot be rendered under `bun test`; what has a rule in it lives in a `.ts` and is
 * tested there.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const tsx = read("bots.tsx")
const css = read("bots.css").replace(/\/\*[\s\S]*?\*\//g, "")

describe("3. the bots' list: every bot a row alike", () => {
  test("no three large ones at the top: each bot is a row, in the order of last use", () => {
    expect(tsx).not.toContain('data-slot="bots-pinned"')
    expect(tsx).not.toContain('data-slot="bots-pin"')
    const list = tsx.slice(tsx.indexOf('<div data-slot="bots-list">'))
    expect(list).toMatch(/^<div data-slot="bots-list">\s*<For each=\{ordered\(\)\}>/)
    // The row keeps the last thing said and when.
    expect(list).toContain("lastLine(talk()")
    expect(list).toContain("formatWhen(talk().updatedAt, now())")
    expect(css).not.toContain('[data-slot="bots-pin')
  })
})

describe("4. the next routine in the bot's head", () => {
  const day = (hour: number, minute = 0, date = 16) => new Date(2026, 9, date, hour, minute).getTime()
  const routine = (id: string, fields: Partial<Routine> = {}): Routine => ({
    id,
    bot: "/p/.claude/agents/posta.md",
    prompt: "Controlla la posta",
    every: { kind: "daily", at: "18:00" },
    consent: "c",
    createdAt: day(8),
    ...fields,
  })
  const book = (routines: Routine[], logs: RoutineBook["logs"] = {}): RoutineBook => ({ ...EMPTY_BOOK, routines, logs })

  test("no routine, no line", () => {
    expect(routineHeadline(EMPTY_BOOK, "/p/.claude/agents/posta.md", day(9))).toBeUndefined()
    const other = book([routine("a", { bot: "/p/.claude/agents/altro.md" })])
    expect(routineHeadline(other, "/p/.claude/agents/posta.md", day(9))).toBeUndefined()
  })

  test("the soonest of the bot's routines, and how many it has", () => {
    const head = routineHeadline(
      book([routine("a"), routine("b", { prompt: "Fai il punto", every: { kind: "daily", at: "12:30" } })]),
      "/p/.claude/agents/posta.md",
      day(9),
    )
    expect(head?.count).toBe(2)
    expect(head?.next?.routine.id).toBe("b")
    expect(head?.next?.at).toBe(day(12, 30))
  })

  test("a paused or suspended routine is counted, never said to be next", () => {
    const head = routineHeadline(
      book([routine("a", { paused: true }), routine("b")], { b: { runs: 0, spentUsd: 0, suspended: "consenso" } }),
      "/p/.claude/agents/posta.md",
      day(9),
    )
    expect(head).toEqual({ count: 2 })
  })

  test("a routine late to run (ADE was closed at its hour) is next now, not at an hour gone by", () => {
    const head = routineHeadline(book([routine("a")]), "/p/.claude/agents/posta.md", day(19))
    expect(head?.next?.at).toBe(day(19))
  })

  test("the line in words: name, when, and how many when more than one", () => {
    const before = localePreference()
    setLocalePreference("it")
    try {
      const one = routineHeadline(book([routine("a")]), "/p/.claude/agents/posta.md", day(9))
      expect(routineHeadText(one!, day(9))).toBe("Prossima routine: «Controlla la posta», oggi alle 18:00")
      const ran = { runs: 1, spentUsd: 0, lastRunAt: day(18) }
      const two = routineHeadline(
        book([routine("a"), routine("b")], { a: ran, b: ran }),
        "/p/.claude/agents/posta.md",
        day(19),
      )
      expect(routineHeadText(two!, day(19))).toBe(
        "Prossima routine: «Controlla la posta», domani alle 18:00 · 2 routine",
      )
      expect(routineHeadText({ count: 2 }, day(9))).toBe("2 routine, tutte in pausa o sospese")
      setLocalePreference("en")
      expect(routineHeadText(one!, day(9))).toBe("Next routine: “Controlla la posta”, today at 06:00 PM")
      expect(routineHeadText(two!, day(19))).toBe(
        "Next routine: “Controlla la posta”, tomorrow at 06:00 PM · 2 routines",
      )
      expect(routineHeadText({ count: 1 }, day(9))).toBe("1 routine, paused or suspended")
    } finally {
      setLocalePreference(before)
    }
  })

  test("a long or many-line prompt is said by its first line, cut", () => {
    expect(routineName("Riassumi le novità\ne poi scrivile")).toBe("Riassumi le novità")
    const long = routineName("a".repeat(80))
    expect(long.length).toBe(40)
    expect(long.endsWith("…")).toBe(true)
  })

  test("the line sits in the head and a click opens the Routines tab", () => {
    const head = tsx.slice(tsx.indexOf("function PageHead("), tsx.indexOf("/** One tab's panel"))
    expect(head).toContain('data-slot="bots-page-routine"')
    expect(head).toContain("onClick={() => props.onRoutines?.()}")
    const page = tsx.slice(tsx.indexOf("function BotPage("))
    expect(page).toContain('tabs().includes("routines")')
    expect(page).toContain('onRoutines: () => select("routines")')
    expect(css).toContain('[data-slot="bots-page-routine"]')
  })
})

describe("6. the «unread» dot and «Silenzia»", () => {
  const bot = "C:/p/.claude/agents/news.md"
  const replied = (at: number): Talk =>
    appendMessage(sendMessage(emptyTalk(), "ciao", at - 10), { role: "bot", text: "Eccomi" }, at)
  const book = (since = 100): NoticeBook => ({ since, bots: {} })

  test("news is the last reply or failure, never the user's own words nor a tool line", () => {
    expect(lastNewsAt(emptyTalk())).toBe(0)
    expect(lastNewsAt(sendMessage(emptyTalk(), "ciao", 500))).toBe(0)
    expect(lastNewsAt(replied(600))).toBe(600)
    const tool = appendMessage(replied(600), { role: "tool", text: "read", tool: "read" }, 700)
    expect(lastNewsAt(tool)).toBe(600)
    expect(lastNewsAt(appendMessage(tool, { role: "error", text: "rete giù" }, 800))).toBe(800)
  })

  test("a reply after the last look is unread; looking at it makes it read", () => {
    expect(unread(book(), bot, replied(600))).toBe(true)
    const looked = seenUpTo(book(), bot, 600)
    expect(unread(looked, bot, replied(600))).toBe(false)
    expect(unread(looked, bot, replied(700))).toBe(true)
    // Looking never goes back in time.
    expect(seenUpTo(looked, bot, 300)).toBe(looked)
  })

  test("what was there before the dot existed is read: no row lights up on the first start", () => {
    expect(unread(book(1000), bot, replied(600))).toBe(false)
  })

  test("a muted bot never has the dot, and unmuted it has it again for what came after the last look", () => {
    const muted = muteBot(book(), bot, true)
    expect(noticeOf(muted, bot).muted).toBe(true)
    expect(unread(muted, bot, replied(600))).toBe(false)
    expect(unread(muteBot(muted, bot, false), bot, replied(600))).toBe(true)
  })

  test("what was saved is read back, and a broken entry is dropped, never half-read", () => {
    const saved = JSON.stringify({ since: 5, bots: { [bot]: { seenAt: 9, muted: true }, x: { seenAt: "no" }, y: 3 } })
    expect(parseNoticeBook(saved, 1)).toEqual({ since: 5, bots: { [bot]: { seenAt: 9, muted: true } } })
    expect(parseNoticeBook("{rotto", 42)).toEqual({ since: 42, bots: {} })
    expect(parseNoticeBook(null, 42)).toEqual({ since: 42, bots: {} })
  })

  test("deleting the bot takes its mute and its last look away", () => {
    let notices = muteBot(seenUpTo(book(), bot, 600), bot, true)
    expect(forgetNotice(notices, bot).bots[bot]).toBeUndefined()
    let routines: RoutineBook = EMPTY_BOOK
    forgetBotTraces(bot, {
      memory: volatileMemoryStore(),
      account: memoryAccountStore(),
      remote: memoryRemoteStore(),
      routines: (change) => (routines = change(routines)),
      notices: (change) => (notices = change(notices)),
    })
    expect(notices.bots[bot]).toBeUndefined()
    expect(read("forget.ts")).toContain("stores.notices?.((book) => forgetNotice(book, path))")
    expect(tsx).toContain("notices: writeNotices,")
  })

  test("the row has the dot and the name in bold while unread; looking at the bot reads it", () => {
    const list = tsx.slice(tsx.indexOf('<div data-slot="bots-list">'))
    expect(list).toContain('data-unread={isUnread() ? "true" : undefined}')
    expect(list).toContain('data-slot="bots-row-unread"')
    expect(css).toMatch(
      /\[data-slot="bots-row"\]\[data-unread="true"\] \[data-slot="bots-row-name"\] \{[^}]*font-weight: var\(--ade-weight-bold\)/,
    )
    expect(css).toContain('[data-slot="bots-row-unread"]')
    // Only the bot's page, shown, is looking at it.
    const main = tsx.slice(tsx.indexOf("export function BotsMain("))
    expect(main).toContain("seenUpTo(book, path, lastNewsAt(talkOf(path)))")
  })

  test("«Silenzia» is in the bot's settings, and says a permission request still comes through", () => {
    const settings = tsx.slice(tsx.indexOf("function SettingsTab("), tsx.indexOf("/* ── the form"))
    expect(settings).toContain('data-slot="bots-mute"')
    expect(settings).toContain("muteBot(book, props.bot.path,")
    for (const text of [itText, enText]) {
      expect(text["bots.notice.mute"].length).toBeGreaterThan(0)
      expect(text["bots.notice.unread"].length).toBeGreaterThan(0)
    }
    expect(itText["bots.notice.muteHint"]).toContain("richiesta di permesso")
    expect(enText["bots.notice.muteHint"]).toContain("permission request")
  })
})

describe("2. the face: «A caso» and «Carica un'immagine»", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
  const gif = new TextEncoder().encode("GIF89a")
  const small = "data:image/webp;base64," + "QUJD".repeat(500)

  test("«A caso» picks a shape and a colour, and the face is written down like a chosen one", () => {
    const first = randomAvatar(() => 0)
    expect(first).toEqual({ shape: SHAPES[0], color: COLORS[0] })
    const last = randomAvatar(() => 0.9999)
    expect(last).toEqual({ shape: SHAPES[SHAPES.length - 1], color: COLORS[COLORS.length - 1] })
    // Shape and colour are two draws, not one: they do not move together.
    const draws = [0.5, 0.1]
    expect(randomAvatar(() => draws.shift()!)).toEqual({
      shape: SHAPES[Math.floor(0.5 * SHAPES.length)],
      color: COLORS[Math.floor(0.1 * COLORS.length)],
    })
    expect(parseAvatar(avatarKey(randomAvatar()))).toBeDefined()
  })

  test("only a PNG or a JPG is taken, read by its first bytes and not by its name: no SVG, no GIF", () => {
    expect(sniffFaceImage(png)).toBe("png")
    expect(sniffFaceImage(jpeg)).toBe("jpeg")
    expect(sniffFaceImage(svg)).toBeUndefined()
    expect(sniffFaceImage(gif)).toBeUndefined()
    expect(sniffFaceImage(new Uint8Array())).toBeUndefined()
  })

  test("the square is cut from the middle", () => {
    expect(squareCrop(400, 300)).toEqual({ x: 50, y: 0, side: 300 })
    expect(squareCrop(300, 400)).toEqual({ x: 0, y: 50, side: 300 })
    expect(squareCrop(64, 64)).toEqual({ x: 0, y: 0, side: 64 })
  })

  test("the face in the file is a small raster image or nothing: no SVG, no script, no other address", () => {
    expect(parseFaceImage(small)).toBe(small)
    expect(parseFaceImage("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=")
    expect(parseFaceImage("data:image/jpeg;base64,/9j/4AAQ")).toBe("data:image/jpeg;base64,/9j/4AAQ")
    expect(parseFaceImage("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined()
    expect(parseFaceImage("data:text/html;base64,PGI+")).toBeUndefined()
    expect(parseFaceImage("https://example.com/a.png")).toBeUndefined()
    expect(parseFaceImage('data:image/png;base64,AAAA" onerror="x')).toBeUndefined()
    expect(parseFaceImage("data:image/webp;base64," + "A".repeat(FACE_IMAGE_MAX_URL))).toBeUndefined()
    expect(parseFaceImage("circle/blue")).toBeUndefined()
    expect(parseFaceImage(undefined)).toBeUndefined()
    // Wherever only a shape can be drawn, an image falls back to the name's.
    expect(faceOf("news", small)).toEqual(faceOf("news"))
  })

  test("the picture travels in the bot's file: written and read back the same", () => {
    const text = serializeAgentFile({ description: "notizie", mode: "all", prompt: "Sei un bot.", avatar: small })
    const bot = readAgentFile({ path: "C:/p/.ragu/agent/news.md", scope: "project", text })
    expect(bot.avatar).toBe(small)
    expect(bot.prompt).toBe("Sei un bot.")
  })

  describe("loading a picture", () => {
    const deps = (urls: (string | undefined)[], fail = false) => {
      const asked: number[] = []
      const made: FaceImageDeps = {
        decode: async () => {
          if (fail) throw new Error("rotta")
          return { width: 400, height: 300, close: () => {} }
        },
        encode: (_image, crop, side, quality) => {
          asked.push(quality)
          expect(crop).toEqual({ x: 50, y: 0, side: 300 })
          expect(side).toBe(96)
          return urls.shift()
        },
      }
      return { made, asked }
    }

    test("a PNG becomes a small square face", async () => {
      const { made } = deps([small])
      expect(await loadFaceImage(new Blob([png]), made)).toEqual({ ok: true, url: small })
    })

    test("too heavy at the first quality, it is tried once more lighter", async () => {
      const { made, asked } = deps(["data:image/webp;base64," + "A".repeat(FACE_IMAGE_MAX_URL), small])
      expect(await loadFaceImage(new Blob([jpeg]), made)).toEqual({ ok: true, url: small })
      expect(asked.length).toBe(2)
      expect(asked[1]!).toBeLessThan(asked[0]!)
    })

    test("each refusal says why, in words", async () => {
      const before = localePreference()
      setLocalePreference("it")
      try {
        const big = { size: FACE_IMAGE_MAX_INPUT + 1, slice: () => new Blob([png]) } as unknown as Blob
        expect(await loadFaceImage(big, deps([small]).made)).toEqual({
          ok: false,
          problem: itText["bots.face.problem.tooBig"](5),
        })
        expect(await loadFaceImage(new Blob([svg]), deps([small]).made)).toEqual({
          ok: false,
          problem: itText["bots.face.problem.format"],
        })
        expect(await loadFaceImage(new Blob([png]), deps([small], true).made)).toEqual({
          ok: false,
          problem: itText["bots.face.problem.unreadable"],
        })
        const heavy = "data:image/webp;base64," + "A".repeat(FACE_IMAGE_MAX_URL)
        expect(await loadFaceImage(new Blob([png]), deps([heavy, heavy]).made)).toEqual({
          ok: false,
          problem: itText["bots.face.problem.heavy"],
        })
      } finally {
        setLocalePreference(before)
      }
    })
  })

  test("the face shows the picture, without the eyes; the picker has «A caso» and «Carica»", () => {
    const face = tsx.slice(tsx.indexOf("function Face("), tsx.indexOf("function FacePicker("))
    expect(face).toContain("parseFaceImage(props.avatar)")
    expect(face).toContain('<img data-slot="bots-face-image"')
    expect(css).toMatch(
      /\[data-slot="bots-face"\]\[data-shape="image"\]::before,\s*\[data-slot="bots-face"\]\[data-shape="image"\]::after \{[^}]*display: none/,
    )
    const picker = tsx.slice(tsx.indexOf("function FacePicker("), tsx.indexOf("/* ── the conversation"))
    expect(picker).toContain('data-face="random"')
    expect(picker).toContain("props.onChange(avatarKey(randomAvatar()))")
    expect(picker).toContain('data-slot="bots-face-upload"')
    expect(picker).toContain('accept="image/png,image/jpeg"')
    expect(picker).toContain("loadFaceImage(file, browserFaceImage)")
    for (const text of [itText, enText]) {
      expect(text["bots.face.random"].length).toBeGreaterThan(0)
      expect(text["bots.face.upload"].length).toBeGreaterThan(0)
    }
    expect(itText["bots.face.uploadHint"]).toContain("PNG o JPG")
    expect(enText["bots.face.uploadHint"]).toContain("PNG or JPG")
  })
})

describe("1. a short form to make a bot", () => {
  const form = tsx.slice(tsx.indexOf("function BotForm("), tsx.indexOf("/* ── the settings, in the card"))
  const advanced = form.slice(form.indexOf('data-slot="bots-advanced"'), form.indexOf("</details>"))

  test("the summary line says program, model, cap and place, in that order, and leaves out what is not there", () => {
    expect(
      newBotSummary({
        runner: "Ragu Code",
        model: "modello predefinito",
        cap: "tetto 1 $ al giorno",
        where: "nel progetto",
      }),
    ).toBe("Ragu Code · modello predefinito · tetto 1 $ al giorno · nel progetto")
    expect(newBotSummary({ runner: "Claude Code", model: "Sonnet", where: "in tutti i progetti" })).toBe(
      "Claude Code · Sonnet · in tutti i progetti",
    )
  })

  test("outside stay the face, the name, what it is for and the summary; one name, no title besides", () => {
    const face = form.indexOf("<FacePicker")
    const name = form.indexOf('t("bots.form.name")')
    const description = form.indexOf('t("bots.form.description")')
    const summary = form.indexOf('data-slot="bots-form-summary"')
    const details = form.indexOf('data-slot="bots-advanced"')
    expect(face).toBeGreaterThan(-1)
    expect(face).toBeLessThan(name)
    expect(name).toBeLessThan(description)
    expect(description).toBeLessThan(summary)
    expect(summary).toBeLessThan(details)
    expect(form.match(/data-slot="bots-input"\s/g)?.length ?? 0).toBeGreaterThan(0)
    expect(form).not.toContain("bots.form.titleField")
  })

  test("program, model, effort, place, objectives and instructions are under «Avanzate», closed", () => {
    expect(form).toContain("const [advanced, setAdvanced] = createSignal(false)")
    expect(advanced).toContain("open={advanced()}")
    expect(advanced).toContain('t("bots.form.advanced")')
    for (const part of ["<EngineFields", 't("bots.form.where")', 't("bots.form.objectives")', 't("bots.form.persona")'])
      expect(advanced).toContain(part)
  })

  test("the cap is outside «Avanzate», so a paid model shows it by itself (choice 5 of the first page)", () => {
    const cap = form.indexOf("<NewBotCapField")
    expect(cap).toBeGreaterThan(-1)
    expect(cap).toBeLessThan(form.indexOf('data-slot="bots-advanced"'))
    expect(advanced).not.toContain("<NewBotCapField")
  })

  test("a press on the summary opens «Avanzate»", () => {
    const summary = form.slice(form.indexOf('data-slot="bots-form-summary"'))
    expect(summary.slice(0, 400)).toContain("onClick={() => setAdvanced(true)}")
    expect(summary.slice(0, 400)).toContain("aria-expanded={advanced()}")
    for (const text of [itText, enText]) {
      expect(text["bots.form.advanced"].length).toBeGreaterThan(0)
      expect(text["bots.form.summaryCap"]("1 $").length).toBeGreaterThan(0)
    }
    expect(itText["bots.form.summaryCap"]("1 $")).toBe("tetto 1 $ al giorno")
    expect(itText["bots.form.summaryProject"]).toBe("nel progetto")
  })
})

describe("5. the «+» in the composer: files and pictures for the bot", () => {
  const root = "C:/progetto"
  const file = (relative: string, mime = "text/plain"): Attachment => ({ path: `${root}/${relative}`, relative, mime })

  test("a file of the project is attached; outside it, a .env, or one too many is refused in words", () => {
    const before = localePreference()
    setLocalePreference("it")
    try {
      const one = attachPath(root, [], "C:\\progetto\\docs\\nota.md")
      expect(one).toEqual({ list: [file("docs/nota.md")] })
      // Twice the same file is once.
      expect(attachPath(root, one.list, "C:/progetto/docs/nota.md").list).toEqual(one.list)
      expect(attachPath(root, [], "C:/progetto/foto.PNG").list[0]?.mime).toBe("image/png")
      expect(attachPath(root, [], "C:/altrove/segreto.txt")).toEqual({
        list: [],
        problem: itText["bots.attach.outside"]("C:/altrove/segreto.txt"),
      })
      expect(attachPath(root, [], "C:/progetto/../altrove/x.txt").problem).toBeDefined()
      expect(attachPath(root, [], "C:/progetto/.env").problem).toBe(itText["bots.attach.env"]("C:/progetto/.env"))
      expect(attachPath(undefined, [], "C:/progetto/a.md").problem).toBe(itText["bots.attach.noProject"])
      const full = Array.from({ length: BOT_ATTACH_MAX }, (_, index) => file(`f${index}.md`))
      expect(attachPath(root, full, "C:/progetto/altro.md")).toEqual({
        list: full,
        problem: itText["bots.attach.tooMany"](BOT_ATTACH_MAX),
      })
    } finally {
      setLocalePreference(before)
    }
  })

  test("a pasted or dropped picture is kept in the bot's own folder under the project", () => {
    expect(botFilesDir(root, "revisore-pr")).toBe("C:/progetto/.ade/bots/revisore-pr")
    // A name that is not a plain file name still makes one folder, inside.
    expect(botFilesDir(root, "../fuori")).toBe("C:/progetto/.ade/bots/fuori")
    expect(pastedExtension("image/png")).toBe("png")
    expect(pastedExtension("image/jpeg")).toBe("jpg")
    expect(pastedExtension("image/svg+xml")).toBeUndefined()
    expect(pastedExtension("application/pdf")).toBeUndefined()
    expect(pastedFileName(new Date(2026, 9, 16, 14, 5, 9).getTime(), 2, "png")).toBe("img-20261016-140509-2.png")
  })

  test("saving a picture: written in the bot's folder and attached; too big, another kind, or a failed write said", async () => {
    const before = localePreference()
    setLocalePreference("it")
    try {
      const writes: string[] = []
      const write = async (path: string, bytes: Uint8Array) => {
        writes.push(`${path}:${bytes.length}`)
        return null
      }
      const at = new Date(2026, 9, 16, 14, 5, 9).getTime()
      const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })
      const saved = await savePasted({ root, identifier: "alfa", file: png, at, index: 1, write })
      expect(saved).toEqual({ file: file(".ade/bots/alfa/img-20261016-140509-1.png", "image/png") })
      expect(writes).toEqual(["C:/progetto/.ade/bots/alfa/img-20261016-140509-1.png:4"])
      const svg = new Blob(["<svg/>"], { type: "image/svg+xml" })
      expect(await savePasted({ root, identifier: "alfa", file: svg, at, index: 1, write })).toEqual({
        problem: itText["bots.attach.notPicture"],
      })
      const huge = { size: 50 * 1024 * 1024, type: "image/png" } as unknown as Blob
      expect((await savePasted({ root, identifier: "alfa", file: huge, at, index: 1, write })).problem).toBe(
        itText["bots.attach.tooBig"](10),
      )
      const failing = async () => "disco pieno"
      expect((await savePasted({ root, identifier: "alfa", file: png, at, index: 1, write: failing })).problem).toBe(
        itText["bots.attach.notSaved"]("disco pieno"),
      )
    } finally {
      setLocalePreference(before)
    }
  })

  test("Claude Code and Codex get the files by their path in the project, under the user's words", () => {
    const text = withFilePaths("guarda questi", [file("docs/nota.md"), file("img/a.png", "image/png")])
    expect(text.startsWith("guarda questi\n\n")).toBe(true)
    expect(text).toContain("- docs/nota.md")
    expect(text).toContain("- img/a.png")
    expect(withFilePaths("ciao", [])).toBe("ciao")
  })

  test("ragu gets them as file parts, each checked again, links followed, before anything is sent", async () => {
    const checked: string[] = []
    const ok = await checkedFileParts(root, [file("docs/nota.md")], async (folder, path) => {
      checked.push(`${folder}|${path}`)
      return "ok"
    })
    expect(ok).toEqual({
      parts: [{ type: "file", mime: "text/plain", url: "file:///C:/progetto/docs/nota.md", filename: "nota.md" }],
    })
    expect(checked).toEqual(["C:/progetto|C:/progetto/docs/nota.md"])
    const outside = await checkedFileParts(root, [file("docs/nota.md")], async () => "outside")
    expect("problem" in outside).toBe(true)
    const moved = { path: "C:/altrove/x.md", relative: "x.md", mime: "text/plain" }
    expect("problem" in (await checkedFileParts(root, [moved], async () => "ok"))).toBe(true)
    expect(await checkedFileParts(root, [], async () => "outside")).toEqual({ parts: [] })
  })

  describe("the turn", () => {
    const capture = () => {
      const requests: TurnRequest[] = []
      const talks: Record<string, import("./talk").Talk> = {}
      const turns = createBotTurns({
        runTurn: (request): Turn => {
          requests.push(request)
          return { result: new Promise(() => {}), stop: () => {} }
        },
        talkOf: (path) => talks[path] ?? emptyTalk(),
        update: (path, change) => void (talks[path] = change(talks[path] ?? emptyTalk())),
      })
      return { turns, requests, talks }
    }
    const botOf = (runner: string) => ({
      identifier: runner,
      path: `C:/progetto/.nikcli/agent/${runner}.md`,
      scope: "project" as const,
      description: "",
      mode: "primary" as const,
      prompt: "",
      disabledTools: [],
      runner,
    })

    test("ragu: the words as they are and the files beside them; the thread says what went", () => {
      const { turns, requests, talks } = capture()
      expect(turns.send(botOf("ragu"), "guarda", root, [file("docs/nota.md")])).toBe(true)
      expect(requests[0]?.message).toBe("guarda")
      expect(requests[0]?.attachments).toEqual([file("docs/nota.md")])
      const said = talks["C:/progetto/.nikcli/agent/ragu.md"]!.messages.at(-1)!
      expect(said.role).toBe("user")
      expect(said.text).toContain("guarda")
      expect(said.text).toContain("nota.md")
    })

    test("Claude Code and Codex: the paths in the message, no file parts", () => {
      for (const runner of ["claude", "codex"]) {
        const { turns, requests } = capture()
        turns.send(botOf(runner), "guarda", root, [file("docs/nota.md")])
        expect(requests[0]?.message).toContain("- docs/nota.md")
        expect(requests[0]?.attachments).toBeUndefined()
      }
    })
  })

  test("the composer has the «+», takes pasted and dropped files, and lists what goes with the message", () => {
    const thread = tsx.slice(
      tsx.indexOf("function Thread("),
      tsx.indexOf("function LastFigures") > 0 ? tsx.indexOf("function LastFigures") : undefined,
    )
    expect(thread).toContain('data-slot="bots-attach"')
    expect(thread).toContain("onPaste=")
    expect(thread).toContain("onDrop=")
    expect(thread).toContain('data-slot="bots-attachments"')
    expect(thread).toContain("attachPath(props.projectRoot,")
    expect(thread).toContain("savePasted(")
    expect(tsx).toContain("turns.send(verdict.bot, message, props.projectRoot, files)")
    expect(read("serve-turn.ts")).toContain("checkedFileParts(cwd, request.attachments")
    expect(css).toContain('[data-slot="bots-attach"]')
  })
})
