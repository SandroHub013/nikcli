/**
 * Quota & Rate Limit Intelligence: lettura degli snapshot di llm-quota,
 * calcolo del readiness score e backoff deterministico per l'orchestrazione.
 *
 * Ispirato al design pure di `mailbox.ts` e `metrics.ts`: tutte le funzioni
 * sono pure, prive di effetti collaterali e testabili senza DOM o filesystem.
 */

import type { TokenUsage } from "./shared"

// ---------------------------------------------------------------------------
// Tipi fondamentali
// ---------------------------------------------------------------------------

export type QuotaStatus =
  | "ok"
  | "partial"
  | "rate_limited"
  | "unauthenticated"
  | "error"

export interface QuotaMetric {
  readonly label: string
  readonly used?: number
  readonly limit?: number
  readonly remaining?: number
  readonly unit?: "percent" | "requests" | "tokens"
  readonly resetAt?: string
  readonly isRateLimited?: boolean
}

export interface ProviderQuota {
  readonly id: string
  readonly name: string
  readonly status: QuotaStatus
  readonly metrics: readonly QuotaMetric[]
  readonly plan?: string
  readonly sourceUpdatedAt?: string
  readonly message?: string
}

export interface ProviderReadiness {
  readonly providerId: string
  readonly score: number // da 0.0 (inutilizzabile/bloccato) a 1.0 (piena capacità)
  readonly isAvailable: boolean
  readonly cooldownMs: number
  readonly worstRemainingPct?: number
  readonly resetAt?: string
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Calcolo di Cooldown e Readiness Score
// ---------------------------------------------------------------------------

/**
 * Millisecondi mancanti al reset di una metrica, rispetto a `now`.
 * Se `resetAt` è assente, non valido o già trascorso nel passato, ritorna 0.
 */
export function cooldownRemainingMs(metric: QuotaMetric, now: number): number {
  if (!metric.resetAt) return 0
  const resetEpoch = Date.parse(metric.resetAt)
  if (!Number.isFinite(resetEpoch)) return 0
  const diff = resetEpoch - now
  return diff > 0 ? diff : 0
}

/**
 * Calcola il punteggio di disponibilità (0.0 - 1.0) per un provider.
 *
 * Regole:
 * - Se `status` è "rate_limited", "unauthenticated" o "error" -> score 0.0.
 * - Se una qualsiasi metrica ha `remaining <= 0` o un reset futuro attivo con quota esaurita -> score 0.0.
 * - Altrimenti lo score riflette la metrica più restrittiva (minimo remaining percent / 100).
 * - Se non ci sono percentuali misurabili ma status è "ok" o "partial", assume disponibilità nominale (1.0 o 0.5).
 */
export function calculateReadiness(quota: ProviderQuota, now: number): ProviderReadiness {
  if (quota.status === "rate_limited") {
    const nextReset = quota.metrics
      .map((m) => ({ metric: m, ms: cooldownRemainingMs(m, now) }))
      .filter((item) => item.ms > 0)
      .sort((a, b) => a.ms - b.ms)[0]

    return {
      providerId: quota.id,
      score: 0.0,
      isAvailable: false,
      cooldownMs: nextReset?.ms ?? 0,
      resetAt: nextReset?.metric.resetAt,
      reason: quota.message ?? "provider bloccato da rate limit",
    }
  }

  if (quota.status === "unauthenticated" || quota.status === "error") {
    return {
      providerId: quota.id,
      score: 0.0,
      isAvailable: false,
      cooldownMs: 0,
      reason: quota.message ?? `provider non pronto (${quota.status})`,
    }
  }

  // Verifica percentuali rimanenti tra le metriche note
  let worstRemaining: number | undefined = undefined
  let bindingResetAt: string | undefined = undefined
  let exhaustedCooldown = 0
  let exhaustedResetAt: string | undefined = undefined
  let hasExhausted = false

  for (const m of quota.metrics) {
    let remaining = m.remaining
    if (typeof remaining === "number") {
      if (Number.isNaN(remaining)) {
        remaining = 0
      } else {
        remaining = Math.max(0, Math.min(100, remaining))
      }
    } else if (m.used !== undefined && m.limit && m.limit > 0) {
      const calc = Math.round(100 - (m.used / m.limit) * 100)
      remaining = Math.max(0, Math.min(100, Number.isNaN(calc) ? 0 : calc))
    }

    if (remaining !== undefined) {
      if (worstRemaining === undefined || remaining < worstRemaining) {
        worstRemaining = remaining
        bindingResetAt = m.resetAt
      }
    }

    const isExhausted = (remaining !== undefined && remaining <= 0) || m.isRateLimited
    if (isExhausted) {
      hasExhausted = true
      const cd = cooldownRemainingMs(m, now)
      if (cd > exhaustedCooldown) {
        exhaustedCooldown = cd
        exhaustedResetAt = m.resetAt
      }
    }
  }

  // Se la peggiore metrica è 0% o è esaurita/rate-limited, il provider non è disponibile
  if (hasExhausted || (worstRemaining !== undefined && worstRemaining <= 0)) {
    return {
      providerId: quota.id,
      score: 0.0,
      isAvailable: false,
      cooldownMs: exhaustedCooldown,
      worstRemainingPct: 0,
      resetAt: exhaustedResetAt ?? bindingResetAt,
      reason: "quota esaurita per la finestra corrente",
    }
  }

  const baseScore = worstRemaining !== undefined ? Math.max(0.01, Math.min(1.0, worstRemaining / 100)) : quota.status === "ok" ? 1.0 : 0.5
  const clampedScore = Math.max(0, Math.min(1.0, Math.round(baseScore * 100) / 100))

  return {
    providerId: quota.id,
    score: clampedScore,
    isAvailable: true,
    cooldownMs: 0,
    worstRemainingPct: worstRemaining,
    resetAt: bindingResetAt,
    reason: worstRemaining !== undefined ? `${worstRemaining}% di quota residua` : "disponibile (senza limite esplicito)",
  }
}

// ---------------------------------------------------------------------------
// Backoff Deterministico su resetAt
// ---------------------------------------------------------------------------

export interface BackoffPlan {
  readonly mustWait: boolean
  readonly waitMs: number
  readonly resetAt?: string
  readonly reason: string
}

/**
 * Calcola se un subagent deve attendere prima di lanciare o proseguire un task,
 * evitando cicli a vuoto o retry esponenziali casuali.
 */
export function backoffForProvider(quota: ProviderQuota, now: number): BackoffPlan {
  const readiness = calculateReadiness(quota, now)
  if (readiness.isAvailable) {
    return { mustWait: false, waitMs: 0, reason: "quota disponibile" }
  }

  if (readiness.cooldownMs > 0) {
    // Aggiunge 500ms di margine per evitare corse con l'orologio del server del provider
    const waitMs = readiness.cooldownMs + 500
    return {
      mustWait: true,
      waitMs,
      resetAt: readiness.resetAt,
      reason: `in attesa del reset (${Math.ceil(waitMs / 1000)}s)`,
    }
  }

  return {
    mustWait: true,
    waitMs: 60_000, // fallback prudente di 1 minuto se il reset non è specificato
    reason: readiness.reason,
  }
}

// ---------------------------------------------------------------------------
// Selezione Miglior Provider per Spawn (S9)
// ---------------------------------------------------------------------------

export interface BestProviderChoice {
  readonly chosen?: string
  readonly readiness?: ProviderReadiness
  readonly reason: string
}

/**
 * Seleziona il fornitore ottimale tra i candidati indicati, ordinandoli per
 * readiness score decrescente.
 */
export function selectBestProvider(
  candidateIds: readonly string[],
  quotas: Readonly<Record<string, ProviderQuota>>,
  now: number,
): BestProviderChoice {
  if (candidateIds.length === 0) {
    return { reason: "nessun candidato specificato" }
  }

  const evaluated: ProviderReadiness[] = []

  for (const id of candidateIds) {
    const quota = quotas[id]
    if (!quota) {
      // Se non abbiamo quote note ma l'agente è tra i candidati, lo trattiamo come utilizzabile
      // con punteggio neutro (0.5), senza penalizzarlo arbitrariamente.
      evaluated.push({
        providerId: id,
        score: 0.5,
        isAvailable: true,
        cooldownMs: 0,
        reason: "nessun dato quota registrato (default nominale)",
      })
      continue
    }
    evaluated.push(calculateReadiness(quota, now))
  }

  // Ordina per disponibilità (isAvailable prima), poi per score decrescente, poi per cooldown crescente
  evaluated.sort((a, b) => {
    if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return a.cooldownMs - b.cooldownMs
  })

  const best = evaluated[0]
  if (!best || !best.isAvailable) {
    return {
      chosen: undefined,
      readiness: best,
      reason: "tutti i candidati sono al momento non disponibili o esauriti",
    }
  }

  return {
    chosen: best.providerId,
    readiness: best,
    reason: `scelto ${best.providerId} (${Math.round(best.score * 100)}% readiness, ${best.reason})`,
  }
}

// ---------------------------------------------------------------------------
// Parser degli Snapshot di llm-quota (Claude, Antigravity, Codex)
// ---------------------------------------------------------------------------

/**
 * Parser per lo snapshot Claude Code scritto dal bridge di llm-quota in
 * `~/.llm-quota/official/claude.json`.
 */
export function parseClaudeSnapshot(raw: unknown): ProviderQuota {
  if (!raw || typeof raw !== "object") {
    return { id: "claude", name: "Claude Code", status: "error", metrics: [], message: "dati snapshot assenti" }
  }

  const data = (raw as Record<string, unknown>).data
  const rateLimits = data && typeof data === "object" ? (data as Record<string, unknown>).rateLimits : undefined

  if (!rateLimits || typeof rateLimits !== "object") {
    return { id: "claude", name: "Claude Code", status: "partial", metrics: [], message: "nessuna finestra rate_limits attiva" }
  }

  const limits = rateLimits as Record<string, Record<string, unknown>>
  const metrics: QuotaMetric[] = []

  if (limits.five_hour && typeof limits.five_hour === "object") {
    const fh = limits.five_hour
    const used = typeof fh.used_percentage === "number" ? Math.round(fh.used_percentage) : undefined
    const remaining = used !== undefined ? Math.max(0, 100 - used) : undefined
    const resetAt = typeof fh.resets_at === "string" ? fh.resets_at : undefined
    metrics.push({ label: "Finestra 5h", used, limit: 100, remaining, unit: "percent", resetAt })
  }

  if (limits.seven_day && typeof limits.seven_day === "object") {
    const sd = limits.seven_day
    const used = typeof sd.used_percentage === "number" ? Math.round(sd.used_percentage) : undefined
    const remaining = used !== undefined ? Math.max(0, 100 - used) : undefined
    const resetAt = typeof sd.resets_at === "string" ? sd.resets_at : undefined
    metrics.push({ label: "Finestra 7 giorni", used, limit: 100, remaining, unit: "percent", resetAt })
  }

  const isRateLimited = metrics.some((m) => (m.used ?? 0) >= 100)
  return {
    id: "claude",
    name: "Claude Code",
    status: isRateLimited ? "rate_limited" : "ok",
    metrics,
    sourceUpdatedAt: typeof (raw as Record<string, unknown>).capturedAt === "string" ? ((raw as Record<string, unknown>).capturedAt as string) : undefined,
  }
}

/**
 * Parser per lo snapshot Antigravity / Gemini scritto dal bridge di llm-quota in
 * `~/.llm-quota/official/antigravity.json`.
 */
export function parseAntigravitySnapshot(raw: unknown): ProviderQuota {
  if (!raw || typeof raw !== "object") {
    return { id: "gemini", name: "Gemini", status: "error", metrics: [], message: "dati snapshot assenti" }
  }

  const data = (raw as Record<string, unknown>).data
  const quotaMap = data && typeof data === "object" ? (data as Record<string, unknown>).quota : undefined
  const planTier = data && typeof data === "object" && typeof (data as Record<string, unknown>).planTier === "string"
    ? ((data as Record<string, unknown>).planTier as string)
    : undefined

  if (!quotaMap || typeof quotaMap !== "object") {
    return { id: "gemini", name: "Gemini", status: "partial", metrics: [], plan: planTier, message: "nessun bucket quota attivo" }
  }

  const metrics: QuotaMetric[] = []
  for (const [bucketName, bucketObj] of Object.entries(quotaMap as Record<string, unknown>)) {
    if (bucketObj && typeof bucketObj === "object") {
      const b = bucketObj as Record<string, unknown>
      const fraction = typeof b.remaining_fraction === "number" ? b.remaining_fraction : undefined
      const remaining = fraction !== undefined ? Math.max(0, Math.min(100, Math.round(fraction * 100))) : undefined
      const resetAt = typeof b.reset_time === "string" ? b.reset_time : undefined
      metrics.push({
        label: bucketName,
        remaining,
        unit: "percent",
        resetAt,
      })
    }
  }

  const isRateLimited = metrics.some((m) => m.remaining !== undefined && m.remaining <= 0)
  return {
    id: "gemini",
    name: "Gemini",
    status: isRateLimited ? "rate_limited" : "ok",
    plan: planTier,
    metrics,
    sourceUpdatedAt: typeof (raw as Record<string, unknown>).capturedAt === "string" ? ((raw as Record<string, unknown>).capturedAt as string) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Confronto tra ledger llm-quota e transcriptUsage di ADE
// ---------------------------------------------------------------------------

export interface UsageComparison {
  readonly inputDiff: number
  readonly cacheReadDiff: number
  readonly cacheWriteDiff: number
  readonly outputDiff: number
  readonly totalDiff: number
  readonly match: boolean
}

/**
 * Confronta i conteggi token tra il ledger di llm-quota e transcriptUsage di ADE.
 * Utile per validare la precisione delle letture da transcript e individuare divergenze.
 */
export function compareUsage(ledger: TokenUsage, transcript: TokenUsage): UsageComparison {
  const inputDiff = (ledger.input ?? 0) - (transcript.input ?? 0)
  const cacheReadDiff = (ledger.cacheRead ?? 0) - (transcript.cacheRead ?? 0)
  const cacheWriteDiff = (ledger.cacheWrite ?? 0) - (transcript.cacheWrite ?? 0)
  const outputDiff = (ledger.output ?? 0) - (transcript.output ?? 0)

  const ledgerTotal = (ledger.input ?? 0) + (ledger.output ?? 0)
  const transcriptTotal = (transcript.input ?? 0) + (transcript.output ?? 0)
  const totalDiff = ledgerTotal - transcriptTotal

  const match = inputDiff === 0 && cacheReadDiff === 0 && cacheWriteDiff === 0 && outputDiff === 0

  return {
    inputDiff,
    cacheReadDiff,
    cacheWriteDiff,
    outputDiff,
    totalDiff,
    match,
  }
}

// ---------------------------------------------------------------------------
// Quota View per l'Header di Sessione (S8)
// ---------------------------------------------------------------------------

export interface SessionQuotaWindow {
  readonly key: string
  readonly label: string
  readonly ratio: number
  readonly val?: string
  readonly resetText?: string
}

export interface SessionQuotaView {
  readonly providerName: string
  readonly isLimit?: boolean
  readonly remainingRatio: number
  readonly bindingKey: string
  readonly displayValue: string
  readonly countdown?: string
  readonly level: "ok" | "low" | "crit"
  readonly windows: readonly SessionQuotaWindow[]
  readonly tooltip: string
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s"
  const totalSec = Math.floor(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
  }
  return `${seconds}s`
}

export function formatSessionQuota(quota: ProviderQuota, now = Date.now()): SessionQuotaView {
  const readiness = calculateReadiness(quota, now)
  const isLimit = !readiness.isAvailable && quota.status === "rate_limited"

  const windows: SessionQuotaWindow[] = quota.metrics.map((m) => {
    let ratio = 1.0
    if (m.remaining !== undefined) {
      ratio = Math.max(0, Math.min(1.0, m.remaining / 100))
    } else if (m.used !== undefined && m.limit && m.limit > 0) {
      ratio = Math.max(0, Math.min(1.0, 1 - m.used / m.limit))
    }
    const cd = cooldownRemainingMs(m, now)
    let resetText: string | undefined
    if (cd > 0) {
      if (cd > 24 * 3600_000 && m.resetAt) {
        const d = new Date(m.resetAt)
        if (!isNaN(d.getTime())) {
          resetText = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })
        } else {
          resetText = formatCountdown(cd)
        }
      } else {
        resetText = formatCountdown(cd)
      }
    } else if (m.resetAt) {
      const d = new Date(m.resetAt)
      if (!isNaN(d.getTime())) {
        resetText = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })
      } else {
        resetText = m.resetAt
      }
    }
    return {
      key: m.label,
      label: m.label,
      ratio,
      val: m.remaining !== undefined ? `${Math.round(ratio * 100)}%` : undefined,
      resetText,
    }
  })

  // Finestra vincolante (rapporto più basso)
  const binding = windows.reduce(
    (min, w) => (w.ratio < min.ratio ? w : min),
    windows[0] ?? { key: "quota", label: "Quota", ratio: 1.0 },
  )

  const remainingRatio = binding.ratio
  const level: "ok" | "low" | "crit" = remainingRatio < 0.2 ? "crit" : remainingRatio < 0.5 ? "low" : "ok"
  const countdown = binding.resetText ?? (readiness.cooldownMs > 0 ? formatCountdown(readiness.cooldownMs) : undefined)

  const tipLines = [
    `Quota ${quota.name}`,
    ...windows.map((w) => {
      const pct = `${Math.round(w.ratio * 100)}% rimasto`
      const rst = w.resetText ? ` · reset ${w.resetText.includes("/") ? "il " + w.resetText : "tra " + w.resetText}` : ""
      return `${w.label}: ${pct}${rst}`
    }),
  ]

  return {
    providerName: quota.name,
    isLimit: isLimit || remainingRatio <= 0,
    remainingRatio,
    bindingKey: binding.key,
    displayValue: `${Math.round(remainingRatio * 100)}%`,
    countdown,
    level,
    windows,
    tooltip: tipLines.join("\n"),
  }
}

