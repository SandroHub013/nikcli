/**
 * Workspace persistence: serialise and restore the workbench state across reloads.
 *
 * The model is deliberately conservative: every field has a defined fallback,
 * and a corrupted or partially-upgraded store must never prevent the app from
 * starting. `parseWorkspace` returns `undefined` for unrecoverable input
 * (garbage JSON, unsupported future version) and fills in defaults for missing
 * or mistyped fields.
 *
 * The `version` field is a monotonic integer. When the schema changes, a new
 * migration function is added to `MIGRATIONS` and the current version is
 * bumped. Each migration transforms version N to N+1, so restoring a v1 state
 * on a v3 app runs two migrations in sequence.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PaneState {
  id: string
  title: string
  agent: string
  cwd: string
  branch: string
  /** "idle" | "running" | "paused" | "done" | "error" */
  status: string
}

export interface WorkspaceState {
  version: number
  panes: PaneState[]
  focusedPaneId: string | undefined
  pinnedColumns: number | undefined
  currentView: string
  sidebarWidth: number
  projectPath: string | undefined
}

/** The version this code writes. */
export const CURRENT_VERSION = 2

// ---------------------------------------------------------------------------
// Defaults — every field has one, so partial restores always produce a usable state
// ---------------------------------------------------------------------------

function defaultPane(): PaneState {
  return { id: "", title: "", agent: "", cwd: "", branch: "", status: "idle" }
}

function defaultWorkspace(): WorkspaceState {
  return {
    version: CURRENT_VERSION,
    panes: [],
    focusedPaneId: undefined,
    pinnedColumns: undefined,
    currentView: "grid",
    sidebarWidth: 260,
    projectPath: undefined,
  }
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/** Serialise the workspace state to a JSON string. */
export function serializeWorkspace(state: WorkspaceState): string {
  return JSON.stringify({ ...state, version: CURRENT_VERSION })
}

// ---------------------------------------------------------------------------
// Parse (tolerant)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function sanitisePane(raw: unknown): PaneState {
  if (!isObject(raw)) return defaultPane()
  const def = defaultPane()
  return {
    id: asString(raw.id, def.id),
    title: asString(raw.title, def.title),
    agent: asString(raw.agent, def.agent),
    cwd: asString(raw.cwd, def.cwd),
    branch: asString(raw.branch, def.branch),
    status: asString(raw.status, def.status),
  }
}

function sanitisePanes(raw: unknown): PaneState[] {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitisePane)
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * v1 → v2: added `projectPath` and `currentView`.
 *
 * v1 stored the active view in a `view` field and had no project tracking.
 * Renames the field and fills the new one.
 */
const migrateV1toV2: Migration = (raw) => {
  const out: Record<string, unknown> = { ...raw, version: 2 }
  // Rename `view` → `currentView` if the old name was used
  if ("view" in raw && !("currentView" in raw)) {
    out.currentView = raw.view
    delete out.view
  }
  // Fill missing fields introduced in v2
  if (!("projectPath" in out)) out.projectPath = undefined
  if (!("sidebarWidth" in out)) out.sidebarWidth = 260
  return out
}

const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1toV2,
}

/** Apply all migrations from `fromVersion` up to `CURRENT_VERSION`. */
export function migrateWorkspace(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  let version = typeof raw.version === "number" ? raw.version : 0
  let state = { ...raw }

  while (version < CURRENT_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) return undefined // unknown gap — can't bridge
    state = migrate(state)
    version = typeof state.version === "number" ? state.version : version + 1
  }

  return state
}

// ---------------------------------------------------------------------------
// Parse entry point
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a `WorkspaceState`, tolerating every kind of damage.
 *
 * Returns `undefined` only when nothing useful can be recovered: invalid JSON
 * or a version from the future that has no migration path. Partial or mistyped
 * fields are silently replaced with defaults — the app starts with a degraded
 * but functional state rather than crashing.
 */
export function parseWorkspace(json: string): WorkspaceState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (!isObject(parsed)) return undefined

  // Prototype pollution guard — work on a clean copy as Record<string, unknown>
  const raw: Record<string, unknown> = { ...parsed }
  delete raw["__proto__"]
  delete raw["constructor"]
  delete raw["prototype"]

  const version = typeof raw.version === "number" ? raw.version : 0

  // Future version with no migration path — don't guess
  if (version > CURRENT_VERSION) return undefined

  // Migrate if needed
  let data: Record<string, unknown> = raw
  if (version < CURRENT_VERSION) {
    const migrated = migrateWorkspace(data)
    if (!migrated) return undefined
    data = migrated
  }

  const def = defaultWorkspace()
  return {
    version: CURRENT_VERSION,
    panes: sanitisePanes(data.panes),
    focusedPaneId: asOptionalString(data.focusedPaneId),
    pinnedColumns: asOptionalNumber(data.pinnedColumns),
    currentView: asString(data.currentView, def.currentView),
    sidebarWidth: asNumber(data.sidebarWidth, def.sidebarWidth),
    projectPath: asOptionalString(data.projectPath),
  }
}
