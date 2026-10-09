import { handleEventsRequest } from "./events"
import { handleSessionStreamRequest } from "./session-lifecycle"

/**
 * The three `/mobile/*` routes that cannot go through the encoded router —
 * the two SSE streams and the WebSocket
 * upgrade (which has never had a dispatcher handler; see `mobile-handlers.ts`).
 * Everything else is an encoded `.handle` on the mobile group.
 */
export async function dispatchMobileRequest(request: Request): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  if (pathname !== "/mobile" && !pathname.startsWith("/mobile/")) return
  return (
    (await handleEventsRequest(request)) ??
    (await handleSessionStreamRequest(request))
  )
}