// ---------------------------------------------------------------------------
// quota-axi: la sola fonte reale per ora
// ---------------------------------------------------------------------------

/**
 * Where quota-axi leaves its last report, relative to the user's home.
 *
 * ADE reads the file rather than running `quota-axi`: the host runs git and
 * nothing else, on purpose (see `host/shell.ts`), and the report is refreshed
 * by every `quota-axi` run the user or their status line already makes.
 */
export const QUOTA_AXI_FILE = [".cache", "quota-axi", "quotas.json"] as const

/**
 * The providers whose numbers ADE takes from quota-axi.
 *
 * quota-axi knows Claude and Codex. For agy and nikcli it has nothing, and
 * until S30 chooses where their quota comes from the bar says so rather than
 * showing a number from anywhere else.
 */
export const QUOTA_AXI_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"])

/**
 * How old a report may be and still be shown as the quota.
 *
 * A five-hour window moves by whole percentage points in a few minutes of
 * work, so a figure from this morning is not the quota, it is a guess about
 * it. Past this age the bar says "n/d" and the tooltip says when the last
 * reading was.
 */
export const QUOTA_STALE_MS = 30 * 60_000

export interface QuotaSnapshot {
  /** When quota-axi wrote the report, in epoch ms. */
  readonly generatedAt?: number
  readonly providers: Readonly<Record<string, ProviderQuota & { readonly stale?: boolean }>>
}

