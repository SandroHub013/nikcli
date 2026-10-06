import type { ModelRead } from "../chat/model-source"
import { modelsFromConfigProviders } from "../chat/model"
import { catalogFromText } from "./catalog"
import { t } from "../i18n"
import type { readModelCatalog } from "./store"

/*
 * The models a bot can be pinned to: the Chat's catalog when ADE's server is already open (and
 * admitted) on the folder, otherwise nikcli's own `models --verbose`.
 *
 * Full review 2026-10-06, bots 2: that second read used to run in the project's folder. nikcli
 * loads the project's configuration for any command (`withInstanceAsync`): it writes
 * `package.json` and runs `bun add` there, with the repository's scripts, and imports its
 * `.nikcli/plugin/*`. Opening a model menu on a cloned repository nobody had admitted ran that
 * code before the trust question it is subject to anywhere else. Without an open server the read
 * runs in the user's home: the global catalog is the same for every project, and a project's own
 * providers show once the Chat has opened it. Not "no folder": that is ADE's own start folder,
 * which ADE treats as a project (`sidebar.tsx`), so ADE opened from a terminal inside a cloned
 * repository brought the same scenario back (Verifiche's review of F2). In the home nikcli finds
 * only `~/.nikcli`, the global configuration it loads at every start anyway.
 */
export interface BotModelsDeps {
  /** The Chat's provider list, when its server is open on `cwd`; `undefined` when it is not. */
  readonly openCatalog: (cwd: string) => Promise<Parameters<typeof modelsFromConfigProviders>[0] | undefined>
  /** The user's home folder, where the read runs; `undefined` when the host cannot say. */
  readonly homeDir: () => Promise<string | undefined>
  /** `nikcli models --verbose` in `cwd`. */
  readonly readCatalog: (cwd: string) => ReturnType<typeof readModelCatalog>
  readonly isTest: boolean
}

export async function readBotModels(cwd: string, deps: BotModelsDeps): Promise<ModelRead> {
  const options = { isTest: deps.isTest }
  const configured = cwd ? await deps.openCatalog(cwd) : undefined
  if (configured) return { ok: true, models: modelsFromConfigProviders(configured, options) }
  // Never in the project's folder, nor in ADE's start folder: either may be one nobody admitted.
  const home = await deps.homeDir().catch(() => undefined)
  if (!home) return { ok: false, reason: t("bots.models.noHost") }
  const read = await deps.readCatalog(home)
  if (!read.ok) return read
  return { ok: true, models: modelsFromConfigProviders(catalogFromText(read.text), options) }
}
