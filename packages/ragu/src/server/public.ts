import { Effect } from "effect"
import { runPromiseWithLayer } from "@/effect"
import { ShareNext } from "@/share/share-next"
import { ChatbotHttp } from "./httpapi/chatbot"
import { HttpApiEvent } from "./httpapi/event"
import { HttpApiPrompt } from "./httpapi/prompt"
import { rawGlobalHandlers } from "./httpapi/global-handlers"
import { instanceLessRoot } from "./httpapi/instance-less"
import { extraRequest } from "./extra"
import { companionResponse } from "./companion"
import { SyncHttpApi } from "./httpapi/sync"
import { INSPECTOR_BRIDGE_SCRIPT } from "@ragu/util/visual-editor-bridge"

export namespace PublicRoutes {
  function share(shareID: string) {
    return runPromiseWithLayer(
      ShareNext.defaultLayer,
      Effect.gen(function* () {
        const service = yield* ShareNext.Service
        return yield* service.publicData(shareID)
      }),
    )
  }

  export async function publicRequest(request: Request): Promise<Response | undefined> {
    if (request.method !== "GET") return
    const pathname = new URL(request.url).pathname

    // Served unauthenticated and cross-origin on purpose: a dev app loads it
    // from a plain <script> tag so the visual editor can inspect it on its own
    // origin, instead of in a srcdoc copy where client-side routing breaks.
    if (pathname === "/visual-editor/bridge.js") {
      return new Response(INSPECTOR_BRIDGE_SCRIPT, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      })
    }

    const short = pathname.match(/^\/s\/([^/]+)$/)
    if (short) {
      return new Response(null, {
        status: 308,
        headers: { location: `/share/${encodeURIComponent(decodeURIComponent(short[1]))}` },
      })
    }
    const match = pathname.match(/^\/(?:share\/([^/]+)|api\/share\/([^/]+)(?:\/data)?)$/)
    if (!match) return
    const data = await share(decodeURIComponent(match[1] ?? match[2]))
    if (!data) return new Response("Share not found", { status: 404 })
    return Response.json(data)
  }

  export async function globalRequest(request: Request): Promise<Response | undefined> {
    const pathname = new URL(request.url).pathname
    if (request.method === "GET" && pathname === "/global/event") return HttpApiEvent.handle()
    if (request.method === "GET" && pathname === "/sync/stream") return SyncHttpApi.handleSse(request)
    const root = instanceLessRoot(pathname)
    if (!root) return
    return (await rawGlobalHandlers[root]?.(request)) ?? undefined
  }

  export async function instanceRequest(request: Request): Promise<Response | undefined> {
    const extra = await extraRequest(request)
    if (extra) return extra
    const pathname = new URL(request.url).pathname
    if (request.method === "GET" && pathname === "/event") return HttpApiEvent.handleInstance()
    if (request.method === "GET" && pathname === "/companion") return companionResponse(request)
    if (request.method !== "POST") return
    const prompt = pathname.match(/^\/session\/([^/]+)\/message$/)
    if (prompt) return HttpApiPrompt.prompt(request, decodeURIComponent(prompt[1]))
    const promptAsync = pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (promptAsync) return HttpApiPrompt.promptAsync(request, decodeURIComponent(promptAsync[1]))
    if (pathname.startsWith("/chatbot/")) {
      // Falls through when unmatched: `/chatbot/bots*` is a declared group, and
      // answering 404 here would shadow it.
      const webhook = await ChatbotHttp.handle(request)
      if (webhook) return webhook
    }
  }
}
