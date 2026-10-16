/**
 * The settings form is fields over a file, and the file is the truth. When the file changes under the form — a model
 * picked from the chip of the conversation, a save — the fields follow it, but only the ones the user has not touched:
 * a persona typed and not saved stays, whatever the chip did to the model (D7). It used to put every field back, the
 * persona included, with no word.
 */

export interface FormFields {
  readonly description: string
  readonly model: string
  readonly effort: string
  readonly runner: string
  readonly objectives: string
  readonly persona: string
  /** The avatar key, or an empty string for the one the name gives. */
  readonly avatar: string
}

export const FORM_FIELDS = ["description", "model", "effort", "runner", "objectives", "persona", "avatar"] as const

/**
 * The fields after the file went from `before` to `after`: a field that still holds what the file had follows the file,
 * a field the user changed keeps what they wrote.
 */
export function syncFields(current: FormFields, before: FormFields, after: FormFields): FormFields {
  const next: Record<string, string> = {}
  for (const key of FORM_FIELDS) next[key] = current[key] === before[key] ? after[key] : current[key]
  return next as unknown as FormFields
}

export function sameFields(a: FormFields, b: FormFields): boolean {
  return FORM_FIELDS.every((key) => a[key] === b[key])
}
