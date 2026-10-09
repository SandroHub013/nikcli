import { Effect } from "effect"
import { Database } from "@/database/database"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Log } from "@ragu/util/log"

/**
 * Recomputes the anonymous usage rollups in `analytics_stat` from the messages
 * already in the local database.
 *
 * Rollups are derived, never accumulated. A day is recomputed from its messages
 * every time it is touched, so a crash mid-write, a resumed session, or a message
 * that arrives late all converge to the same numbers — an incrementing counter
 * would drift and there would be no way to tell that it had.
 *
 * Everything here is deliberately expressed as SQL over `message_info`. That is
 * the only place the local install holds per-model truth, and doing the grouping
 * in SQLite means the identifying columns (`info`, which holds whole serialized
 * messages) are read but never leave this function.
 */
export namespace AnalyticsRollup {
  const log = Log.create({ service: "analytics.rollup" })

  /** Only day rollups exist today; week/month would be additional grains. */
  export const GRAIN_DAY = "day"

  /**
   * `usage.cost` on the gateway side is micro-cents, and the local `cost` field is
   * USD as a float. Storing micro-cent integers keeps a year of sums exact.
   */
  const MICRO_CENTS_PER_USD = 100_000_000

  /** UTC day for a millisecond timestamp column, as SQLite computes it. */
  const DAY_OF = "date(created_at / 1000, 'unixepoch')"

  /**
   * Assistant messages carry the model that produced them. Rows without one are
   * failures that never reached a provider; counting them would inflate the
   * message count with turns that produced nothing.
   */
  const HAS_MODEL = `
    role = 'assistant'
    AND json_extract(info, '$.providerID') IS NOT NULL
    AND json_extract(info, '$.providerID') != ''
    AND json_extract(info, '$.modelID') IS NOT NULL
    AND json_extract(info, '$.modelID') != ''`

  const token = (path: string) => `COALESCE(SUM(COALESCE(json_extract(info, '$.tokens.${path}'), 0)), 0)`

  export type Row = {
    grain: string
    periodKey: string
    provider: string
    model: string
    sessions: number
    messages: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    totalTokens: number
    costMicroCents: number
    durationMs: number
    updatedAt: number
  }

