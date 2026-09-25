/**
 * What the chat shows of a message, a tool call, a permission request and a
 * question (C5), as plain strings. Everything here comes from the model or
 * from the project, so it stays text: the components (`parts.tsx`) put it in
 * text nodes, never through HTML, and a long output is cut here, not by the
 * layout.
 */

import type { Part, PermissionRequest, QuestionRequest } from "@nikcli-ai/sdk/httpapi"
import { splitSegments, type Segment } from "./segments"

/** Past this a tool's output is cut, and says so. */
export const OUTPUT_LIMIT = 4000
/** Past this a line of input shown in a tool's head, or a permission's pattern, is cut. */
const LINE_LIMIT = 300

export type ToolStatus = "pending" | "running" | "completed" | "error"

export type PartView =
  | { readonly kind: "text"; readonly id: string; readonly segments: Segment[] }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly tool: string
      readonly status: ToolStatus
      /** What it was called on: the command, the file, the pattern. */
      readonly subject: string
      readonly output?: string
      readonly cut: boolean
      readonly error?: string
    }
  | { readonly kind: "file"; readonly id: string; readonly name: string }

const line = (text: string, limit = LINE_LIMIT) => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one
}

/** The input a tool call is about, in one line: what a person would say it was run on. */
function subjectOf(tool: string, input: Record<string, unknown> | undefined, title: unknown): string {
  if (typeof title === "string" && title.trim()) return line(title)
  if (!input) return ""
  for (const key of ["command", "filePath", "path", "pattern", "url", "query", "description"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return line(value)
  }
  const json = JSON.stringify(input)
  return json && json !== "{}" ? line(json) : tool
}

/** A part as the chat shows it; nothing for the parts that are bookkeeping (steps, snapshots, patches). */
export function partView(part: Part): PartView | undefined {
  const raw = part as unknown as Record<string, any>
  switch (raw.type) {
    case "text":
      if (raw.synthetic || raw.ignored || typeof raw.text !== "string" || !raw.text) return undefined
      return { kind: "text", id: raw.id, segments: splitSegments(raw.text) }
    case "reasoning":
      if (typeof raw.text !== "string" || !raw.text.trim()) return undefined
      return { kind: "reasoning", id: raw.id, text: raw.text.trimEnd() }
    case "tool": {
      const state = (raw.state ?? {}) as Record<string, any>
      const status: ToolStatus = ["pending", "running", "completed", "error"].includes(state.status) ? state.status : "pending"
      const output = typeof state.output === "string" ? state.output : undefined
      const cut = output !== undefined && output.length > OUTPUT_LIMIT
      return {
        kind: "tool",
        id: raw.id,
        tool: String(raw.tool ?? "?"),
        status,
        subject: subjectOf(String(raw.tool ?? ""), state.input, state.title),
        ...(output !== undefined ? { output: cut ? output.slice(0, OUTPUT_LIMIT) : output } : {}),
        cut,
        ...(typeof state.error === "string" ? { error: line(state.error, OUTPUT_LIMIT) } : {}),
      }
    }
    case "file":
      return { kind: "file", id: raw.id, name: line(String(raw.filename ?? raw.url ?? "?")) }
    default:
      return undefined
  }
}

/** One line of a unified diff, and what it is. */
export interface DiffLine {
  readonly kind: "file" | "hunk" | "add" | "del" | "context"
  readonly text: string
}

export interface PermissionView {
  readonly id: string
  readonly permission: string
  readonly patterns: string[]
  /** The tool call that asks, when its part is loaded: which tool, and its input whole. */
  readonly call?: { readonly tool: string; readonly input: string }
  /** For an edit or a write, the change it would make. */
  readonly diff?: DiffLine[]
}

/** A call's input, whole: the value a person reads it by, or all of it. */
function inputOf(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "url"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  const json = JSON.stringify(record, null, 2)
  return json === "{}" ? "" : json
}

export function diffLines(diff: string): DiffLine[] {
  return diff
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((text): DiffLine => {
      if (/^(Index: |={3,}|\+\+\+ |--- )/.test(text)) return { kind: "file", text }
      if (text.startsWith("@@")) return { kind: "hunk", text }
      if (text.startsWith("+")) return { kind: "add", text }
      if (text.startsWith("-")) return { kind: "del", text }
      return { kind: "context", text }
    })
}

/**
 * A permission request as the card shows it: what, and on what. The patterns
 * whole, line breaks and spaces kept: for a shell command they are what the
 * user says yes to, and a tail cut off (`; curl … | sh`) would be approved unseen.
 *
 * With the parts of the message that asks (C4), also the call itself, found by
 * its `callID`, and the diff an edit or a write puts in the request's metadata:
 * for those the pattern is only the file's name.
 */
export function permissionView(request: PermissionRequest, parts: readonly Part[] = []): PermissionView {
  const raw = request as unknown as Record<string, any>
  const patterns = Array.isArray(raw.patterns) ? raw.patterns.filter((p: unknown): p is string => typeof p === "string") : []
  const callID = raw.tool?.callID
  const part = callID
    ? (parts.find((item) => {
        const candidate = item as unknown as Record<string, any>
        return candidate.type === "tool" && candidate.callID === callID
      }) as unknown as Record<string, any> | undefined)
    : undefined
  const call = part ? { tool: String(part.tool ?? "?"), input: inputOf(part.state?.input) } : undefined
  const diff = typeof raw.metadata?.diff === "string" && raw.metadata.diff.trim() ? diffLines(raw.metadata.diff) : undefined
  return {
    id: raw.id,
    permission: String(raw.permission ?? "?"),
    patterns,
    ...(call ? { call } : {}),
    ...(diff ? { diff } : {}),
  }
}

/** What the user has picked so far, per question: the labels, and what they typed. */
export interface QuestionDraft {
  readonly chosen: readonly (readonly string[])[]
  readonly typed: readonly string[]
}

export function emptyDraft(request: QuestionRequest): QuestionDraft {
  return { chosen: request.questions.map(() => []), typed: request.questions.map(() => "") }
}

/** Picks `label` for question `index`: the only one, or one more with `multiple`, where picking again drops it. */
export function pick(draft: QuestionDraft, request: QuestionRequest, index: number, label: string): QuestionDraft {
  const question = request.questions[index]
  if (!question || !question.options.some((option) => option.label === label)) return draft
  const now = draft.chosen[index] ?? []
  const next = question.multiple
    ? now.includes(label)
      ? now.filter((chosen) => chosen !== label)
      : [...now, label]
    : now.includes(label)
      ? []
      : [label]
  return { ...draft, chosen: draft.chosen.map((chosen, at) => (at === index ? next : chosen)) }
}

export function type(draft: QuestionDraft, index: number, text: string): QuestionDraft {
  return { ...draft, typed: draft.typed.map((typed, at) => (at === index ? text : typed)) }
}

/** Whether question `index` lets the user type an answer (nikcli's default is yes). */
export const allowsTyping = (request: QuestionRequest, index: number) => request.questions[index]?.custom !== false

/**
 * The answers to send, one list per question: the labels picked, then what
 * was typed; nothing while a question has no answer yet.
 */
export function answersOf(draft: QuestionDraft, request: QuestionRequest): string[][] | undefined {
  const answers = request.questions.map((_, index) => {
    const typed = allowsTyping(request, index) ? (draft.typed[index] ?? "").trim() : ""
    return [...(draft.chosen[index] ?? []), ...(typed ? [typed] : [])]
  })
  return answers.every((answer) => answer.length > 0) ? answers : undefined
}
