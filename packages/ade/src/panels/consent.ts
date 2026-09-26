/*
 * What an agent's request may do only on the user's yes (review of
 * review-alti, question 1.3).
 *
 * In a terminal nobody knows who wrote a line: an agent that shows a file
 * with «@ade …» in it still makes a panel act. The reply is inert now; the
 * action is not. So the actions that reach outside the agent's own panel ask
 * first, once per request: a take of the screen, and a web page that is not
 * the machine's own. A no, or a question that could not be put, answers
 * `negato dall'utente` and does nothing.
 */

/** The reply to a request the user refused. */
export const DENIED = "negato dall'utente"

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/**
 * Whether `url` is the machine's own: `localhost`, `127.0.0.1`, `::1`, which
 * a bare port becomes. A dev server is opened without asking; anything else
 * asks, a name that only looks local included (`localhost.example.com`).
 */
export function isLocalAddress(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}
