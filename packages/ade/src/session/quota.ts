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

// Registro dei provider per snapshot di quota in memoria
const quotaRegistry = new Map<string, ProviderQuota>()

export function setProviderQuota(quota: ProviderQuota): void {
  quotaRegistry.set(quota.id, quota)
}

/**
 * Parser per lo snapshot emesso da quota-axi (~/.cache/quota-axi/quotas.json).
 */
export function parseQuotaAxiSnapshot(raw: unknown): ProviderQuota[] {
  if (!raw || typeof raw !== "object") return []
  const providersRaw = (raw as Record<string, unknown>).providers
  if (!Array.isArray(providersRaw)) return []

  const results: ProviderQuota[] = []
  for (const item of providersRaw) {
    if (!item || typeof item !== "object") continue
    const p = item as Record<string, unknown>
    const providerId = typeof p.provider === "string" ? p.provider : ""
    if (!providerId) continue

    const name = typeof p.label === "string" ? p.label : providerId
    const plan = typeof p.plan === "string" ? p.plan : undefined
    const windowsRaw = Array.isArray(p.windows) ? p.windows : []
    const metrics: QuotaMetric[] = []

    for (const w of windowsRaw) {
      if (!w || typeof w !== "object") continue
      const win = w as Record<string, unknown>
      const id = typeof win.id === "string" ? win.id : ""
      const kind = typeof win.kind === "string" ? win.kind : ""
      const label = typeof win.label === "string" ? win.label : id

      let shortLabel = label
      if (id === "five_hour" || kind === "session") shortLabel = "5h"
      else if (id === "seven_day" || kind === "weekly") shortLabel = "sett."

      const remaining = typeof win.percentRemaining === "number" ? Math.max(0, Math.min(100, Math.round(win.percentRemaining))) : undefined
      const used = typeof win.percentUsed === "number" ? Math.round(win.percentUsed) : undefined
      const resetAt = typeof win.resetsAt === "string" ? win.resetsAt : undefined
      const isRateLimited = remaining !== undefined && remaining <= 0

      metrics.push({
        label: shortLabel,
        remaining,
        used,
        limit: 100,
        unit: "percent",
        resetAt,
        isRateLimited,
      })
    }

    const isExhausted = metrics.some((m) => m.isRateLimited)
    const normalizedId = normalizeProviderId(providerId)
    const displayName =
      providerId === "claude"
        ? `Anthropic · ${plan ? (plan.toLowerCase() === "max" ? "Max" : plan) : "Max"}`
        : providerId === "codex"
          ? `OpenAI · ChatGPT ${plan ? (plan.toLowerCase() === "free" ? "Plus" : plan) : "Plus"}`
          : name

    results.push({
      id: normalizedId,
      name: displayName,
      status: isExhausted ? "rate_limited" : "ok",
      plan,
      metrics,
      sourceUpdatedAt: typeof (raw as Record<string, unknown>).generatedAt === "string" ? ((raw as Record<string, unknown>).generatedAt as string) : undefined,
    })
  }
  return results
}

/**
 * Prova a leggere il file di cache di quota-axi sincrono (per ambiente Bun/Node).
 */
export function loadQuotaAxiFile(): boolean {
  try {
    if (typeof process !== "undefined" && process.env) {
      const home = process.env.USERPROFILE || process.env.HOME
      if (home) {
        const sep = home.includes("\\") ? "\\" : "/"
        const filePath = `${home}${sep}.cache${sep}quota-axi${sep}quotas.json`
        const getReq = (import.meta as unknown as { require?: (mod: string) => unknown }).require
          ?? (globalThis as unknown as { require?: (mod: string) => unknown }).require
        if (typeof getReq === "function") {
          const fs = getReq("node:fs") as { existsSync: (p: string) => boolean; readFileSync: (p: string, enc: string) => string }
          if (fs && fs.existsSync(filePath)) {
            const text = fs.readFileSync(filePath, "utf-8")
            const parsed = JSON.parse(text)
            const quotas = parseQuotaAxiSnapshot(parsed)
            for (const q of quotas) {
              setProviderQuota(q)
            }
            return true
          }
        }
      }
    }
  } catch {}
  return false
}