/** What the bar shows when there is no real figure to show. */
export interface QuotaUnavailable {
  readonly unavailable: true
  readonly providerName: string
  readonly tooltip: string
}

export type SessionQuota = SessionQuotaView | QuotaUnavailable

export function isQuotaUnavailable(quota: SessionQuota | undefined): quota is QuotaUnavailable {
  return quota !== undefined && "unavailable" in quota
}

const PLAN_NAMES: Record<string, string> = { max: "Max", pro: "Pro", plus: "Plus", free: "Free", team: "Team" }

/** The plan as the provider names it, or nothing: never a plan the report did not state. */
function planName(plan: string | undefined): string | undefined {
  if (!plan) return undefined
  return PLAN_NAMES[plan.toLowerCase()] ?? plan
}

/**
 * Parser per lo snapshot emesso da quota-axi (~/.cache/quota-axi/quotas.json).
 */
export function parseQuotaAxiSnapshot(raw: unknown): ProviderQuota[] {
  return Object.values(readQuotaAxiSnapshot(raw).providers)
}

/** The report as a snapshot keyed by ADE's provider ids, with each provider's staleness. */
export function readQuotaAxiSnapshot(raw: unknown): QuotaSnapshot {
  if (!raw || typeof raw !== "object") return { providers: {} }
  const record = raw as Record<string, unknown>
  const generated = typeof record.generatedAt === "string" ? Date.parse(record.generatedAt) : Number.NaN
  const stamp = Number.isFinite(generated) ? { generatedAt: generated } : {}
  const providers: Record<string, ProviderQuota & { stale?: boolean }> = {}
  if (!Array.isArray(record.providers)) return { providers, ...stamp }

  for (const item of record.providers) {
    if (!item || typeof item !== "object") continue
    const p = item as Record<string, unknown>
    const providerId = typeof p.provider === "string" ? p.provider : ""
    if (!providerId) continue

    const label = typeof p.label === "string" ? p.label : providerId
    const plan = typeof p.plan === "string" ? p.plan : undefined
    const windowsRaw = Array.isArray(p.windows) ? p.windows : []
    const metrics: QuotaMetric[] = []

    for (const w of windowsRaw) {
      if (!w || typeof w !== "object") continue
      const win = w as Record<string, unknown>
      const id = typeof win.id === "string" ? win.id : ""
      const kind = typeof win.kind === "string" ? win.kind : ""
      const windowLabel = typeof win.label === "string" ? win.label : id

      let shortLabel = windowLabel
      if (id === "five_hour" || kind === "session") shortLabel = "5h"
      else if (id === "seven_day" || kind === "weekly") shortLabel = "sett."
      else if (id.startsWith("window:")) shortLabel = id.replace("window:", "")
      else if (windowLabel.endsWith(" window")) shortLabel = windowLabel.replace(" window", "")

      const remaining =
        typeof win.percentRemaining === "number" ? Math.max(0, Math.min(100, Math.round(win.percentRemaining))) : undefined
      const used = typeof win.percentUsed === "number" ? Math.round(win.percentUsed) : undefined
      const resetAt = typeof win.resetsAt === "string" ? win.resetsAt : undefined
      // A window with neither figure says nothing about the quota.
      if (remaining === undefined && used === undefined) continue

      metrics.push({
        label: shortLabel,
        remaining,
        used,
        limit: 100,
        unit: "percent",
        resetAt,
        isRateLimited: remaining !== undefined && remaining <= 0,
      })
    }

    const state = p.state && typeof p.state === "object" ? (p.state as Record<string, unknown>) : undefined
    const normalizedId = normalizeProviderId(providerId)
    const vendor = providerId === "claude" ? "Anthropic" : providerId === "codex" ? "OpenAI" : label
    const shownPlan = planName(plan)

    providers[normalizedId] = {
      id: normalizedId,
      name: shownPlan ? `${vendor} · ${shownPlan}` : vendor,
      status: metrics.some((m) => m.isRateLimited) ? "rate_limited" : "ok",
      plan,
      metrics,
      ...(Number.isFinite(generated) ? { sourceUpdatedAt: new Date(generated).toISOString() } : {}),
      ...(state?.stale === true ? { stale: true } : {}),
    }
  }
  return { providers, ...stamp }
}