  /**
   * Rebuild `[from, to]` inclusive, both `YYYY-MM-DD` UTC.
   *
   * Returns how many rollup rows the range now holds.
   */
  export function rebuild(input: { from: string; to: string }): Promise<number> {
    return runPromiseWithLayer(
      Database.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const { native } = yield* Database.Service
          const now = Date.now()

          return yield* Effect.sync(() => {
            native.transaction(() => {
              // A model can disappear from a day entirely (messages deleted with
              // their session). Clearing the window first is what makes this a
              // rebuild rather than a merge that could strand a stale row.
              native
                .query(`DELETE FROM analytics_stat WHERE grain = ? AND period_key BETWEEN ? AND ?`)
                .run(GRAIN_DAY, input.from, input.to)

              native
                .query(
                  `INSERT INTO analytics_stat (
                     grain, period_key, provider, model,
                     sessions, messages, tool_calls,
                     input_tokens, output_tokens, reasoning_tokens,
                     cache_read_tokens, cache_write_tokens, total_tokens,
                     cost_micro_cents, duration_ms, updated_at
                   )
                   SELECT
                     '${GRAIN_DAY}',
                     ${DAY_OF},
                     json_extract(info, '$.providerID'),
                     json_extract(info, '$.modelID'),
                     -- Counted here, where session ids still exist. A session that
                     -- used two models cannot be recovered by summing the per-model
                     -- rows afterwards: it would count twice.
                     COUNT(DISTINCT session_id),
                     COUNT(*),
                     0,
                     ${token("input")},
                     ${token("output")},
                     ${token("reasoning")},
                     ${token("cache.read")},
                     ${token("cache.write")},
                     ${token("input")} + ${token("output")} + ${token("reasoning")}
                       + ${token("cache.read")} + ${token("cache.write")},
                     CAST(ROUND(COALESCE(SUM(COALESCE(json_extract(info, '$.cost'), 0)), 0) * ${MICRO_CENTS_PER_USD}) AS INTEGER),
                     COALESCE(SUM(
                       CASE
                         WHEN json_extract(info, '$.time.completed') IS NULL THEN 0
                         ELSE MAX(0, json_extract(info, '$.time.completed') - json_extract(info, '$.time.created'))
                       END
                     ), 0),
                     ?
                   FROM message_info
                   WHERE ${HAS_MODEL}
                     AND ${DAY_OF} BETWEEN ? AND ?
                   GROUP BY 2, 3, 4`,
                )
                .run(now, input.from, input.to)

              // Tool calls live on parts, so they are attributed in a second pass
              // against the message that made them.
              native
                .query(
                  `UPDATE analytics_stat SET tool_calls = COALESCE((
                     SELECT COUNT(*)
                     FROM message_part p
                     JOIN message_info m ON m.id = p.message_id
                     WHERE p.type = 'tool'
                       AND m.role = 'assistant'
                       AND date(m.created_at / 1000, 'unixepoch') = analytics_stat.period_key
                       AND json_extract(m.info, '$.providerID') = analytics_stat.provider
                       AND json_extract(m.info, '$.modelID') = analytics_stat.model
                   ), 0)
                   WHERE grain = ? AND period_key BETWEEN ? AND ?`,
                )
                .run(GRAIN_DAY, input.from, input.to)
            })()

            const counted = native
              .query<
                { n: number },
                [string, string, string]
              >(`SELECT COUNT(*) AS n FROM analytics_stat WHERE grain = ? AND period_key BETWEEN ? AND ?`)
              .get(GRAIN_DAY, input.from, input.to)

            const rows = counted?.n ?? 0
            log.info("rebuilt", { from: input.from, to: input.to, rows })
            return rows
          })
        }),
      ),
    )
  }

  /**
   * The first day that has a message, and whether any rollup exists yet.
   *
   * A fresh install can have months of history in `message_info` and nothing in
   * `analytics_stat`, because rollups are only written for days something asked
   * for. Lifetime figures would silently start at whenever the feature was first
   * used, so the first build backfills from here instead.
   */
  export function bounds(): Promise<{ earliestDay?: string; rollupRows: number }> {
    return runPromiseWithLayer(
      Database.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const { native } = yield* Database.Service
          return yield* Effect.sync(() => {
            const earliest = native
              .query<
                { day: string | null },
                []
              >(`SELECT ${DAY_OF} AS day FROM message_info WHERE ${HAS_MODEL} ORDER BY created_at ASC LIMIT 1`)
              .get()
            const counted = native.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM analytics_stat`).get()
            return {
              earliestDay: earliest?.day ?? undefined,
              rollupRows: counted?.n ?? 0,
            }
          })
        }),
      ),
    )
  }

  /** Read rollups back, oldest first — what `/data` shows. */
  export function read(input: { from: string; to: string }): Promise<Row[]> {
    return runPromiseWithLayer(
      Database.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const { native } = yield* Database.Service
          return yield* Effect.sync(() =>
            native
              .query<Row, [string, string, string]>(
                `SELECT
                   grain, period_key AS periodKey, provider, model,
                   sessions, messages, tool_calls AS toolCalls,
                   input_tokens AS inputTokens, output_tokens AS outputTokens,
                   reasoning_tokens AS reasoningTokens, cache_read_tokens AS cacheReadTokens,
                   cache_write_tokens AS cacheWriteTokens, total_tokens AS totalTokens,
                   cost_micro_cents AS costMicroCents, duration_ms AS durationMs,
                   updated_at AS updatedAt
                 FROM analytics_stat
                 WHERE grain = ? AND period_key BETWEEN ? AND ?
                 ORDER BY period_key ASC, total_tokens DESC, model ASC`,
              )
              .all(GRAIN_DAY, input.from, input.to),
          )
        }),
      ),
    )
  }
}
