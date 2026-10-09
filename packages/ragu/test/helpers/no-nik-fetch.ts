/**
 * A `fetch` that fails on any of Nik's hosts (nikcli-ai.dev, nikcli.store and their subdomains) and records the
 * attempt, so a test can show that a removed service sends nothing. Every other request goes to the real fetch.
 */
export const NIK_HOST = /(?:^|\.)(?:nikcli-ai\.dev|nikcli\.store)$/i

export function guardNikFetch() {
  const real = globalThis.fetch
  const attempts: string[] = []
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (NIK_HOST.test(url.hostname)) {
      attempts.push(url.href)
      throw new Error(`request to Nik's host ${url.hostname} in a test`)
    }
    return real(input, init)
  }) as typeof fetch
  globalThis.fetch = Object.assign(guarded, { preconnect: real.preconnect })
  return {
    attempts,
    restore: () => {
      globalThis.fetch = real
    },
  }
}
