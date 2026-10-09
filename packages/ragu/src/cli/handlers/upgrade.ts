import { EOL } from "os"
import { Runtime } from "../framework/runtime"
import { Commands } from "../commands"

/**
 * Ragu Code has no updater: the feeds and installers it used were upstream's, and an update from them replaced
 * this fork with nikcli. Until the fork's releases have a chosen home, `ragu upgrade` only says so, offline.
 */
export const UPGRADE_NOTICE = [
  "Ragu Code does not update itself.",
  "Updates come from the fork's releases: download the new build from the release page and put it in place of this one.",
].join(EOL)

export default Runtime.handler(Commands.commands["upgrade"], async () => {
  process.stdout.write(UPGRADE_NOTICE + EOL)
})
