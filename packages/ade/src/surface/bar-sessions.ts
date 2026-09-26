/**
 * How many sessions the top bar says the open project has.
 *
 * It used to count every grid pane that is not a panel, of every project, and
 * nothing of the Chat: with one conversation in the Chat and no terminal the
 * bar said «0 sessioni» (chat-bot-facili, prove). A session is an agent pane
 * of this project or a conversation the Chat started in it. The Chat's
 * conversations are read from its store, which outlives the section: the bar
 * counts them while the Chat is closed too.
 */

import { isOpenOn } from "../chat/first-use"
import { sessionEntries } from "../chat/sessions"
import type { ChatState } from "../chat/store"
import { belongsTo, type ProjectRef } from "./pane-project"
import { isPanelPane, type Pane } from "./state"

export type BarPane = Pick<
  Pane,
  "mode" | "browserUrl" | "filePath" | "videoPath" | "modelPath" | "appUrl" | "plugin" | "workspaceId" | "projectRoot"
>

export function barSessionCount(
  panes: readonly BarPane[],
  project: ProjectRef | undefined,
  chat: { readonly state: Pick<ChatState, "directory" | "status" | "data"> },
): number {
  const agents = panes.filter((pane) => !isPanelPane(pane) && (!project || belongsTo(pane, project))).length
  // Only the conversations the Chat started: a terminal's nikcli session is
  // listed there too, and its pane is already counted above.
  const conversations =
    project && isOpenOn(chat, project.root)
      ? sessionEntries(chat.state.data, chat.state.directory).filter((entry) => entry.chat).length
      : 0
  return agents + conversations
}
