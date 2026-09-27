import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import { agentDisplayName } from "./model"

/* Review of chat-chip, b: the agent chip showed nikcli's raw «build». */
describe("an agent as the user reads it", () => {
  test("nikcli's own agents by a name in the user's language", () => {
    expect(agentDisplayName("build")).toBe(t("chat.agent.name.build"))
    expect(agentDisplayName("build")).not.toBe("build")
    expect(agentDisplayName("plan")).toBe(t("chat.agent.name.plan"))
    expect(agentDisplayName("general")).toBe(t("chat.agent.name.general"))
    expect(agentDisplayName("explore")).toBe(t("chat.agent.name.explore"))
  })

  test("an agent of the user's own keeps its name", () => {
    expect(agentDisplayName("revisore")).toBe("revisore")
    expect(agentDisplayName("Build")).toBe("Build")
  })
})
