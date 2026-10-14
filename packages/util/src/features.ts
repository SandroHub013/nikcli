/**
 * Typed experimental feature flags.
 *
 * Central place for opencode-parity gates so callers don't cast `config.experimental` ad hoc. Flags
 * default **off** until soak. (`nativeLlm` is gone: native `@ragu/llm` streaming is the only
 * runtime, and the config key is accepted but ignored so existing configs keep validating.)
 */

export type Features = {
  readonly tui: {
    readonly cacheEviction: boolean
    readonly messageVirtualization: boolean
    readonly explorationGrouping: boolean
  }
  readonly requests: {
    readonly latestOnlyLspRefresh: boolean
  }
  readonly events: {
    readonly schemaEncoding: boolean
  }
}

/**
 * Only the flags this module reads. Deliberately structural rather than derived from
 * `Config.Info`: every field below is checked with `=== true`, so naming the full config type
 * bought no safety while tying a pure predicate to the server's config module.
 */
type Experimental = {
  tui?: {
    cacheEviction?: boolean
    messageVirtualization?: boolean
    explorationGrouping?: boolean
  }
  requests?: {
    latestOnlyLspRefresh?: boolean
  }
  events?: {
    schemaEncoding?: boolean
  }
}

/** Accepts a full `Config.Info`, the SDK's client config, or anything else carrying `experimental`. */
export function features(cfg: { experimental?: unknown } | undefined | null): Features {
  const e = cfg?.experimental as Experimental | undefined
  return {
    tui: {
      cacheEviction: e?.tui?.cacheEviction === true,
      // `true` only when the user turned it on. The session route reads the raw setting instead,
      // because there unset and `false` differ: unset, a transcript past `AUTO_WINDOW_TURNS` is
      // windowed by itself, and only an explicit `false` keeps every row mounted (`windowingOn` in
      // routes/session/message-window.ts). Row heights are still estimated, never measured.
      messageVirtualization: e?.tui?.messageVirtualization === true,
      explorationGrouping: e?.tui?.explorationGrouping === true,
    },
    requests: {
      latestOnlyLspRefresh: e?.requests?.latestOnlyLspRefresh === true,
    },
    events: {
      schemaEncoding: e?.events?.schemaEncoding === true,
    },
  }
}

export * as Features from "./features"
