import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "../i18n/locale"
import { it as itText } from "../i18n/it"
import { BOT_PICTURES_KEY, pastedFileName, pendingPicture, picturesOf, rememberPictures, writePictures } from "./attach"
import { forgetBotTraces, type KeyedStorage } from "./forget"
import { memoryAccountStore } from "./account"
import { volatileMemoryStore } from "./memory"
import { memoryRemoteStore } from "./gateway/remote"
import { EMPTY_BOOK, routineName, type RoutineBook } from "./routine"
import { alwaysEmptyKey, conversationText } from "./permissions-facts"
import type { AgentFile } from "./ragu"

/*
 * The second round of captures (results/bot-scatti-2.md), the fixes Master asked for on 2026-10-16. What is layout is held as
 * rules on the source, since `bots.tsx` cannot be rendered under `bun test`.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const tsx = read("bots.tsx")
const css = read("bots.css")
const thread = tsx.slice(tsx.indexOf("function Thread("), tsx.indexOf("function LastFigures"))

/** A `localStorage` of a test's own. */
function storage(): KeyedStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

describe("P1-1: a pasted picture is written only when its message goes, and goes with the bot", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const at = new Date(2026, 9, 16, 14, 5, 9).getTime()

  test("a picture is kept in the page as it came: refused at once when it is not one, or too big", () => {
    const before = localePreference()
    setLocalePreference("it")
    try {
      const kept = pendingPicture(new Blob([png], { type: "image/png" }), "schermata.png", "p1")
      expect("picture" in kept && kept.picture.name).toBe("schermata.png")
      expect(pendingPicture(new Blob(["<svg/>"], { type: "image/svg+xml" }), "x.svg", "p2")).toEqual({
        problem: itText["bots.attach.notPicture"],
      })
      const huge = { size: 50 * 1024 * 1024, type: "image/png" } as unknown as Blob
      expect(pendingPicture(huge, "grande.png", "p3")).toEqual({ problem: itText["bots.attach.tooBig"](10) })
    } finally {
      setLocalePreference(before)
    }
  })

  test("the file keeps the name it came with, made safe, then when and which", () => {
    expect(pastedFileName(at, 2, "png")).toBe("img-20261016-140509-2.png")
    expect(pastedFileName(at, 1, "png", "Schermata del 16.png")).toBe("Schermata-del-16-20261016-140509-1.png")
    expect(pastedFileName(at, 1, "jpg", "../../fuori.jpeg")).toBe("fuori-20261016-140509-1.jpg")
    expect(pastedFileName(at, 1, "png", "....png")).toBe("img-20261016-140509-1.png")
  })

  test("the pictures are written into the bot's folder when the message goes; a failure says what was written", async () => {
    const pictures = [
      { id: "a", name: "uno.png", file: new Blob([png], { type: "image/png" }) },
      { id: "b", name: "due.png", file: new Blob([png], { type: "image/png" }) },
    ]
    const writes: string[] = []
    const write = async (path: string) => (writes.push(path), null)
    const done = await writePictures({ root: "C:/p", identifier: "alfa", pictures, at, write })
    expect(done).toEqual({
      files: [
        {
          path: "C:/p/.ade/bots/alfa/uno-20261016-140509-1.png",
          relative: ".ade/bots/alfa/uno-20261016-140509-1.png",
          mime: "image/png",
        },
        {
          path: "C:/p/.ade/bots/alfa/due-20261016-140509-2.png",
          relative: ".ade/bots/alfa/due-20261016-140509-2.png",
          mime: "image/png",
        },
      ],
    })
    let calls = 0
    const second = async () => (++calls === 2 ? "disco pieno" : null)
    const failed = await writePictures({ root: "C:/p", identifier: "alfa", pictures, at, write: second })
    expect("problem" in failed && failed.written).toEqual(["C:/p/.ade/bots/alfa/uno-20261016-140509-1.png"])
  })

  test("the pictures a bot was sent are remembered by its file's path, each once", () => {
    const kept = storage()
    rememberPictures(kept, "C:/p/.ragu/agent/alfa.md", ["C:/p/.ade/bots/alfa/a.png"])
    rememberPictures(kept, "C:/p/.ragu/agent/alfa.md", ["C:/p/.ade/bots/alfa/a.png", "C:/p/.ade/bots/alfa/b.png"])
    rememberPictures(kept, "C:/p/.ragu/agent/beta.md", ["C:/p/.ade/bots/beta/c.png"])
    expect(picturesOf(kept, "C:/p/.ragu/agent/alfa.md")).toEqual([
      "C:/p/.ade/bots/alfa/a.png",
      "C:/p/.ade/bots/alfa/b.png",
    ])
    expect(picturesOf(kept, "C:/p/.ragu/agent/nessuno.md")).toEqual([])
    kept.setItem(BOT_PICTURES_KEY, "{rotto")
    expect(picturesOf(kept, "C:/p/.ragu/agent/alfa.md")).toEqual([])
  })

  test("deleting the bot takes its pictures away, and only its own", () => {
    const kept = storage()
    rememberPictures(kept, "C:/p/.ragu/agent/alfa.md", ["C:/p/.ade/bots/alfa/a.png"])
    rememberPictures(kept, "C:/p/.ragu/agent/beta.md", ["C:/p/.ade/bots/beta/c.png"])
    const removed: string[][] = []
    let routines: RoutineBook = EMPTY_BOOK
    forgetBotTraces("C:/p/.ragu/agent/alfa.md", {
      memory: volatileMemoryStore(),
      account: memoryAccountStore(),
      remote: memoryRemoteStore(),
      routines: (change) => (routines = change(routines)),
      storage: kept,
      pictures: (paths) => void removed.push([...paths]),
    })
    expect(removed).toEqual([["C:/p/.ade/bots/alfa/a.png"]])
    expect(picturesOf(kept, "C:/p/.ragu/agent/alfa.md")).toEqual([])
    expect(picturesOf(kept, "C:/p/.ragu/agent/beta.md")).toEqual(["C:/p/.ade/bots/beta/c.png"])
  })

  test("lint: paste and drop only keep the picture; it is written after the checks, and taken back when the turn does not go", () => {
    expect(thread).not.toContain("savePasted(")
    expect(thread).not.toContain("writeBytes")
    expect(thread).toContain("pendingPicture(")
    // × lets the picture go: nothing on disk to take back.
    expect(thread).toContain("setPictures((list) => list.filter((item) => item.id !== picture.id))")
    const start = tsx.slice(tsx.indexOf("const start = async"), tsx.indexOf("const answer = (bot: AgentFile"))
    const checks = start.indexOf("await admitTurn(")
    const writes = start.indexOf("await writePictures(")
    const sends = start.indexOf("turns.send(")
    expect(checks).toBeGreaterThan(-1)
    expect(checks).toBeLessThan(writes)
    expect(writes).toBeLessThan(sends)
    expect(start).toContain("prunePictures(")
    expect(start).toContain("rememberPictures(")
    // The deletion of the bot hands its pictures to the host's pruning.
    const settings = tsx.slice(tsx.indexOf("function SettingsTab("), tsx.indexOf("/* ── the form"))
    expect(settings).toContain("pictures: (recorded) =>")
  })
})

