/**
 * Which ADE build is running. The test build differs from the official one
 * only by its identifier (`src-tauri/tauri.test.conf.json`), mirroring
 * `is_test_build` in the Rust host.
 */
export const isTestIdentifier = (identifier: string): boolean => identifier.endsWith(".test")

/**
 * Whether this page runs in ADE Test, from the marks `dev.tsx` writes before the
 * surface renders, so it can be asked synchronously. An identifier that could
 * not be read is a test build here, as it is for the key sync
 * (`openrouter-key-sync.ts`): a build whose name is unknown does not spend a key.
 */
export const testBuildMarked = (root: HTMLElement | undefined = globalThis.document?.documentElement): boolean =>
  root?.dataset.adeBuild === "test" || root?.dataset.adeIdentity === "unknown"
