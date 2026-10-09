function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

/** Three states: on (`1`/`true`), off (`0`/`false`), or `undefined` when unset or anything else, so a default can tell «no» from «not said». */
function tristate(key: string): boolean | undefined {
  const value = process.env[key]?.trim().toLowerCase()
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  return undefined
}

export namespace Flag {
  /**
   * Whether permission prompts are auto-approved for this process.
   *
   * Read on every access rather than captured at module load: the CLI sets the variable from its
   * argv middleware, which runs after this module is first imported, and the TUI reads it again in
   * a worker thread that inherits the environment.
   */
  export function autoApprove() {
    return truthy("RAGU_AUTO_APPROVE")
  }

  /**
   * The permission mode forced for this process by `--permission-mode`, or
   * `undefined` to use the configured one. Read on every access for the same
   * reason as `autoApprove`.
   */
  export function permissionMode(): "default" | "auto" | undefined {
    const value = process.env["RAGU_PERMISSION_MODE"]?.toLowerCase()
    if (value === "auto" || value === "default") return value
    return undefined
  }

  /**
   * Turn every mod off for this process (`RAGU_DISABLE_MODS=1`), the safe-mode switch. Read on
   * every access for the same reason as `autoApprove`: the CLI can set it after this module is
   * first imported.
   */
  export function modsDisabled() {
    return truthy("RAGU_DISABLE_MODS")
  }

  /**
   * An extra directory of managed settings and organization mods
   * (`RAGU_MANAGED_CONFIG_DIR`), for MDM and tests. Read on every access like `autoApprove`.
   */
  export function managedConfigDir() {
    return process.env["RAGU_MANAGED_CONFIG_DIR"]
  }

