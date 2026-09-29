import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { UI } from "@/cli/ui"
import * as prompts from "@clack/prompts"
import { Installation } from "@/installation"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"
import { TERMINAL_RESET_SEQUENCE } from "@nikcli-ai/util/win32"
import { restartServiceAfterUpgrade } from "@/cli/upgrade"

export function runInstallation<A, E>(effect: Effect.Effect<A, E, Installation.Service>) {
  return runPromiseWithLayer(Installation.defaultLayer, effect)
}

export default Runtime.handler(Commands.commands["upgrade"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    target: Option.getOrUndefined(input["target"]),
    method: Option.getOrUndefined(input["method"]),
  }
  // The build being replaced may have leaked mouse reporting into the
  // terminal on exit, which turns every mouse move during the upgrade into
  // visible escape-sequence noise. Clear it before printing anything.
  if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET_SEQUENCE)
  UI.empty()
  UI.println(UI.logo("  "))
  UI.empty()
  prompts.intro("Upgrade")
  const detectedMethod = await runInstallation(
    Effect.gen(function* () {
      const installation = yield* Installation.Service
      return yield* installation.method()
    }),
  )
  // SAFETY: the builder declares `choices` for `method` with exactly the
  // `Installation.Method` members, and yargs rejects anything else before
  // the handler runs.
  const method = (args.method as Installation.Method) ?? detectedMethod
  if (method === "unknown") {
    prompts.log.error(`nikcli is installed to ${process.execPath} and may be managed by a package manager`)
    const install = await prompts.select({
      message: "Install anyways?",
      options: [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ],
      initialValue: false,
    })
    // `prompts.select` answers a cancelled prompt with `Symbol("clack:cancel")`,
    // and a symbol is truthy — so the `!install` half of this guard never fires
    // on Escape, Ctrl+C, or a non-TTY stdin, and the run falls through to
    // replacing a binary a package manager owns. EOT-18 requirement 12 is
    // explicit that a headless or cancelled prompt never silently picks "yes".
    if (prompts.isCancel(install) || !install) {
      prompts.outro("Done")
      return
    }
  }
  prompts.log.info("Using method: " + method)
  const target = args.target
    ? args.target.replace(/^v/, "")
    : await runInstallation(
        Effect.gen(function* () {
          const installation = yield* Installation.Service
          return yield* installation.latest()
        }),
      )

  if (Installation.VERSION === target) {
    prompts.log.warn(`nikcli upgrade skipped: ${target} is already installed`)
    prompts.outro("Done")
    return
  }

  prompts.log.info(`From ${Installation.VERSION} → ${target}`)
  const spinner = prompts.spinner()
  spinner.start("Upgrading...")
  const err = await runInstallation(
    Effect.gen(function* () {
      const installation = yield* Installation.Service
      return yield* installation.upgrade(method, target)
    }),
  ).catch((err) => err)
  if (err) {
    spinner.stop("Upgrade failed", 1)
    if (err instanceof Installation.UpgradeFailedError) {
      if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
        prompts.log.error("Please run the terminal as Administrator and try again")
      } else {
        prompts.log.error(err.stderr)
      }
    } else if (err instanceof Error) prompts.log.error(err.message)
    prompts.outro("Done")
    process.exit(1)
  }
  // When the Windows installer cannot put the new binary in place while this
  // command runs, it stages it and swaps it in once this process exits.
  // Saying "complete" there would be a lie until then.
  if (await Installation.upgradePending()) {
    spinner.stop("Upgrade staged")
    prompts.log.info(`nikcli ${target} will be in place once this command exits. Open a new terminal to use it.`)
    prompts.outro("Done")
    return
  }
  spinner.stop("Upgrade complete")
  // The background service is a long-lived copy of the old binary: move it
  // onto the new one now, instead of leaving it on the old engine until some
  // later client notices the version skew. Open terminals reconnect on their own.
  const restarted = await restartServiceAfterUpgrade("if-running").catch((error: unknown) => {
    prompts.log.warn(
      `Could not restart the background service: ${error instanceof Error ? error.message : String(error)}. Run \`nikcli service restart\`.`,
    )
    return undefined
  })
  if (restarted && restarted !== "pending")
    prompts.log.info(`Background service restarted on ${restarted.version || target}`)
  prompts.outro("Done")
})
