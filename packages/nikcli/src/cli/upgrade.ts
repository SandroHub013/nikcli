import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@nikcli-ai/util/flag"
import { Installation } from "@/installation"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"
import { Log } from "@nikcli-ai/util/log"
import semver from "semver"

const log = Log.create({ service: "upgrade" })

type InstallationMethod = Installation.Method

function runInstallation<A, E>(effect: Effect.Effect<A, E, Installation.Service>): Promise<A> {
  return runPromiseWithLayer(Installation.defaultLayer, effect)
}

function runConfig<A, E>(effect: Effect.Effect<A, E, Config.Service>): Promise<A> {
  return runPromiseWithLayer(Config.defaultLayer, effect)
}

/**
 * Returns true when an update dialog should be surfaced to the user.
 *
 * "current" is the version embedded in the running build (which may be
 * "local", a git short SHA, or a prerelease tag). "latest" is the version
 * published to the install method's registry, which is always a clean
 * semver string.
 *
 * Uses `semver.parse` (strict, preserves prereleases such as
 * `1.137.0-beta.1`) so git short SHAs and labels like "local" are not
 * misread. When either side cannot be parsed as semver we fall back to
 * strict string inequality so dev / CI builds still get the prompt.
 */
export function shouldNotifyUpdate(current: string, latest: string): boolean {
  if (current === latest) return false

  const parsedCurrent = (() => {
    try {
      return semver.valid(semver.parse(current))
    } catch {
      return null
    }
  })()
  const parsedLatest = (() => {
    try {
      return semver.valid(semver.parse(latest))
    } catch {
      return null
    }
  })()

  if (parsedCurrent && parsedLatest) {
    try {
      return semver.lt(parsedCurrent, parsedLatest)
    } catch {
      // fall through to strict inequality
    }
  }

  // Either side could not be parsed as semver. Treat any difference as
  // an update opportunity so dev / local / non-standard builds are still
  // surfaced to the user.
  return current !== latest
}

/**
 * What a completed update check found, or `undefined` when there is
 * nothing to offer (check disabled, registry unreachable, already current).
 */
export type UpdateAvailable = {
  version: string
  method?: InstallationMethod
  current: string
  /**
   * Install without asking: the user chose "Auto-update" (`autoupdate: true`
   * in the global config) and this build can be upgraded unattended.
   */
  auto: boolean
}

/**
 * Whether an available update may be installed without asking.
 *
 * Only on an explicit `autoupdate: true` — unset and `"notify"` keep the
 * dialog — and only for a release build whose install method is known: a
 * local or preview build would otherwise be replaced by the stable release,
 * and an undetected method would fall back to the curl installer.
 */
export function shouldAutoInstall(input: {
  autoupdate: boolean | "notify" | undefined
  method: InstallationMethod
  local: boolean
  preview: boolean
}): boolean {
  return input.autoupdate === true && input.method !== "unknown" && !input.local && !input.preview
}

/**
 * Checks for available updates and *returns* what it found, as well as
 * publishing the event other clients (desktop, mobile, SDK consumers)
 * subscribe to. The actual upgrade is triggered by the user from the
 * dialog (see upgradeNow).
 *
 * The return value is what the TUI acts on, and it has to be: since the
 * background service became the default, this runs in the *client*
 * process — the upgrade replaces the installed binary, so it cannot run
 * in the long-lived service — while the TUI's event stream comes over
 * HTTP from that service. `Bus` is per-process, so the published event
 * never crossed the gap and the dialog stopped appearing.
 */
export async function upgrade(): Promise<UpdateAvailable | undefined> {
  log.debug("Starting upgrade check")

  const config = await runConfig(
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.getGlobal()
    }),
  ).catch((error) => {
    log.warn("Failed to load config for upgrade check", { error })
    return null
  })

  if (config === null) {
    log.debug("Skipping upgrade - no config available")
    return undefined
  }

  if (config.autoupdate === false || Flag.NIKCLI_DISABLE_AUTOUPDATE) {
    log.debug("Auto-update disabled in config or env")
    return undefined
  }

  const method = await runInstallation(
    Effect.gen(function* () {
      const installation = yield* Installation.Service
      return yield* installation.method()
    }),
  ).catch((error) => {
    log.error("Failed to determine installation method", { error })
    return "unknown" as const
  })

  // Unknown install methods still get a chance to surface a hint: the
  // upgrade itself will be a no-op against the runtime, but downstream
  // the TUI can show the user what version is available and ask them
  // to update manually through their package manager.
  const latest = await runInstallation(
    Effect.gen(function* () {
      const installation = yield* Installation.Service
      return yield* installation.latest(method)
    }),
  ).catch((error) => {
    log.debug("Failed to check for latest version", { error })
    return null
  })

  if (!latest) {
    log.debug("No latest version available")
    return undefined
  }

  if (!shouldNotifyUpdate(Installation.VERSION, latest)) {
    log.debug("Already at latest version", {
      current: Installation.VERSION,
      latest,
    })
    return undefined
  }

  log.info("Update available", {
    current: Installation.VERSION,
    latest,
    method,
  })

  const available: UpdateAvailable = {
    version: latest,
    method: method === "unknown" ? undefined : method,
    current: Installation.VERSION,
    auto: shouldAutoInstall({
      autoupdate: config.autoupdate,
      method,
      local: Installation.isLocal(),
      preview: Installation.isPreview(),
    }),
  }

  // Still published for the clients that only have the event stream (desktop,
  // mobile, anything on the SDK). The TUI uses the return value instead — see
  // this function's doc for why the event alone is not enough.
  await Bus.publish(Installation.Event.UpdateAvailable, available)

  return available
}

/**
 * Performs the actual upgrade for the given method and version.
 * Called from the TUI dialog after the user confirms.
 */
export async function upgradeNow(method: InstallationMethod, version: string): Promise<void> {
  log.info("Upgrading", { method, version })

  await runInstallation(
    Effect.gen(function* () {
      const installation = yield* Installation.Service
      return yield* installation.upgrade(method, version)
    }),
  )

  log.info("Upgrade completed", { version })
  await Bus.publish(Installation.Event.Updated, { version })
}

/**
 * Remember "Auto-update": later checks install new versions without asking.
 * Written to the global config, which is what `upgrade()` reads.
 */
export async function enableAutoUpdate(): Promise<void> {
  await runConfig(
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.updateGlobal({ autoupdate: true })
    }),
  )
  log.info("auto-update enabled")
}

/**
 * Move the background service onto the version an upgrade just installed.
 *
 * The service is a long-lived copy of the old binary, so without this it keeps
 * serving the old engine until some later client notices the version skew.
 * Started from `Installation.installedExecutable()`, not from this process's
 * own path. `"pending"` when the Windows installer deferred the swap (the new
 * binary is not in place yet, so a restart would come back on the old one);
 * `undefined` for `"if-running"` when no service was running.
 */
export async function restartServiceAfterUpgrade(mode: "always" | "if-running") {
  if (await Installation.upgradePending()) return "pending" as const
  const { BackgroundService } = await import("@/service/service")
  const options = { executable: Installation.installedExecutable() }
  const registration =
    mode === "always" ? await BackgroundService.restart(options) : await BackgroundService.restartIfRunning(options)
  if (registration) log.info("background service restarted after upgrade", { version: registration.version })
  return registration
}
