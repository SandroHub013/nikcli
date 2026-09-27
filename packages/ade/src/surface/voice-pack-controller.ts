/**
 * The voice panel's local packs, as ADE drives them (K6): the host's commands
 * for a provider's pack and K3's progress and cancel, which had no caller.
 *
 * Out of `workbench.tsx` so the order of things is tested: the progress is
 * watched only while an install runs, the last reading is kept, a host
 * without a command is a pack that is not available rather than an error.
 */
import {
  watchInstall,
  type InstallProgress,
  type LocalProvider,
  type PackState,
  type PackStatus,
} from "@nikcli-ai/voice"

/** The commands of the host facade this needs; each may be missing. */
export interface VoicePackHost {
  ttsInstallStatus?: (provider: string) => Promise<InstallProgress>
  ttsInstallCancel?: (provider: string) => Promise<{ cancelled: boolean }>
  ttsLocalStatus?: (provider: string) => Promise<PackStatus | undefined>
  ttsLocalInstall?: (provider: string) => Promise<void>
  ttsLocalDelete?: (provider: string) => Promise<void>
}

type Watch = typeof watchInstall

/** Follows an install of `provider` until the returned stop is called. */
export function followInstall(
  host: VoicePackHost | undefined,
  provider: LocalProvider,
  onProgress: (progress: InstallProgress) => void,
  watch: Watch = watchInstall,
): () => void {
  const read = host?.ttsInstallStatus
  if (!read) return () => {}
  return watch(() => read(provider), onProgress)
}

/**
 * Whether the last install of `provider` ended because the user cancelled it:
 * the download then fails, and saying «non riuscito» for what was asked for
 * would be wrong. No host or no answer: not a cancel.
 */
export async function installCancelled(host: VoicePackHost | undefined, provider: LocalProvider): Promise<boolean> {
  const last = await host?.ttsInstallStatus?.(provider).catch(() => undefined)
  return last?.cancelled === true
}

export interface PackController {
  /** Asks the host again what it has. */
  refresh(): Promise<void>
  install(): Promise<void>
  cancel(): Promise<void>
  remove(): Promise<void>
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error ?? "")).trim()

export function createPackController(deps: {
  readonly provider: LocalProvider
  readonly host: () => Promise<VoicePackHost | undefined>
  readonly get: () => PackState
  readonly set: (next: PackState) => void
  /** Said when a failure has no words of its own. */
  readonly fallback: string
  /** What the install downloads, when the host's status does not say it. */
  readonly sizeBytes?: number
  readonly watch?: Watch
}): PackController {
  const { provider } = deps
  const patch = (change: Partial<PackState>) => {
    const next: Record<string, unknown> = { ...deps.get(), ...change }
    for (const key of Object.keys(change)) if (next[key] === undefined) delete next[key]
    deps.set(next as PackState)
  }
  const status = async (host: VoicePackHost | undefined): Promise<PackStatus | undefined> => {
    if (!host?.ttsLocalStatus) return undefined
    try {
      const found = await host.ttsLocalStatus(provider)
      if (!found || found.sizeBytes !== undefined || deps.sizeBytes === undefined) return found
      return { ...found, sizeBytes: deps.sizeBytes }
    } catch {
      // The command is not there (K4b not in this build) or did not answer: not available.
      return undefined
    }
  }
  return {
    async refresh() {
      const host = await deps.host()
      patch({ status: await status(host), removable: Boolean(host?.ttsLocalDelete) })
    },
    async install() {
      if (deps.get().busy) return
      const host = await deps.host()
      if (!host?.ttsLocalInstall) return
      patch({ busy: "install", error: undefined, progress: undefined })
      const stop = followInstall(host, provider, (progress) => patch({ progress }), deps.watch)
      try {
        await host.ttsLocalInstall(provider)
      } catch (error) {
        patch({ error: message(error) || deps.fallback })
      } finally {
        stop()
        // The last word on how it ended: a cancel is not a failure, and says so there.
        const last = host.ttsInstallStatus ? await host.ttsInstallStatus(provider).catch(() => undefined) : undefined
        patch({ busy: undefined, progress: last, status: await status(host) })
        if (last?.cancelled) patch({ error: undefined })
      }
    },
    async cancel() {
      const host = await deps.host()
      await host?.ttsInstallCancel?.(provider).catch(() => undefined)
    },
    async remove() {
      if (deps.get().busy) return
      const host = await deps.host()
      if (!host?.ttsLocalDelete) return
      patch({ busy: "delete", error: undefined })
      try {
        await host.ttsLocalDelete(provider)
      } catch (error) {
        patch({ error: message(error) || deps.fallback })
      } finally {
        patch({ busy: undefined, status: await status(host) })
      }
    },
  }
}