describe("P2-5: a pasted picture keeps its name and shows what it is", () => {
  test("lint: the chip has the name it came with and a 24 px thumbnail, let go with the picture", () => {
    const chip = thread.slice(thread.indexOf("<For each={pictures()}>"), thread.indexOf("<For each={attachments()}>"))
    expect(chip).toContain('<img data-slot="bots-attachment-thumb" src={thumbOf(picture)} alt="" />')
    expect(chip).toContain("{picture.name}")
    // Its URL goes when the picture leaves the composer (x, sent, another bot) and when the thread goes.
    expect(thread).toContain("URL.revokeObjectURL(")
    expect(thread).toContain("onCleanup(")
    const rule = css.slice(css.indexOf('[data-slot="bots-attachment-thumb"]'))
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/width: 24px;[\s\S]*height: 24px;[\s\S]*object-fit: cover;/)
  })
})

/** The rule for `selector` exactly as written in `bots.css`, its body only. */
const ruleOf = (selector: string) => {
  const at = css.indexOf(`${selector} {`)
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at))
}

describe("P2-1: the summary and the routine line look like what they are, things to press", () => {
  test("lint: both have the colour of a link and a sign before the words", () => {
    for (const slot of ["bots-form-summary", "bots-page-routine"]) {
      expect(ruleOf(`[data-slot="${slot}"]`)).toContain("color: var(--ade-accent);")
      expect(ruleOf(`[data-slot="${slot}"]::before`)).toMatch(/content: "[^"]+" \/ "";/)
    }
    // The summary's sign turns when «Avanzate» is open.
    expect(ruleOf('[data-slot="bots-form-summary"][aria-expanded="true"]::before')).toMatch(/content: "[^"]+" \/ "";/)
  })
})

