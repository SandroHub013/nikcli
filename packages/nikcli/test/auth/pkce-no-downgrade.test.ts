import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * EOT-12 PKCE no-downgrade regression.
 *
 * The nikcli server consumes the issuer's OAuth flow (`packages/identity`,
 * a Cloudflare Worker) which enforces PKCE S256 at `packages/identity/src/index.ts:114`:
 *
 *     if (challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
 *       return oauthError(c, "invalid_request", "PKCE S256 is required")
 *     }
 *
 * EOT-12 says: "no PKCE downgrade." This test makes sure nikcli never
 * introduces a parallel path that talks to the issuer without S256.
 *
 * Two assertions:
 *
 * 1. The nikcli server source does not import the issuer URL with
 *    `code_challenge_method=plain` (or any method other than S256).
 * 2. The identity package still enforces S256. If someone edits that line
 *    to accept `plain`, this test fails.
 *
 * The first assertion is a static grep — it does not spin up a server, and
 * it does not depend on which exact OAuth path nikcli uses (the device-code
 * flow in `account/index.ts` does not need PKCE; the legacy `plugin/codex.ts`
 * path already uses S256). What matters is that nothing *new* talks to the
 * issuer without PKCE S256.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const NIKCLI_SRC = path.join(REPO_ROOT, "packages", "nikcli", "src")
const IDENTITY_AUTH_PATH = path.join(REPO_ROOT, "packages", "identity", "src", "index.ts")

/**
 * `rg -l` semantics over the source tree, done natively.
 *
 * This deliberately does not shell out to ripgrep. Production treats it as an
 * optional accelerator (`Ripgrep.filepath` in `src/file/ripgrep.ts` returns
 * undefined and the tier is disabled when `rg` is not on PATH), so a suite
 * that requires the binary fails on a perfectly good install and would push
 * the fix into "make CI install rg" rather than "the test needs no external
 * tool".
 *
 * It also removes a silent hole: the `rg` version mapped both exit 1 (no
 * match) and exit 2 (bad pattern / unreadable path) to "no offenders", so a
 * pattern that failed to compile turned this security check into a vacuous
 * pass. Here a bad pattern throws instead.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`)
}

function grep(pattern: RegExp, dir: string, include = "*.ts"): string[] {
  const matchesInclude = globToRegExp(include)
  const offenders: string[] = []

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (matchesInclude.test(entry.name) && pattern.test(readFileSync(full, "utf8"))) offenders.push(full)
    }
  }

  walk(dir)
  return offenders
}

describe("EOT-12 PKCE no-downgrade", () => {
  it("identity server still enforces S256 PKCE on the /authorize route", () => {
    const source = readFileSync(IDENTITY_AUTH_PATH, "utf8")
    // Hard require: the issuer must reject anything but S256 with the
    // standard error message we use elsewhere. A downgrade to `plain` or
    // removing the regex check would be a security regression.
    expect(source).toMatch(/challengeMethod\s*!==\s*"S256"/)
    expect(source).toMatch(/PKCE S256 is required/)
    // The OAuth discovery document advertises only S256, not plain.
    expect(source).toMatch(/code_challenge_methods_supported.*S256/)
  })

  it("nikcli source does not pin `code_challenge_method=plain` anywhere", () => {
    // PKCE S256 only. A `plain` method anywhere in nikcli/src is a
    // downgrade we want to catch at code-review time.
    const offenders = grep(/\bcode_challenge_method\s*=\s*["']plain["']/, NIKCLI_SRC)
    expect(offenders).toEqual([])
  })

  it("nikcli source does not call the issuer /authorize without a code_challenge", () => {
    // The /authorize route requires PKCE; nikcli must never talk to it
    // without supplying the challenge.
    const offenders = grep(/code_challenge_method=["'](?!S256)/, NIKCLI_SRC)
    expect(offenders).toEqual([])
  })

  it("nikcli source does not contain the literal string `plain` for OAuth method", () => {
    // Belt-and-suspenders: even an unrelated `code_challenge_method: "plain"`
    // would be caught by this. The legacy codex path uses S256 explicitly
    // (`packages/nikcli/src/plugin/codex.ts:108-109`).
    const offenders = grep(/["']code_challenge_method["']\s*:\s*["']plain["']/, NIKCLI_SRC)
    expect(offenders).toEqual([])
  })
})
