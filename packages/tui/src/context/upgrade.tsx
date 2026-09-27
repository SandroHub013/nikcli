import { createSimpleContext } from "./helper"
import type { Transport } from "./sdk"

export const { use: useUpgrade, provider: UpgradeProvider } = createSimpleContext({
  name: "Upgrade",
  init: (input: {
    upgradeNow?: (method: string, version: string) => Promise<void>
    /** Remember "Auto-update" so later checks install without asking. */
    enableAutoUpdate?: () => Promise<void>
    /**
     * Move the backend onto the version just installed and return where it
     * listens. Absent when the backend is this process's own worker, and
     * resolving to `undefined` while the new binary is not in place yet
     * (a deferred Windows swap): either way only a new launch picks it up.
     */
    onUpgraded?: () => Promise<Transport | undefined>
  }) => ({
    upgradeNow: input.upgradeNow,
    enableAutoUpdate: input.enableAutoUpdate,
    onUpgraded: input.onUpgraded,
  }),
})
