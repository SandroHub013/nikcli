/**
 * nikcli's permission menu as `nikcli run` draws it on a terminal, for tests:
 * the first render of `select` from @clack/prompts, colours, bars and all
 * (`cli/handlers/run.ts`). `unicode: false` is clack's fallback when the
 * terminal cannot show its symbols.
 */
export function clackMenu(
  permission: string,
  patterns: string,
  options: { readonly unicode?: boolean; readonly always?: string; readonly eol?: string } = {},
): string {
  const unicode = options.unicode ?? true
  const [step, bar, end, active, inactive] = unicode ? ["◆", "│", "└", "●", "○"] : ["*", "|", "—", ">", " "]
  const colour = (code: number, reset: number) => (text: string) => `\u001b[${code}m${text}\u001b[${reset}m`
  const [cyan, gray, green, dim] = [colour(36, 39), colour(90, 39), colour(32, 39), colour(2, 22)]
  const eol = options.eol ?? "\r\n"
  return [
    `\u001b[?25l${gray(bar)}`,
    `${cyan(step)}  Permission required: ${permission} (${patterns})`,
    `${cyan(bar)}  ${green(active)} Allow once `,
    `${cyan(bar)}  ${dim(inactive)} ${dim(`Always allow: ${options.always ?? "x*"}`)}`,
    `${cyan(bar)}  ${dim(inactive)} ${dim("Reject")}`,
    cyan(end),
    "",
  ].join(eol)
}
