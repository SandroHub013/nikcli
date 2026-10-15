export type QuestionHint = { keys: string; label: string }

/** The footer of a question: only the keys that do something on the tab the user is on. */
export function questionHints(state: { single: boolean; confirm: boolean; multi: boolean }): QuestionHint[] {
  const hints: QuestionHint[] = []
  if (!state.single) hints.push({ keys: "⇆ tab", label: "switch" })
  if (!state.confirm) hints.push({ keys: "↑↓", label: "select" })
  hints.push({
    keys: "enter",
    label: state.confirm ? "submit" : state.multi ? "toggle" : state.single ? "submit" : "confirm",
  })
  hints.push({ keys: "esc", label: "dismiss" })
  return hints
}