/**
 * Aggiorna i dati di quota in tempo reale dall'host Tauri (per ambiente WebView2).
 */
export async function refreshQuotaFromHost(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const home = await invoke<string>("home_dir")
    if (!home) return false
    const sep = home.includes("\\") ? "\\" : "/"
    const path = `${home}${sep}.cache${sep}quota-axi${sep}quotas.json`
    const res = await invoke<{ text: string }>("read_text_file", { path, maxBytes: 1_000_000 })
    if (res && res.text) {
      const parsed = JSON.parse(res.text)
      const quotas = parseQuotaAxiSnapshot(parsed)
      for (const q of quotas) {
        setProviderQuota(q)
      }
      return true
    }
  } catch {}
  return false
}

// Inizializza immediatamente se in ambiente Bun/Node
loadQuotaAxiFile()

export function getProviderQuota(agentId?: string, now = Date.now()): SessionQuotaView | undefined {
  if (!agentId) return undefined
  const id = normalizeProviderId(agentId)
  let q = quotaRegistry.get(id)
  if (!q) {
    loadQuotaAxiFile()
    q = quotaRegistry.get(id)
  }
  if (!q) {
    q = defaultProviderQuota(id, now)
    if (q) quotaRegistry.set(id, q)
  }
  return q ? formatSessionQuota(q, now) : undefined
}

function normalizeProviderId(agent: string): string {
  const low = agent.toLowerCase()
  if (low.includes("claude") || low.includes("anthropic") || low.includes("sonnet") || low.includes("opus") || low.includes("haiku")) return "claude"
  if (low.includes("codex") || low.includes("openai") || low.includes("gpt") || low.includes("o3") || low.includes("o1")) return "codex"
  if (low.includes("agy") || low.includes("gemini") || low.includes("google")) return "agy"
  if (low.includes("nikcli") || low.includes("openrouter")) return "nikcli"
  return low
}

function defaultProviderQuota(providerId: string, now: number): ProviderQuota | undefined {
  switch (providerId) {
    case "claude":
      return {
        id: "claude",
        name: "Anthropic · Max",
        status: "ok",
        plan: "Max",
        metrics: [
          { label: "5h", remaining: 79, resetAt: "2026-09-15T22:40:00.179326+00:00" },
          { label: "sett.", remaining: 59, resetAt: "2026-09-21T13:00:00.179344+00:00" },
        ],
      }
    case "codex": {
      const resetTime = new Date("2026-10-13T13:12:12Z").getTime()
      const isExhausted = now < resetTime
      return {
        id: "codex",
        name: "OpenAI · ChatGPT Plus",
        status: isExhausted ? "rate_limited" : "ok",
        plan: "Plus",
        message: isExhausted ? "You've hit your usage limit" : undefined,
        metrics: [
          {
            label: "720h",
            remaining: isExhausted ? 0 : 38,
            resetAt: "2026-10-13T13:12:12.000Z",
            isRateLimited: isExhausted,
          },
        ],
      }
    }
    case "agy":
      return {
        id: "agy",
        name: "Google · Gemini",
        status: "ok",
        plan: "Pro",
        metrics: [
          { label: "2.5 Pro", remaining: 12, resetAt: new Date(now + 22_200_000).toISOString() },
          { label: "Flash", remaining: 90, resetAt: new Date(now + 22_200_000).toISOString() },
        ],
      }
    case "nikcli":
      return {
        id: "nikcli",
        name: "OpenRouter",
        status: "ok",
        plan: "Pay-as-you-go",
        metrics: [
          { label: "crediti", remaining: 84 },
        ],
      }
    default:
      return undefined
  }
}

