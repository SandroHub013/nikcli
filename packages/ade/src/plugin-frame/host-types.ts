/** What the native plugin commands answer with (`plugin_install.rs`), as the frontend reads it. */

/** A plugin as `plugin_list` reports it. */
export interface InstalledPlugin {
  id: string
  current?: string | null
  pending?: string | null
  previous?: string | null
  bytes: number
  /** What the installed version's manifest asks for. */
  permissions: string[]
  /** What the pending version's manifest asks for. */
  pending_permissions?: string[] | null
  /** Served from a folder, unsigned: only in a debug build. */
  dev?: boolean
}

/** The answer to «is there a new version of this plugin?». */
export interface PluginAvailable {
  id: string
  version: string
  current?: string | null
  pending?: string | null
  update: boolean
  size_bytes: number
  permissions: string[]
}

/** How an install is going, running or just over. */
export interface PluginProgress {
  id: string
  running: boolean
  files_done: number
  files_total: number
  bytes_done: number
  bytes_total: number
  error?: string | null
}
