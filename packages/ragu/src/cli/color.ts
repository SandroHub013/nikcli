import { CliOutput } from "effect/unstable/cli"

/**
 * Whether the CLI's own output (help, version, parse errors) may be coloured: a terminal, `TERM` not `dumb`, and
 * `NO_COLOR` unset or empty. The standard (no-color.org) is any non-empty value: effect's own check wanted
 * exactly `"1"`, so `NO_COLOR=true` still coloured the help.
 */
export function colorEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR) return false
  if (env.TERM === "dumb") return false
  return isTTY
}

/** The help/version/error formatter effect renders with, told whether to colour instead of guessing. */
export const outputLayer = () => CliOutput.layer(CliOutput.defaultFormatter({ colors: colorEnabled() }))
