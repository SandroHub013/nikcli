import { describe, expect, test } from "bun:test"
import { hasLowLabel, lowLabeledExecutables } from "./integrity"

describe("hasLowLabel", () => {
  test("riconosce l'etichetta Low in italiano e in inglese", () => {
    expect(
      hasLowLabel("C:\\x BUILTIN\\Users:(F)\r\n    Etichetta obbligatoria\\Livello obbligatorio basso:(I)(OI)(CI)(NW)"),
    ).toBe(true)
    expect(hasLowLabel("C:\\x\n    Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)")).toBe(true)
  })

  test("Medium o nessuna etichetta non sono Low", () => {
    expect(hasLowLabel("    Etichetta obbligatoria\\Livello obbligatorio medio:(OI)(CI)(NW)")).toBe(false)
    expect(hasLowLabel("C:\\x BUILTIN\\Users:(F)")).toBe(false)
  })
})

describe("lowLabeledExecutables", () => {
  /* One entry as icacls prints it: the path and its first permission, then the others indented, the label among them. */
  const entry = (path: string, label?: string) =>
    [
      `${path} S-1-5-21-1-2-3-4:(I)(M)`,
      "                   NT AUTHORITY\\SYSTEM:(I)(F)",
      ...(label ? [`                   ${label}:(OI)(CI)(NW)`] : []),
      "",
    ].join("\r\n")
  const LOW_IT = "Etichetta obbligatoria\\Livello obbligatorio basso"
  const LOW_EN = "Mandatory Label\\Low Mandatory Level"
  const MEDIUM_IT = "Etichetta obbligatoria\\Livello obbligatorio medio"

  test("names the executables left Low, in Italian and in English", () => {
    const listing =
      entry("debug\\ade-test.exe", LOW_IT) +
      entry("debug\\build\\ade-desktop-2d5\\build-script-build.exe", LOW_EN) +
      "\r\nElaborazione completata per 2 file. Elaborazione non riuscita per 0 file"
    expect(lowLabeledExecutables(listing)).toEqual([
      "debug\\ade-test.exe",
      "debug\\build\\ade-desktop-2d5\\build-script-build.exe",
    ])
  })

  test("Medium, no label, and files that are not executables are not named", () => {
    const listing =
      entry("debug\\ade-test.exe", MEDIUM_IT) +
      entry("debug\\build\\x\\out.exe") +
      entry("debug\\ade_test.pdb", LOW_IT) +
      entry("debug\\build\\x\\output", LOW_IT)
    expect(lowLabeledExecutables(listing)).toEqual([])
  })

  test("a label belongs to the entry above it: an unlabelled .exe before a Low .pdb is not named", () => {
    expect(lowLabeledExecutables(entry("debug\\a.exe") + entry("debug\\a.pdb", LOW_IT))).toEqual([])
    expect(lowLabeledExecutables(entry("debug\\a.pdb", LOW_IT) + entry("debug\\b.exe", LOW_IT))).toEqual(["debug\\b.exe"])
  })

  test("a path with spaces keeps its spaces", () => {
    expect(lowLabeledExecutables(entry("C:\\My Projects\\ade test\\ade-test.exe", LOW_IT))).toEqual([
      "C:\\My Projects\\ade test\\ade-test.exe",
    ])
  })
})
