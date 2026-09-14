/**
 * Which tool calls offer an undo control, and what it actually undoes.
 *
 * `session.revert` takes an optional `partID`, so the rollback can start at one
 * agent action rather than at the whole turn. What it does *not* do is roll back
 * only that action: `revert.ts` collects every `patch` part from that point on
 * and reverts them together. The control is therefore "undo from here", and
 * saying otherwise would promise something the server never offered.
 *
 * A read or a search has nothing in the working tree to undo, and a call still
 * running has no settled effect yet.
 */
const REVERTABLE_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"])

export function canRevertToolPart(input: {
  tool: string
  status: string
  /**
   * Whether a `text` or `tool` part precedes this one in the same message.
   *
   * The server decides the revert point with the same test, and when it fails it
   * drops the `partID` entirely and anchors the revert to the *user's* message
   * instead — which then deletes that message along with the rest of the turn.
   * Offering the control there would let one click remove the prompt the user
   * wrote, so the first action of a turn does not get one.
   */
  hasEarlierPartInMessage: boolean
}): boolean {
  if (input.status !== "completed") return false
  if (!input.hasEarlierPartInMessage) return false
  return REVERTABLE_TOOLS.has(input.tool)
}
