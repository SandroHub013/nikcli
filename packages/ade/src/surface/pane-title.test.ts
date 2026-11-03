import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { defaultPaneTitle, titlesOfProject } from "./pane-title"

afterEach(() => resetLocaleForTests("it"))

describe("defaultPaneTitle", () => {
  test("names a new pane in Italian under Italian", () => {
    expect(defaultPaneTitle("agent", 1, "Claude Code", [])).toBe("Sessione 1 — Claude Code")
    expect(defaultPaneTitle("reviewer", 2, "Codex", [])).toBe("Revisione 2 — Codex")
    expect(defaultPaneTitle("shell", 3, "Terminal", [])).toBe("Terminale 3 — Terminal")
  })

  test("names a new pane in English under English", () => {
    resetLocaleForTests("en")
    expect(defaultPaneTitle("agent", 1, "Claude Code", [])).toBe("Session 1 — Claude Code")
    expect(defaultPaneTitle("reviewer", 2, "Codex", [])).toBe("Review 2 — Codex")
    expect(defaultPaneTitle("shell", 3, "Terminal", [])).toBe("Terminal 3")
  })

  test("a terminal is «Terminale 3», not «Terminale 3 — Terminale» (UX-24)", () => {
    resetLocaleForTests("it")
    expect(defaultPaneTitle("shell", 3, "Terminale", [])).toBe("Terminale 3")
  })
})

/*
 * Live test 3, FAIL 10: two Terminals were both «Sessione 1 — Terminale». The number is the slot in the launch that
 * made the pane (the form's «1.», «2.»), so every launch of one session started again at 1. A title already worn by a
 * pane is taken: the number goes up to the first free one, and the sidebar can tell the sessions apart.
 */
describe("defaultPaneTitle and the titles already in use", () => {
  test("a title nobody wears keeps the slot's own number", () => {
    expect(defaultPaneTitle("agent", 1, "Terminale", [])).toBe("Sessione 1 — Terminale")
    expect(defaultPaneTitle("agent", 2, "Claude Code", ["Sessione 1 — Claude Code"])).toBe("Sessione 2 — Claude Code")
  })

  test("a second Terminal launched alone is «Sessione 2», not «Sessione 1» again", () => {
    expect(defaultPaneTitle("agent", 1, "Terminale", ["Sessione 1 — Terminale"])).toBe("Sessione 2 — Terminale")
  })

  test("it goes up to the first free number, past gaps and past other numbers", () => {
    const taken = ["Sessione 1 — Terminale", "Sessione 2 — Terminale", "Sessione 4 — Terminale"]
    expect(defaultPaneTitle("agent", 1, "Terminale", taken)).toBe("Sessione 3 — Terminale")
  })

  test("another agent's number does not count, nor a renamed pane's", () => {
    expect(defaultPaneTitle("agent", 1, "Terminale", ["Sessione 1 — Claude Code", "fuoco1"])).toBe("Sessione 1 — Terminale")
  })

  test("a terminal slot goes up too, in its own form", () => {
    expect(defaultPaneTitle("shell", 1, "Terminale", ["Terminale 1"])).toBe("Terminale 2")
  })

  test("in English as in Italian", () => {
    resetLocaleForTests("en")
    expect(defaultPaneTitle("agent", 1, "Terminal", ["Session 1 — Terminal"])).toBe("Session 2 — Terminal")
  })
})

/*
 * Review of prova3-aspetto, decision of Master: the numbers are counted per project. The first Terminal of a new project
 * is «Sessione 1» whatever the other projects hold, and two projects do not disturb each other.
 */
describe("titlesOfProject", () => {
  const panes = [
    { title: "Sessione 1 — Terminale", workspaceId: "app", projectRoot: "C:/work/app" },
    { title: "Sessione 2 — Terminale", workspaceId: "app", projectRoot: "C:/work/app" },
    { title: "Sessione 1 — Claude Code", workspaceId: "api", projectRoot: "C:/work/api" },
    { title: "vecchia", workspaceId: "old" },
  ]

  test("only the panes of that project count", () => {
    expect(titlesOfProject(panes, { workspaceId: "api", projectRoot: "C:/work/api" })).toEqual(["Sessione 1 — Claude Code"])
    expect(titlesOfProject(panes, { workspaceId: "app", projectRoot: "C:/work/app" }).length).toBe(2)
  })

  test("the first Terminal of a project with none is «Sessione 1», though another project has one", () => {
    const owner = { workspaceId: "api", projectRoot: "C:/work/api" }
    expect(defaultPaneTitle("agent", 1, "Terminale", titlesOfProject(panes, owner))).toBe("Sessione 1 — Terminale")
  })

  test("and the next one in a project that has one goes up, without the other project's help", () => {
    const owner = { workspaceId: "app", projectRoot: "C:/work/app" }
    expect(defaultPaneTitle("agent", 1, "Terminale", titlesOfProject(panes, owner))).toBe("Sessione 3 — Terminale")
  })

  test("a pane saved before the folder was kept is of the project by name; a folder can be written two ways", () => {
    expect(titlesOfProject(panes, { workspaceId: "old" })).toEqual(["vecchia"])
    expect(titlesOfProject(panes, { workspaceId: "app", projectRoot: "c:\\work\\app" }).length).toBe(2)
  })
})
