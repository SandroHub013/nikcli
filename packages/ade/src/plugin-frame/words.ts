/** The words the plugin host shows: what a permission lets a plugin do, and how big a download is. */

import { t } from "../i18n"
import type { Permission } from "./api"

/** What a permission lets the plugin do, in plain words (the user reads this before saying yes). */
export function permissionText(permission: Permission): string {
  switch (permission) {
    case "sessions:read":
      return t("plugin.permission.sessions:read")
    case "projects:read":
      return t("plugin.permission.projects:read")
    case "decisions:count":
      return t("plugin.permission.decisions:count")
    case "pane:focus":
      return t("plugin.permission.pane:focus")
    case "command:navigation":
      return t("plugin.permission.command:navigation")
    case "storage":
      return t("plugin.permission.storage")
  }
}

/** A size as a person reads it: «12 KB», «3,4 MB». */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  const megabytes = bytes / 1_000_000
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}
