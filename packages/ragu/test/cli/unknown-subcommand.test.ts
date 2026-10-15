import { describe, expect, test } from "bun:test"
import { normalizeArgv } from "@/cli/global-flags"

/*
 * Review of the CLI, P0 2: a first word that is not a subcommand became `--project <word>`, so `ragu help`, `ragu login`
 * and `ragu modles` ended in «Failed to change directory to …\help». A word that is a folder (or looks like a path) is
 * still the project, which is how `ragu <dir>` has always been typed; any other word is left to the parser, which says
 * «Unknown subcommand» and what it may have meant.
 */
const SUBCOMMANDS = ["run", "models", "auth", "serve", "doctor"]
const folders = new Set(["C:/work/app", "proj"])
const isFolder = (p: string) => folders.has(p)

const normalize = (argv: string[]) => normalizeArgv(argv, SUBCOMMANDS, isFolder)

describe("the first word of the command line", () => {
  test("a subcommand stays a subcommand", () => {
    expect(normalize(["run", "hi"])).toEqual(["run", "hi"])
    expect(normalize([])).toEqual([])
  })

  test("a folder that exists is the project, as before", () => {
    expect(normalize(["proj"])).toEqual(["--project", "proj"])
    expect(normalize(["C:/work/app", "--model", "x/y"])).toEqual(["--project", "C:/work/app", "--model", "x/y"])
  })

  test("what looks like a path is the project too, so a wrong path says «Failed to change directory»", () => {
    for (const path of ["./nope", "../nope", "~/nope", "a/b", "a\\b", "C:\\nope", "C:/nope", ".hidden"]) {
      expect(normalize([path])).toEqual(["--project", path])
    }
  })

  test("a word that is neither is not turned into --project: the parser reports it as unknown", () => {
    for (const word of ["login", "modles", "logout", "quickstrat"]) {
      expect(normalize([word])).toEqual([word])
      expect(normalize([word, "--model", "x/y"])).toEqual([word, "--model", "x/y"])
    }
  })

  test("`ragu help` is `ragu --help`, and `ragu help run` is the help of run", () => {
    expect(normalize(["help"])).toEqual(["--help"])
    expect(normalize(["help", "run"])).toEqual(["run", "--help"])
    expect(normalize(["help", "nothing"])).toEqual(["--help"])
  })

  test("a flag first is left alone, and the log level is still lower-cased", () => {
    expect(normalize(["--model", "x/y", "--log-level", "DEBUG"])).toEqual(["--model", "x/y", "--log-level", "debug"])
  })
})
