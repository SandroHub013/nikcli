/**
 * Optional ragu backend for the docs assistant.
 *
 * The default engine is Workers AI (free for every visitor, no login). When a
 * deployment also points at a ragu server, the assistant runs as a real
 * ragu session instead: same agent, tools and session memory as the CLI, and
 * follow-up questions reuse the session.
 *
 * Configure with RAGU_DOCS_SERVER + RAGU_DOCS_TOKEN (and optionally
 * RAGU_DOCS_AGENT / RAGU_DOCS_DIRECTORY).
 */

export type RaguBackendConfig = {
  url: string
  token: string
  agent?: string
  directory?: string
}

export type RaguTurn = {
  sessionID: string
  /** Full assistant text so far — replaces, it does not append. */
  stream: AsyncGenerator<string>
}

/** Stop waiting for a ragu answer after this long. */
const TURN_TIMEOUT_MS = 90_000

export function raguBackendConfig(env: CloudflareEnv): RaguBackendConfig | null {
  const url = env.RAGU_DOCS_SERVER?.trim()
  const token = env.RAGU_DOCS_TOKEN?.trim()
  if (!url || !token) return null
  return {
    url: url.replace(/\/$/, ""),
    token,
    agent: env.RAGU_DOCS_AGENT?.trim() || undefined,
    directory: env.RAGU_DOCS_DIRECTORY?.trim() || undefined,
  }
}

async function createClient(config: RaguBackendConfig) {
  const { createRaguClient } = await import("@ragu/sdk/httpapi")
  return createRaguClient({
    baseUrl: config.url,
    directory: config.directory,
    headers: { Authorization: `Bearer ${config.token}` },
    responseStyle: "data",
    throwOnError: true,
  })
}

type SdkClient = Awaited<ReturnType<typeof createClient>>

function assistantText(parts: Map<string, { role: string; text: string }>) {
  return [...parts.values()]
    .filter((part) => part.role === "assistant")
    .map((part) => part.text)
    .join("")
    .trim()
}

/**
 * Sends a prompt to a ragu session and yields the assistant answer as it
 * grows. Creates the session when `sessionID` is missing.
 */
export async function runRaguTurn(input: {
  config: RaguBackendConfig
  prompt: string
  sessionID?: string
  signal?: AbortSignal
}): Promise<RaguTurn> {
  const sdk: SdkClient = await createClient(input.config)

  let sessionID = input.sessionID
  if (!sessionID) {
    const created = (await sdk.mobile.session.create({
      mobileSessionCreateInput: { title: "nikcli-ai.dev docs support" },
    })) as unknown as { id?: string; data?: { id?: string } }
    sessionID = created?.id ?? created?.data?.id
    if (!sessionID) throw new Error("ragu did not return a session id")
  }

  const stream = (async function* () {
    const started = Date.now()
    const parts = new Map<string, { role: string; text: string }>()
    const roles = new Map<string, string>()
    let last = ""

    const subscription = await sdk.mobile.session.stream({ sessionID: sessionID as string }, { signal: input.signal })

    await sdk.mobile.session.message({
      sessionID: sessionID as string,
      agent: input.config.agent,
      parts: [{ type: "text", text: input.prompt }],
    })

    for await (const raw of subscription.stream) {
      if (input.signal?.aborted) break
      if (Date.now() - started > TURN_TIMEOUT_MS) break

      const event = raw as {
        type?: string
        properties?: {
          info?: { id?: string; role?: string }
          part?: { id?: string; messageID?: string; type?: string; text?: string }
        }
      }

      if (event.type === "message.updated" && event.properties?.info?.id) {
        roles.set(event.properties.info.id, event.properties.info.role ?? "assistant")
        continue
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part
        if (!part?.id || part.type !== "text" || typeof part.text !== "string") continue
        parts.set(part.id, {
          role: roles.get(part.messageID ?? "") ?? "assistant",
          text: part.text,
        })

        const text = assistantText(parts)
        if (text && text !== last) {
          last = text
          yield text
        }
        continue
      }

      if (event.type === "session.idle" || event.type === "session.error") break
    }
  })()

  return { sessionID, stream }
}
