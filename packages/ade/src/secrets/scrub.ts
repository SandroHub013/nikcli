/**
 * What an obvious API key becomes once a thread is about to be stored (B4).
 */
export const SECRET_MARK = "[nascosto]"

/**
 * Keys a tool's printout, a bot's reply or a CLI's last line can carry in
 * the clear. A command such as `env` prints them; ADE does not have the
 * values, so these shapes are what it can recognise. Long enough that
 * ordinary words are left alone.
 */
export const SECRET =
  /sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\d{8,10}:[A-Za-z0-9_-]{35}|Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/g

/** Takes those keys out of text that would otherwise be written with the thread. */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET, SECRET_MARK)
}
