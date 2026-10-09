import path from "path"
import { $ } from "bun"
import { Flag } from "@ragu/util/flag"
import { bunUtils } from "@/bun"
import { Context, Effect, Layer } from "effect"
import * as BuildVersion from "@ragu/util/version"

/**
 * How this build was installed, and its version.
 *
 * There is no update here: the release feeds and installers this module used (GitHub nikcli's releases, npm,
 * the brew tap, Chocolatey, Scoop, the install scripts on upstream's site) are upstream's, and an update from
 * them replaced this fork. The install method is still detected, for `ragu uninstall`.
 */
export namespace Installation {
  export type Method = BuildVersion.InstallMethod

  export class Service extends Context.Service<
    Service,
    {
      method(): Effect.Effect<Method, unknown>
    }
  >()("Installation.Service") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      method: () => Effect.tryPromise(() => methodImpl()),
    }),
  )

  export const defaultLayer = layer

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function isStandaloneExecutable() {
    return bunUtils.isStandaloneExecutable
  }

  async function methodImpl(): Promise<Method> {
    if (process.execPath.includes(path.join(".nikcli", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula nikcli`.throws(false).quiet().text(),
      },
      {
        name: "scoop" as const,
        command: () => $`scoop list nikcli`.throws(false).quiet().text(),
      },
      {
        name: "choco" as const,
        command: () => $`choco list --limit-output nikcli`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      const installedName =
        check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "nikcli" : "nikcli-ai"
      if (output.includes(installedName)) {
        return check.name
      }
    }

    return "unknown"
  }

  // Defined in @ragu/util/version; re-exported so existing `Installation.VERSION` callers keep working.
  export const VERSION = BuildVersion.VERSION
  export const CHANNEL = BuildVersion.CHANNEL
  export const REVISION = BuildVersion.REVISION
  export const hasRevision = BuildVersion.hasRevision
  export const USER_AGENT = `nikcli/${CHANNEL}/${VERSION}/${Flag.RAGU_CLIENT}`
}
