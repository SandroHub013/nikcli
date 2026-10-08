import { describe, expect, test } from "bun:test"
import path from "path"
import {
  appFolder,
  configFile,
  configStem,
  dotFolder,
  isDotFolder,
  preferNew,
  CONFIG_FILES,
  CONFIG_STEMS,
  DOT_FOLDERS,
} from "@ragu/util/app-folder"

const base = path.join("/tmp", "u")
const existing =
  (...paths: string[]) =>
  (p: string) =>
    paths.map((x) => path.join(base, x)).includes(p)

describe("rule B: ragu if it exists, else nikcli, never a copy", () => {
  test("a platform folder", () => {
    expect(appFolder(base, existing("ragu", "nikcli"))).toBe(path.join(base, "ragu"))
    expect(appFolder(base, existing("nikcli"))).toBe(path.join(base, "nikcli"))
    // Neither yet: the old name, so a CLI of before the rename and this one share it until `ragu migrate`.
    expect(appFolder(base, existing())).toBe(path.join(base, "nikcli"))
  })

  test("a dot folder (~/.ragu, a project's .ragu)", () => {
    expect(dotFolder(base, existing(".ragu"))).toBe(path.join(base, ".ragu"))
    expect(dotFolder(base, existing(".nikcli"))).toBe(path.join(base, ".nikcli"))
    expect(dotFolder(base, existing())).toBe(path.join(base, ".nikcli"))
  })

  test("a config file's stem: ragu.json(c) if either is there, else nikcli", () => {
    expect(configStem(base, existing("ragu.jsonc", "nikcli.json"))).toBe("ragu")
    expect(configStem(base, existing("ragu.json"))).toBe("ragu")
    expect(configStem(base, existing("nikcli.json"))).toBe("nikcli")
    expect(configStem(base, existing())).toBe("nikcli")
  })

  test("the names every guard must know, new first", () => {
    expect(CONFIG_STEMS).toEqual(["ragu", "nikcli"])
    expect(DOT_FOLDERS).toEqual([".ragu", ".nikcli"])
    expect(CONFIG_FILES).toEqual(["ragu.json", "ragu.jsonc", "nikcli.json", "nikcli.jsonc"])
  })

  test("a config file and a dot folder by rule B", () => {
    expect(configFile(base, existing("ragu.json"))).toBe(path.join(base, "ragu.json"))
    expect(configFile(base, existing())).toBe(path.join(base, "nikcli.json"))
    expect(isDotFolder(path.join(base, ".ragu"))).toBe(true)
    expect(isDotFolder(path.join(base, ".nikcli"))).toBe(true)
    expect(isDotFolder(path.join(base, ".nikcli-not"))).toBe(false)
  })

  test("found paths: the old one goes when its new sibling was found too", () => {
    const a = path.join(base, "a")
    const found = [path.join(a, ".ragu"), path.join(a, ".nikcli"), path.join(base, ".nikcli"), path.join(a, "nikcli.json")]
    expect(preferNew(found)).toEqual([path.join(a, ".ragu"), path.join(base, ".nikcli"), path.join(a, "nikcli.json")])
  })
})
