import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@nikcli-ai/util/cli-error"
import { restoreTerminalState } from "@nikcli-ai/util/win32"

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onExit?: () => Promise<void>; onBeforeExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    let exiting = false
    // True while `/restart` has the host's backend down and this terminal is
    // being pointed at the one that replaces it. While it holds, a lost
    // connection is the restart itself, not a reason to exit.
    let restarting = false
    let summary: (() => string | undefined) | undefined

    const writeSummary = () => {
      const text = summary?.()
      if (!text) return
      process.stdout.write(text + "\n")
    }

    const exit = async (reason?: any) => {
      if (exiting) return
      exiting = true

      let exitCode = reason ? 1 : 0
      const errors = reason ? [reason] : []

      try {
        await input.onBeforeExit?.()
      } catch (error) {
        errors.push(error)
        exitCode = 1
      }

      try {
        renderer.setTerminalTitle("")
        renderer.destroy()
        if (!reason) writeSummary()
        restoreTerminalState()
      } catch (error) {
        errors.push(error)
        exitCode = 1
      }

      try {
        await input.onExit?.()
      } catch (error) {
        errors.push(error)
        exitCode = 1
      }

      for (const error of errors) {
        const formatted = FormatError(error) ?? FormatUnknownError(error)
        if (formatted) {
          process.stderr.write(formatted + "\n")
        }
      }

      process.exit(exitCode)
    }

    return {
      exit,
      beginRestart() {
        restarting = true
      },
      endRestart() {
        restarting = false
      },
      restarting: () => restarting,
      setSummary(fn: (() => string | undefined) | undefined) {
        summary = fn
      },
    }
  },
})
