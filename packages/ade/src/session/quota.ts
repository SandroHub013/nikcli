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
  let worstResetAt: string | undefined = undefined
  let maxCooldown = 0

  for (const m of quota.metrics) {
    let remaining = m.remaining
    if (remaining === undefined && m.used !== undefined && m.limit && m.limit > 0) {
      remaining = Math.max(0, Math.min(100, Math.round(100 - (m.used / m.limit) * 100)))
    }

    if (remaining !== undefined) {
      if (worstRemaining === undefined || remaining < worstRemaining) {
        worstRemaining = remaining
        worstResetAt = m.resetAt
      }
    }

    const cd = cooldownRemainingMs(m, now)
    if (cd > maxCooldown) {
      maxCooldown = cd
      worstResetAt = m.resetAt
    }
  }

  // Se la peggiore metrica è 0%, il provider è esaurito
  if (worstRemaining !== undefined && worstRemaining <= 0) {
    return {
      providerId: quota.id,
      score: 0.0,
      isAvailable: false,
      cooldownMs: maxCooldown,
      worstRemainingPct: 0,
      resetAt: worstResetAt,
      reason: "quota esaurita per la finestra corrente",
    }
  }

  const baseScore = worstRemaining !== undefined ? Math.max(0.01, worstRemaining / 100) : quota.status === "ok" ? 1.0 : 0.5

  return {
    providerId: quota.id,
    score: Math.round(baseScore * 100) / 100,
    isAvailable: true,
    cooldownMs: maxCooldown,
    worstRemainingPct: worstRemaining,
    resetAt: worstResetAt,
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
