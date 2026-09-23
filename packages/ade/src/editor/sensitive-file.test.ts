import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileIsSensitive } from "./sensitive-file"
import { RECORDING_ATTRIBUTE } from "../record/sensitive"

// Fake values only: none of these is, or was ever, a real credential.
describe("fileIsSensitive", () => {
  test("a .env is covered for its name, even empty", () => {
    expect(fileIsSensitive(".env", "")).toBe(true)
    expect(fileIsSensitive("C:\\p\\.env.local", "PORT=3000")).toBe(true)
  })

  test("the names secrets are kept under", () => {
    for (const path of ["id_rsa", "~/.ssh/id_ed25519", "server.pem", "tls.key", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "aws-credentials.json", "client_secret.json"]) {
      expect(fileIsSensitive(path, undefined)).toBe(true)
    }
    expect(fileIsSensitive("id_rsa.pub", "ssh-ed25519 AAAA")).toBe(false)
  })

  test("a config.ts with DB_PASS= is covered for what it says", () => {
    expect(fileIsSensitive("src/config.ts", 'export const port = 3000\nconst DB_PASS="hunter2hunter2"\n')).toBe(true)
  })

  test("a README is not", () => {
    expect(fileIsSensitive("README.md", "# ADE\n\nRun `npm run build`, then `git status`.\n")).toBe(false)
  })
})

describe("the pane's cover", () => {
  test("net 1 of index.css covers a pane marked data-sensitive, and what it draws", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
    const selectors = css
      .split("}")
      .map((block) => block.slice(block.includes("*/") ? block.lastIndexOf("*/") + 2 : 0, block.indexOf("{")))
      .flatMap((header) => header.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector.startsWith(`html[${RECORDING_ATTRIBUTE}] [data-sensitive]`) && !selector.includes("::"))
    expect(selectors).toContain(`html[${RECORDING_ATTRIBUTE}] [data-sensitive]`)

    const view = '<textarea></textarea><div data-slot="file-markdown"><p>x</p></div>'
    document.body.innerHTML =
      `<article data-component="file-pane"><div id="marked" data-slot="pane-editor" data-sensitive="">${view}</div></article>` +
      `<article data-component="file-pane"><div id="clean" data-slot="pane-editor">${view}</div></article>`
    const covered = (element: Element) => selectors.some((selector) => element.matches(selector))
    document.documentElement.setAttribute(RECORDING_ATTRIBUTE, "")

    const marked = document.getElementById("marked")!
    expect(covered(marked)).toBe(true)
    for (const element of Array.from(marked.querySelectorAll("*"))) expect(covered(element)).toBe(true)

    const clean = document.getElementById("clean")!
    expect(covered(clean)).toBe(false)
    for (const element of Array.from(clean.querySelectorAll("*"))) expect(covered(element)).toBe(false)

    document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
    document.body.innerHTML = ""
  })
})