describe("P2-2: the empty «Sempre» says what happens instead, for each program", () => {
  const bot = (runner: string, extra: Partial<AgentFile> = {}): AgentFile => ({
    identifier: "contabile",
    path: "C:/u/.ragu/agent/contabile.md",
    scope: "global",
    description: "",
    mode: "primary",
    prompt: "",
    disabledTools: [],
    runner,
    ...extra,
  })

  test("ragu asks every command, and every step outside; with no shell, every step outside", () => {
    expect(itText[alwaysEmptyKey(bot("ragu"))]).toBe(
      "Nessuno: ogni comando, e ogni passo fuori dal progetto, ti viene chiesto.",
    )
    expect(itText[alwaysEmptyKey(bot("ragu", { disabledTools: ["bash"] }))]).toBe(
      "Nessuno: ogni passo fuori dal progetto ti viene chiesto.",
    )
  })

  test("Claude Code keeps a refused command refused until «Sempre per questo bot»; with no commands, there is none to give", () => {
    expect(itText[alwaysEmptyKey(bot("claude"))]).toBe(
      "Nessuno: un comando rifiutato resta rifiutato finché non scegli «Sempre per questo bot» nel thread.",
    )
    for (const one of [bot("claude", { scope: "project" }), bot("claude", { disabledTools: ["bash"] })]) {
      expect(itText[alwaysEmptyKey(one)]).toBe("Nessuno: non esegue comandi, quindi non c'è niente da concedere.")
      // The same bot the Conversation says runs no commands.
      expect(conversationText(one).key).toBe("bots.permissions.panelTextClaudeNoShell")
    }
  })

  test("lint: the tab says it, not the one text for all", () => {
    expect(read("permissions-panel.tsx")).toContain("t(alwaysEmptyKey(props.bot))")
    expect(Object.keys(itText)).not.toContain("bots.permissions.alwaysEmpty")
  })
})

describe("P2-4: a muted bot says so in the list", () => {
  test("lint: beside the name, a crossed bell with its words, only while «Silenzia» is on", () => {
    const row = tsx.slice(tsx.indexOf('data-slot="bots-row"'), tsx.indexOf('data-slot="bots-row-end"'))
    expect(row).toContain("<Show when={noticeOf(noticeBook(), bot.path).muted === true}>")
    expect(row).toContain('data-slot="bots-row-muted"')
    expect(row).toContain('aria-label={t("bots.notice.muted")}')
    expect(row.indexOf('data-slot="bots-row-name"')).toBeLessThan(row.indexOf('data-slot="bots-row-muted"'))
    expect(itText["bots.notice.muted"]).toBe("Silenziato: le sue risposte non accendono il punto")
    expect(ruleOf('[data-slot="bots-row-title"]')).toContain("display: flex;")
    expect(ruleOf('[data-slot="bots-row-muted"]')).toContain("flex: none;")
  })
})

describe("P2-6: the face's help stays closed in the short form", () => {
  const picker = tsx.slice(tsx.indexOf("function FacePicker("), tsx.indexOf("/* ── the conversation"))

  test("lint: the upload help is the button's tip, and shows as words only after a problem or outside the short form", () => {
    expect(picker).toContain('data-face="upload"\n            title={t("bots.face.uploadHint")}')
    expect(picker).toContain("<Show when={!props.compact || problem()}>")
    // «Forma e colore vengono dal nome…» only where there is room for it.
    expect(picker).toContain("<Show when={!props.compact || props.value}>")
  })

  test("lint: the short form asks for it, the bot's settings do not", () => {
    const form = tsx.slice(tsx.indexOf("function BotForm("), tsx.indexOf("/* ── the settings, in the card"))
    expect(form).toContain('<FacePicker identifier={name() || "?"} value={avatar()} onChange={setAvatar} compact />')
    expect(tsx).toContain("<FacePicker identifier={props.bot.identifier} value={avatar()} onChange={setAvatar} />")
  })
})

describe("P2-7: a routine's name is never cut in the middle of a word", () => {
  test("cut at the last whole word, with «…» and no space before it", () => {
    const prompt = "Riassumi le pull request aperte (routine di prova, non deve andare)\nE poi altro"
    expect(routineName(prompt, 60)).toBe("Riassumi le pull request aperte (routine di prova, non deve…")
    expect(routineName("Controlla ogni mattina le dipendenze aggiornate del progetto")).toBe(
      "Controlla ogni mattina le dipendenze…",
    )
    // A comma or a bracket left at the end goes too.
    expect(routineName("Riassumi le novità, poi scrivile in una nota breve", 22)).toBe("Riassumi le novità…")
    // One word longer than the room is cut where it must be.
    expect(routineName("a".repeat(80))).toBe(`${"a".repeat(39)}…`)
    expect(routineName("Breve")).toBe("Breve")
  })

  test("lint: the removal's question names the routine as the head line does", () => {
    const panel = read("routine-panel.tsx")
    expect(panel).toContain('t("bots.routine.removeQuestion", routineName(routine.prompt, 60))')
    expect(panel).not.toContain("Array.from(routine.prompt).slice(0, 60)")
  })
})

describe("P2-8: the app's header keeps «Decisioni» whole at 800 px", () => {
  test("lint: the short label takes the place of the full one only under 800 px", () => {
    const pills = readFileSync(join(import.meta.dir, "../ui/pill-tabs.css"), "utf8")
    const narrow = pills.slice(pills.indexOf("@media (max-width: 799.98px)"))
    expect(narrow).toContain('[data-slot="ade-pill-label-full"] {\n    display: none;')
    expect(narrow).toContain('[data-slot="ade-pill-label-short"] {\n    display: inline;')
    expect(pills).not.toContain("@media (max-width: 1099.98px)")
  })
})