const VENDOR_NAMES: Record<string, string> = { claude: "Anthropic", codex: "OpenAI", agy: "Google", nikcli: "nikcli" }

function clock(epoch: number): string {
  return new Date(epoch).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
}

/**
 * The quota the bar shows for a session's agent: a real reading, or "n/d".
 *
 * Every path that is not a fresh report from quota-axi for a provider it
 * covers ends in `QuotaUnavailable`. There is deliberately no fallback figure:
 * the bar exists so the user can decide whether to start more work on a
 * provider, and a plausible invented number is worse than no number for that.
 */
export function quotaForAgent(
  agentId: string | undefined,
  snapshot: QuotaSnapshot | undefined,
  now: number,
): SessionQuota | undefined {
  if (!agentId) return undefined
  const id = normalizeProviderId(agentId)
  const vendor = VENDOR_NAMES[id]
  if (!vendor) return undefined
  const unavailable = (why: string): QuotaUnavailable => ({
    unavailable: true,
    providerName: vendor,
    tooltip: `Quota ${vendor}: n/d\n${why}`,
  })

  if (!QUOTA_AXI_PROVIDERS.has(id)) return unavailable("Nessuna fonte di quota per questo agente.")
  if (!snapshot) return unavailable("Rapporto di quota-axi non trovato (~/.cache/quota-axi/quotas.json).")
  const quota = snapshot.providers[id]
  if (!quota || quota.metrics.length === 0) return unavailable("quota-axi non riporta finestre per questo provider.")
  if (quota.stale) return unavailable("quota-axi segna il dato come non aggiornato.")
  if (snapshot.generatedAt === undefined) return unavailable("Il rapporto di quota-axi non dice quando è stato scritto.")
  if (now - snapshot.generatedAt > QUOTA_STALE_MS) {
    return unavailable(`Ultima lettura ${clock(snapshot.generatedAt)}: troppo vecchia per essere la quota di adesso.`)
  }

  const view = formatSessionQuota(quota, now)
  return { ...view, tooltip: `${view.tooltip}\nLetto da quota-axi alle ${clock(snapshot.generatedAt)}` }
}

function normalizeProviderId(agent: string): string {
  const low = agent.toLowerCase()
  if (low.includes("claude") || low.includes("anthropic") || low.includes("sonnet") || low.includes("opus") || low.includes("haiku")) return "claude"
  if (low.includes("codex") || low.includes("openai") || low.includes("gpt") || low.includes("o3") || low.includes("o1")) return "codex"
  if (low.includes("agy") || low.includes("gemini") || low.includes("google")) return "agy"
  if (low.includes("nikcli") || low.includes("openrouter")) return "nikcli"
  return low
}
