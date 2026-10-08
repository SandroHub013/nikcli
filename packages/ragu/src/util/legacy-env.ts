/**
 * nikcli became ragu, and every NIKCLI_X setting became RAGU_X. A user's shell profile, a CI job or an older ADE
 * still sets the old names, so at start each NIKCLI_X is copied to RAGU_X when RAGU_X is not set. The old names
 * stay in the environment for whatever still reads them (an older nikcli started from here).
 *
 * Temporary: removed by LEGACY_ENV_UNTIL, with `legacy-env-run.ts` and its import in `index.ts`; a test fails
 * from that day until it is.
 */
export const LEGACY_ENV_UNTIL = "2026-12-01"

const OLD = "NIKCLI_"
const NEW = "RAGU_"

export function adoptLegacyEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(OLD) || value === undefined) continue
    const renamed = NEW + key.slice(OLD.length)
    if (env[renamed] === undefined) env[renamed] = value
  }
}
