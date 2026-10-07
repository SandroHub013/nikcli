/**
 * `ade-msg design proponi <cartella>`: a proposal handed over as a folder.
 *
 * An agent used to need N pages, a JSON of eight fields with rules of style,
 * and `ade-msg registro design aperta --file`, and then could only hope the
 * choice would be typed into its terminal. Now it writes `.ade/design/<k>/`:
 * `proposta.json` with the same fields as the register's `aperta`, `file` in
 * place of `preview`, and one page per variant. Rust reads and checks the
 * folder (`media.rs`, `design_proposal`); this builds the event the register
 * writer (`register-write.ts`) checks and appends, and the line the waiting
 * `ade-msg` prints once the user chooses.
 *
 * Plain `.ts`, with no I/O, so every refusal and every line is tested.
 */

import { asOneLine } from "../session/typing"
import { USER } from "./answer"
import type { AnsweredDesignEvent } from "./log"
import type { DesignProposal, DesignState } from "./state"

/** What Rust read from the folder (`media::DesignProposal`). */
export interface ReadProposal {
  readonly k: string
  /** The folder as the session's folder spells it. */
  readonly folder: string
  /** `proposta.json` as written. */
  readonly proposal: string
  /** Each variant's page, in the order of `variants`: names Rust has checked. */
  readonly files: readonly string[]
}

/** The fields of `proposta.json` that go into the `aperta` event as they are. */
const OPEN_FIELDS = ["title", "question", "why", "context", "recommend", "keeps", "spec", "order", "multi"] as const

/**
 * The register operation and its JSON for a proposal read from its folder.
 *
 * A key never seen opens it. A key answered before — a choice, or «Altro
 * giro» — gets a `riaperta` with the new pages: the new round. A key still
 * waiting for the user, or closed, is refused with what to do instead.
 */
export function proposalEvent(
  read: ReadProposal,
  state: Pick<DesignState, "proposals"> | undefined,
): { op: "aperta" | "riaperta"; text: string } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(read.proposal.replace(/^﻿/, ""))
  } catch (error) {
    return { error: `proposta.json: il json non si legge: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "proposta.json: non è un oggetto" }
  const record = raw as Record<string, unknown>
  if (record.k !== undefined && record.k !== read.k)
    return { error: `proposta.json dice k=${String(record.k)}, ma la chiave è il nome della cartella: ${read.k}` }
  const listed = Array.isArray(record.variants) ? record.variants : []
  if (listed.length !== read.files.length) return { error: "proposta.json è cambiato mentre lo leggevo: riprova" }
  const variants = listed.map((item, index) => {
    const variant = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
    return {
      name: variant.name,
      description: variant.description,
      ...(variant.changes !== undefined ? { changes: variant.changes } : {}),
      // Relative to the project, as the register keeps it; the name is the one Rust checked.
      preview: `.ade/design/${read.k}/${read.files[index]}`,
    }
  })

  const current = state?.proposals.find((proposal) => proposal.k === read.k)
  if (current?.status === "aperta")
    return {
      error: `${read.k} è già aperta e aspetta la scelta dell'utente: aspettala con ade-msg design attendi ${read.k} (per altre varianti adesso, usa un'altra cartella)`,
    }
  if (current?.status === "chiusa")
    return { error: `${read.k} è chiusa: per una proposta nuova usa un'altra cartella, con un'altra chiave` }
  // Only «Altro giro» asks for new pages: a choice already made is never reopened by proposing again.
  if (current?.status === "risposta")
    return {
      error: `${read.k} ha già una scelta: leggila con ade-msg design attendi ${read.k}, oppure usa un'altra cartella per una proposta nuova`,
    }
  if (current) {
    const reason = typeof record.reason === "string" ? record.reason : undefined
    return { op: "riaperta", text: JSON.stringify({ k: read.k, ...(reason ? { reason } : {}), variants }) }
  }
  const fields: Record<string, unknown> = { k: read.k }
  for (const name of OPEN_FIELDS) if (record[name] !== undefined) fields[name] = record[name]
  return { op: "aperta", text: JSON.stringify({ ...fields, variants }) }
}

/** The proposal as it is once `event` is in the register: what the waiting line is made of. */
export function answered(proposal: DesignProposal, event: AnsweredDesignEvent): DesignProposal {
  return {
    ...proposal,
    status: event.again ? "giro" : "risposta",
    answer: {
      ...(event.choice ? { choice: event.choice } : {}),
      ...(event.choices ? { choices: event.choices } : {}),
      ...(event.note ? { note: event.note } : {}),
      words: event.words,
      at: event.at,
      by: event.by,
      ...(event.again ? { again: true as const } : {}),
    },
  }
}

/**
 * Whether the answer on `proposal` was given in ADE, by the user, and not
 * written into the register by someone else.
 *
 * Any session can append a `risposta` with `ade-msg registro design
 * risposta`, and any agent can edit `.ade/design.jsonl`: what `attendi`
 * prints as the user's choice must come from ADE's own buttons. Those
 * answers are the ones in the answers' outbox, delivered or not (an entry is
 * made only by `onAnswered`); one no longer there, because the outbox was
 * pruned, still counts when it is the user's and no pane wrote it.
 */
export function answeredInAde(
  proposal: DesignProposal,
  path: string,
  outbox: readonly { readonly path: string; readonly k: string; readonly answeredAt: string; readonly kind?: string }[],
): boolean {
  const answer = proposal.answer
  if (!answer) return false
  const queued = outbox.some(
    (item) => item.path === path && item.k === proposal.k && item.answeredAt === answer.at && item.kind !== "riaperta",
  )
  if (queued) return true
  const event = [...proposal.history].reverse().find((item) => item.type === "risposta" && item.at === answer.at)
  return answer.by === USER && event !== undefined && !event.fromPane
}

/** A field on one line, whatever the register holds: no line break or control character reaches a terminal. */
function oneLine(text: string): string {
  return asOneLine(text).replace(/\s+/g, " ").trim()
}

/**
 * What the waiting `ade-msg design` prints: the choice, or the request for
 * another round with the command that answers it. `undefined` while the
 * proposal has no answer.
 */
export function choiceLine(proposal: DesignProposal, folder: string): string | undefined {
  const answer = proposal.answer
  if (!answer) return undefined
  if (answer.again) {
    const where = /\s/.test(folder) ? `"${folder}"` : folder
    return `altro giro: ${oneLine(answer.words)}\nrifai le varianti e rilancia ade-msg design proponi ${where} --attendi`
  }
  const parts: string[] = []
  if (answer.choices) parts.push(`scelte: ${answer.choices.map(oneLine).join(", ")}`)
  else if (answer.choice) parts.push(`scelta: ${oneLine(answer.choice)}`)
  // Chosen on the claude.ai page: the choice is in the page's own database.
  else if (proposal.url) parts.push(`scelta sul foglio ${proposal.url}: leggila con ArtifactData read_db`)
  if (answer.note) parts.push(`nota: ${oneLine(answer.note)}`)
  parts.push(`parole: "${oneLine(answer.words)}"`)
  return parts.join(" — ")
}
