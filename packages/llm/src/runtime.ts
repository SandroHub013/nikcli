import { Layer, ManagedRuntime, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMClient, Service as LLMClientService } from "./route/client"
import { RequestExecutor } from "./route/executor"
import type { LLMEvent, LLMRequest, PreparedRequest } from "./schema"
import type { StreamOptions } from "./route/client"

const llmLayer = Layer.provide(LLMClient.layer, RequestExecutor.defaultLayer)

type Runtime = ManagedRuntime.ManagedRuntime<LLMClientService, never>
let _runtime: Runtime | undefined
const getRuntime = (): Runtime => {
  if (!_runtime) _runtime = ManagedRuntime.make(llmLayer)
  return _runtime
}

export const prepareRequest = (request: LLMRequest): Promise<PreparedRequest> =>
  getRuntime().runPromise(LLMClient.prepare(request))

export interface RuntimeStreamOptions extends StreamOptions {
  /**
   * Fetch the request is sent through, in place of `globalThis.fetch`. Provider auth that is not a static
   * key (OAuth bearer renewal, an account token resolved per request, a rewritten endpoint) lives in a
   * wrapped fetch, so a stream that cannot take one cannot serve those providers.
   */
  readonly fetch?: typeof globalThis.fetch
}

export const streamRequest = (request: LLMRequest, options?: RuntimeStreamOptions): AsyncIterable<LLMEvent> => {
  const { fetch, ...streamOptions } = options ?? {}
  const events = LLMClient.stream(request, streamOptions).pipe(Stream.provide(llmLayer))
  return Stream.toAsyncIterable(fetch ? events.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : events)
}

export const dispose = async (): Promise<void> => {
  if (_runtime) {
    await _runtime.dispose()
    _runtime = undefined
  }
}
