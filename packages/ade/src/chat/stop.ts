/**
 * The chat's Stop (C4): the answer is stopped on the server, and when the
 * request does not get there — network, proxy, a server started again — the
 * person is told, since the answer goes on in front of them.
 */

import { t } from "../i18n"
import { ForeignSession, type ChatStore } from "./store"

/** Asks the server to stop `sessionID`'s answer; `onProblem` gets why it did not. */
export async function stopAnswer(
  store: Pick<ChatStore, "abort">,
  sessionID: string | undefined,
  onProblem: (message: string) => void,
): Promise<void> {
  if (!sessionID) return
  try {
    await store.abort(sessionID)
  } catch (error) {
    onProblem(error instanceof ForeignSession ? error.message : t("chat.stop.failed"))
  }
}
