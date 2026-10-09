import { Runtime } from "../framework/runtime"
import { Effect } from "effect"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Session } from "@/session"
import { bootstrap } from "@/cli/bootstrap"
import { SessionRepo } from "@/session/repo"
import { SessionV2Write } from "@/session/v2/write"
import { EOL } from "os"

export default Runtime.handler(Commands.commands["import"], async (input) => {
  const args = {
    _: [],
    $0: "ragu",
    "--": passthrough(),
    file: input["file"],
  }
  await bootstrap(process.cwd(), async (instance) => {
    const exportData:
      | {
          info: Session.Info
          messages: Array<{
            info: any
            parts: any[]
          }>
        }
      | undefined = await Bun.file(args.file)
      .json()
      .catch(() => undefined)
    if (!exportData) {
      process.stdout.write(`File not found: ${args.file}`)
      process.stdout.write(EOL)
      return
    }

    // Import into the current project regardless of where the export came from
    Effect.runSync(
      SessionRepo.upsert({
        ...exportData.info,
        projectID: instance.project.id,
      }),
    )

    const projectID = instance.project.id
    for (const msg of exportData.messages) {
      const info = { ...msg.info, sessionID: exportData.info.id }
      const parts = msg.parts.map((part) => ({
        ...part,
        sessionID: exportData.info.id,
        messageID: msg.info.id,
      }))
      // Entry-first persist: a projection throw cannot commit v1 rows the
      // entry table cannot represent.
      SessionV2Write.persist({
        prepared: { info, parts },
        promptData: "",
        projectID,
      })
    }

    process.stdout.write(`Imported session: ${exportData.info.id}`)
    process.stdout.write(EOL)
  })
})
