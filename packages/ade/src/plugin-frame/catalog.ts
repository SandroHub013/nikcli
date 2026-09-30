/**
 * The plugins ADE offers to install. Empty on purpose: NikVerse enters here in PR 8, and until then a plugin is tried from a folder
 * (`ADE_PLUGIN_DEV_DIR`, in a debug build) or through the tests.
 */

export interface CatalogEntry {
  /** The id the index and the folder use. */
  id: string
  /** The name on its row and on its panel. */
  name: string
}

export const CATALOG: readonly CatalogEntry[] = []