  export const RAGU_GIT_BASH_PATH = process.env["RAGU_GIT_BASH_PATH"]
  export const RAGU_CONFIG = process.env["RAGU_CONFIG"]
  export declare const RAGU_CONFIG_DIR: string | undefined
  export declare const RAGU_CONFIG_CONTENT: string | undefined
  export const RAGU_DISABLE_PRUNE = truthy("RAGU_DISABLE_PRUNE")
  export const RAGU_DISABLE_TERMINAL_TITLE = truthy("RAGU_DISABLE_TERMINAL_TITLE")
  export const RAGU_PERMISSION = process.env["RAGU_PERMISSION"]
  export const RAGU_DISABLE_DEFAULT_PLUGINS = truthy("RAGU_DISABLE_DEFAULT_PLUGINS")
  export declare const RAGU_ISLAND: boolean
  export declare const RAGU_HERDR: boolean
  export const RAGU_DISABLE_LSP_DOWNLOAD = truthy("RAGU_DISABLE_LSP_DOWNLOAD")
  export const RAGU_ENABLE_EXPERIMENTAL_MODELS = truthy("RAGU_ENABLE_EXPERIMENTAL_MODELS")
  // Opt out of falling back to `gpt-reserve` when a ChatGPT plan's main models
  // (gpt-6-astra, gpt-5.x, the codex slugs) run out of allowance. See
  // `plugin/codex.ts`; requests then fail with the provider's 429 instead.
  export const RAGU_DISABLE_GPT_RESERVE_FALLBACK = truthy("RAGU_DISABLE_GPT_RESERVE_FALLBACK")
  export const RAGU_DISABLE_AUTOCOMPACT = truthy("RAGU_DISABLE_AUTOCOMPACT")
  // Opt out of the in-process config hot reload (instance reload on config
  // file changes). Reload can still be triggered explicitly via the API.
  export const RAGU_DISABLE_HOT_RELOAD = truthy("RAGU_DISABLE_HOT_RELOAD")
  // Opt out of TUI plugin hot reload (watching local plugin sources and
  // swapping an edited plugin in place). Plugins then load once at startup.
  export const RAGU_DISABLE_PLUGIN_RELOAD = truthy("RAGU_DISABLE_PLUGIN_RELOAD")
  /** Log which part of the request prefix changed between calls. See `provider/cache-diagnostics.ts`. */
  export const RAGU_PROMPT_CACHE_DIAGNOSTICS = truthy("RAGU_PROMPT_CACHE_DIAGNOSTICS")
  /**
   * Prompt-cache entry lifetime: `long` opts into the provider's 1-hour entry
   * instead of the 5-minute default. See `provider/cache-policy.ts` for the
   * cost tradeoff.
   *
   * A function rather than a constant for the same reason as `autoApprove`: the
   * value can be set after this module is first imported.
   */
  export function cacheRetention() {
    return process.env["RAGU_CACHE_RETENTION"]
  }
  /**
   * What the prompt_cache_key sent to OpenAI-style providers is made of: `model` (default, one key per provider/model), `session`
   * (one key per session) or `none` (no key). The raw value, trimmed and lowercased: `provider/transform.ts` resolves unknown values.
   * Read on every use, like `cacheRetention`.
   */
  export function promptCacheKey() {
    return process.env["RAGU_PROMPT_CACHE_KEY"]?.trim().toLowerCase() || undefined
  }
  /**
   * The cache keeper (`session/cache-keeper.ts`): keeps an idle session's prompt-cache entry alive with one hidden request shortly
   * before it would expire. `RAGU_CACHE_KEEPALIVE=1` as a plain switch; unset, the keeper is on for Codex and off elsewhere
   * (`cacheKeepaliveSetting`, `CacheKeeper.settings`). Read on every use, like `cacheRetention`.
   */
  export function cacheKeepalive() {
    return truthy("RAGU_CACHE_KEEPALIVE")
  }
  /** `RAGU_CACHE_KEEPALIVE` as the user said it: `undefined` is «not said», which is on for Codex and off elsewhere (`CacheKeeper.settings`). */
  export function cacheKeepaliveSetting() {
    return tristate("RAGU_CACHE_KEEPALIVE")
  }
  export function cacheKeepaliveCompactSetting() {
    return tristate("RAGU_CACHE_KEEPALIVE_COMPACT")
  }
  export function compactionSharedPrefixSetting() {
    return tristate("RAGU_COMPACTION_SHARED_PREFIX")
  }
  /** Idle compaction by the keeper, instead of letting the entry die at the end of its budget. Needs `cacheKeepalive` and `compactionSharedPrefix`. */
  export function cacheKeepaliveCompact() {
    return truthy("RAGU_CACHE_KEEPALIVE_COMPACT")
  }
  /**
   * Compaction that reuses the prefix of the conversation's last request (same system, tools and messages, the summary instruction as
   * the last user message) so the provider reads it from cache. `RAGU_COMPACTION_SHARED_PREFIX=1` as a plain switch; unset, it is on
   * for a Codex session and off elsewhere (`compactionSharedPrefixSetting`, `CacheKeeper.sharedPrefix`).
   */
  export function compactionSharedPrefix() {
    return truthy("RAGU_COMPACTION_SHARED_PREFIX")
  }
  /** `RAGU_COMPACTION_TOOL_CHOICE=same|none` forces how the shared-prefix compaction keeps the model from calling tools; `undefined` is the provider's default. */
  export function compactionToolChoice(): "same" | "none" | undefined {
    const raw = process.env["RAGU_COMPACTION_TOOL_CHOICE"]?.trim().toLowerCase()
    return raw === "same" || raw === "none" ? raw : undefined
  }
  /**
   * A positive number from the environment (`RAGU_CACHE_KEEPALIVE_*`), or `undefined` when unset or not one. `0` counts as «not set»
   * (a 0 lifetime, margin, threshold or horizon means nothing), except with `allowZero`: `RAGU_CACHE_KEEPALIVE_MAX_RENEWALS=0` is a
   * real budget (no keep-alive, compact at once). Negatives, `NaN`, infinities and text are «not set» either way.
   */
  export function cacheKeepaliveNumber(name: string, options?: { allowZero?: boolean }): number | undefined {
    const raw = process.env[name]?.trim()
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) return undefined
    return value > 0 || (options?.allowZero === true && value === 0) ? value : undefined
  }
  // Opt out of journaling local (non-workspace) session restore events into
  // the unified sync_event log.
  export const RAGU_DISABLE_SESSION_JOURNAL = truthy("RAGU_DISABLE_SESSION_JOURNAL")
  // Optional hub-and-spoke remote sync. Setting both URL and TOKEN enables
  // it; AUTOSTART=false keeps bootstrap from starting it automatically
  // (explicit `ragu sync` / `ragu serve` still can).
  export const RAGU_REMOTE_URL = process.env["RAGU_REMOTE_URL"]
  export const RAGU_REMOTE_TOKEN = process.env["RAGU_REMOTE_TOKEN"]
  export const RAGU_REMOTE_AUTOSTART = (() => {
    const value = process.env["RAGU_REMOTE_AUTOSTART"]?.toLowerCase()
    return value !== "false" && value !== "0"
  })()
  /** Read on every access: tests set it at their own module scope, after this module is imported. */
  export function disableModelsFetch() {
    return truthy("RAGU_DISABLE_MODELS_FETCH")
  }
  export const RAGU_DISABLE_CLAUDE_CODE = truthy("RAGU_DISABLE_CLAUDE_CODE")
  export const RAGU_DISABLE_CLAUDE_CODE_PROMPT =
    RAGU_DISABLE_CLAUDE_CODE || truthy("RAGU_DISABLE_CLAUDE_CODE_PROMPT")
  export const RAGU_DISABLE_CLAUDE_CODE_SKILLS =
    RAGU_DISABLE_CLAUDE_CODE || truthy("RAGU_DISABLE_CLAUDE_CODE_SKILLS")
  export const RAGU_DISABLE_EXTERNAL_SKILLS =
    RAGU_DISABLE_CLAUDE_CODE_SKILLS || truthy("RAGU_DISABLE_EXTERNAL_SKILLS")
  export declare const RAGU_DISABLE_PROJECT_CONFIG: boolean
  export const RAGU_FAKE_VCS = process.env["RAGU_FAKE_VCS"]
  export const RAGU_CLIENT = process.env["RAGU_CLIENT"] ?? "cli"
  export const RAGU_SERVER_PASSWORD = process.env["RAGU_SERVER_PASSWORD"]
  export const RAGU_SERVER_USERNAME = process.env["RAGU_SERVER_USERNAME"]
  // Max HTTP request body in bytes (defaults applied at the serve site).
  export const RAGU_SERVER_MAX_BODY = process.env["RAGU_SERVER_MAX_BODY"]
    ? parseInt(process.env["RAGU_SERVER_MAX_BODY"]!, 10)
    : undefined
  export const RAGU_SERVER_TAILSCALE_AUTH = truthy("RAGU_SERVER_TAILSCALE_AUTH")
  export const RAGU_SERVER_TAILSCALE_USERS = process.env["RAGU_SERVER_TAILSCALE_USERS"]
  /**
   * Identity-plane verifier inputs, read on every access for the same reason
   * as `autoApprove`: the value can be set after this module is first
   * imported. Captured as constants, the first importer decided them for the
   * whole process — which under `bun test` is whichever file happened to load
   * a server module first, so a test that exports its own issuer and HS256
   * secret before importing anything still got the defaults, and every token
   * it signed verified as 401.
   */
  export function authIssuer() {
    return process.env["RAGU_AUTH_ISSUER"]
  }
  export function authJwksUrl() {
    return process.env["RAGU_AUTH_JWKS_URL"]
  }
  export function authAudience() {
    return process.env["RAGU_AUTH_AUDIENCE"] ?? "ragu-api"
  }
  export function authJwtSecret() {
    return process.env["RAGU_AUTH_JWT_SECRET"]
  }
  /**
   * The legacy-credential gate, read on every access.
   *
   * Together these two decide whether the server still accepts `nku_`
   * sessions, Basic and Tailscale. Captured as constants they were fixed by
   * whichever module in the process touched a flag first, which under
   * `bun test` is not the file that set them — `test/server/unified-auth.fixture.ts`
   * exports `RAGU_REQUIRE_OAUTH=1` at its own module scope and would still
   * have run against the process default. A security test that passes because
   * the gate it meant to close was never open is worse than one that fails.
   *
   * They move together on purpose: every call site reads both, and a pair
   * where one side is live and the other is a snapshot can disagree.
   */
  export function requireOauth() {
    return truthy("RAGU_REQUIRE_OAUTH")
  }
  export function legacyLogin() {
    return truthy("RAGU_LEGACY_LOGIN")
  }

  // OpenTelemetry (OTLP) — standard env vars. Setting an endpoint enables export.
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]
  export const RAGU_DANGEROUSLY_SKIP_PERMISSIONS = truthy("RAGU_DANGEROUSLY_SKIP_PERMISSIONS")
  // Live telemetry capture (spans streamed to the TUI panel) is on by default;
  // set this to opt out of the in-process span capture entirely.
  export const RAGU_DISABLE_OTEL_LIVE = truthy("RAGU_DISABLE_OTEL_LIVE")

  // SSH Server
  export const RAGU_SERVER_SSH_ENABLED = truthy("RAGU_SERVER_SSH_ENABLED")
  export const RAGU_SERVER_SSH_PORT = parseInt(process.env["RAGU_SERVER_SSH_PORT"] ?? "2222")
  export const RAGU_SERVER_SSH_HOST = process.env["RAGU_SERVER_SSH_HOST"] ?? "0.0.0.0"

  // Connectors
  export const RAGU_FIGMA_TOKEN = process.env["RAGU_FIGMA_TOKEN"]
  export const RAGU_SLACK_BOT_TOKEN = process.env["RAGU_SLACK_BOT_TOKEN"]
  export const RAGU_GITHUB_TOKEN = process.env["RAGU_GITHUB_TOKEN"]
  /**
   * The GitHub client every host falls back to. Public, not a secret: users
   * only approve their own GitHub account against it.
   *
   * This must be an **OAuth App**, not a GitHub App. A GitHub App issues user
   * tokens that expire in 8 hours and can only be refreshed by presenting the
   * app's client secret — which a CLI and a phone, both public clients, cannot
   * hold. GitHub answers `incorrect_client_credentials` and the connection
   * dies with no way back (see `refreshGithubToken` in
   * `server/mobile/helpers.ts`). An OAuth App's tokens do not expire, so that
   * failure cannot happen. A GitHub App also ignores the requested `scope` and
   * grants repo access per installation instead, which is where the 404s on
   * repositories came from.
   *
   * Single source of truth: the host resolves env var → `nikcli.json`
   * connector → this value, and nothing else ships a copy.
   */
  export const RAGU_GITHUB_OAUTH_CLIENT_ID_DEFAULT = "Ov23liIrum4YVdDu8Ogr"
  /**
   * The same lookup with the built-in default folded in, so this is never
   * empty. Kept for callers that just want "whatever client ID applies", but
   * do NOT use it to decide precedence: it cannot tell an operator's env var
   * apart from the default, and doing so is what made `nikcli.json` unable to
   * override the client ID. `githubOAuthClientID` in `server/mobile/helpers.ts`
   * owns that decision.
   *
   * `||` so empty-string env vars do not win over the default.
   */
  export const RAGU_GITHUB_OAUTH_CLIENT_ID =
    process.env["RAGU_GITHUB_OAUTH_CLIENT_ID"]?.trim() ||
    process.env["GITHUB_CLIENT_ID_CONSOLE"]?.trim() ||
    process.env["GITHUB_CLIENT_ID"]?.trim() ||
    RAGU_GITHUB_OAUTH_CLIENT_ID_DEFAULT
  export const RAGU_LOVABLE_TOKEN = process.env["RAGU_LOVABLE_TOKEN"] ?? process.env["RAGU_LOVABLE_API_KEY"]
  export const RAGU_LOVABLE_API_KEY = process.env["RAGU_LOVABLE_API_KEY"]

  // Notifications
  export const RAGU_SLACK_CHANNEL =
    process.env["RAGU_SLACK_CHANNEL"] ?? process.env["SLACK_DEFAULT_CHANNEL"] ?? process.env["SLACK_CHANNEL"]
  export const RAGU_DISCORD_WEBHOOK_URL =
    process.env["RAGU_DISCORD_WEBHOOK_URL"] ?? process.env["DISCORD_WEBHOOK_URL"]
  export const RAGU_TODO_NOTIFICATIONS = true
  export const RAGU_SLACK_TASK_NOTIFICATIONS =
    truthy("RAGU_SLACK_TASK_NOTIFICATIONS") || truthy("SLACK_TASK_NOTIFICATIONS")
  export const RAGU_DISCORD_TASK_NOTIFICATIONS =
    truthy("RAGU_DISCORD_TASK_NOTIFICATIONS") || truthy("DISCORD_TASK_NOTIFICATIONS")

  // TUI plugin system
  export declare const RAGU_TUI_CONFIG: string | undefined
  /** Where the ChatGPT-plan (Codex) provider sends its model calls; the plugin's own URL when unset. */
  export declare const RAGU_CODEX_ENDPOINT: string | undefined
  /** Which tool set the model's schema carries: default | a1 | t5 (see ToolRegistry.TOOLSETS); the config's `experimental.toolset` when unset. */
  export declare const RAGU_TOOLSET: string | undefined
  export const RAGU_PURE = truthy("RAGU_PURE")
  export const RAGU_PLUGIN_META_FILE = process.env["RAGU_PLUGIN_META_FILE"]

  // Experimental
  export const RAGU_EXPERIMENTAL = truthy("RAGU_EXPERIMENTAL")
  export const RAGU_EXPERIMENTAL_FILEWATCHER = true
  /** Read on every access: tests set it at their own module scope, after this module is imported. */
  export function disableFilewatcher() {
    return truthy("RAGU_EXPERIMENTAL_DISABLE_FILEWATCHER")
  }
  export const RAGU_EXPERIMENTAL_ICON_DISCOVERY = RAGU_EXPERIMENTAL || truthy("RAGU_EXPERIMENTAL_ICON_DISCOVERY")
  export const RAGU_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = truthy("RAGU_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const RAGU_ENABLE_EXA =
    truthy("RAGU_ENABLE_EXA") || RAGU_EXPERIMENTAL || truthy("RAGU_EXPERIMENTAL_EXA")
  export const RAGU_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH = number("RAGU_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH")
  export const RAGU_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("RAGU_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const RAGU_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("RAGU_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const RAGU_EXPERIMENTAL_OXFMT = true
  export const RAGU_EXPERIMENTAL_LSP_TY = true
  export const RAGU_EXPERIMENTAL_LSP_TOOL = true
  export const RAGU_DISABLE_FILETIME_CHECK = truthy("RAGU_DISABLE_FILETIME_CHECK")
  export const RAGU_EXPERIMENTAL_SCOUT = true
  export const RAGU_EXPERIMENTAL_WORKSPACES_TUI = true
  export const RAGU_EXPERIMENTAL_SECURITY_TOOL = true
  export const RAGU_EXPERIMENTAL_WEBSOCKETS = true
  // Confined code-mode tool (interpreter port from opencode v2 codemode); see specs/codemode.md.
  // Default-on; opt out with RAGU_DISABLE_CODE_MODE.
  export const RAGU_EXPERIMENTAL_CODE_MODE = !truthy("RAGU_DISABLE_CODE_MODE")
  // Linux-only: place sandboxed children in this cgroup before they start.
  export const RAGU_SANDBOX_CGROUP = process.env["RAGU_SANDBOX_CGROUP"]

  // Computer & browser control ("computer use" like Codex / Claude Code).
  // The browser_control tool drives @ragu/browser-control's local,
  // headless, background-daemon Chromium; desktop computer-use sends real
  // input to the local machine. Both tools remain explicitly disableable.
  // Opt out with RAGU_DISABLE_BROWSER_CONTROL_TOOL / RAGU_DISABLE_COMPUTER_TOOL.
  // RAGU_DISABLE_BROWSER_TOOL stays honoured: it is what the tool was called
  // before the rename, and it may already be set in someone's shell profile.
  export const RAGU_EXPERIMENTAL_BROWSER_CONTROL_TOOL = !(
    truthy("RAGU_DISABLE_BROWSER_CONTROL_TOOL") || truthy("RAGU_DISABLE_BROWSER_TOOL")
  )
  export const RAGU_EXPERIMENTAL_COMPUTER_TOOL = !truthy("RAGU_DISABLE_COMPUTER_TOOL")

  // Opt-in filesystem scan of `{tool,tools}/*.{js,ts}` under config dirs.
  // Default off — arbitrary code import from config directories is a security
  // boundary. Set RAGU_ALLOW_PLUGIN_AUTOLOAD=1 to restore the historical
  // glob+import behaviour, or pin specific files via `tool.allow` / `tool.pin`
  // in nikcli.json (allowlist loads without the flag).
  export declare const RAGU_ALLOW_PLUGIN_AUTOLOAD: boolean

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for RAGU_DISABLE_PROJECT_CONFIG
Object.defineProperty(Flag, "RAGU_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("RAGU_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_ISLAND", {
  get() {
    return truthy("RAGU_ISLAND")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_HERDR", {
  get() {
    return truthy("RAGU_HERDR")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for RAGU_CONFIG_DIR
Object.defineProperty(Flag, "RAGU_CONFIG_DIR", {
  get() {
    return process.env["RAGU_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for RAGU_CONFIG_CONTENT: tests assign it at runtime (e.g.
// `test/brain/brain-pass.test.ts` turning on `experimental.brain`), after
// flag.ts may already have been imported.
Object.defineProperty(Flag, "RAGU_CONFIG_CONTENT", {
  get() {
    return process.env["RAGU_CONFIG_CONTENT"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for RAGU_CODEX_ENDPOINT: read at each request, so a test or a wrapper can set it late.
Object.defineProperty(Flag, "RAGU_CODEX_ENDPOINT", {
  get() {
    return process.env["RAGU_CODEX_ENDPOINT"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_TOOLSET", {
  get() {
    return process.env["RAGU_TOOLSET"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_TUI_CONFIG", {
  get() {
    return process.env["RAGU_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_ALLOW_PLUGIN_AUTOLOAD", {
  get() {
    return truthy("RAGU_ALLOW_PLUGIN_AUTOLOAD")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "RAGU_GITHUB_OAUTH_CLIENT_ID", {
  get() {
    return (
      process.env["RAGU_GITHUB_OAUTH_CLIENT_ID"]?.trim() ||
      process.env["GITHUB_CLIENT_ID_CONSOLE"]?.trim() ||
      process.env["GITHUB_CLIENT_ID"]?.trim() ||
      Flag.RAGU_GITHUB_OAUTH_CLIENT_ID_DEFAULT
    )
  },
  enumerable: true,
  configurable: false,
})
