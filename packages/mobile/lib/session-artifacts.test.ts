/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test"
import { extractMessageArtifacts, extractSessionPreviews } from "./session-artifacts"
import type { MessageWithParts } from "./types"

function message(messageId: string, parts: unknown[]): MessageWithParts {
  return {
    info: { id: messageId, sessionID: "ses_test", role: "assistant", time: { created: 1 } },
    parts: parts.map((part, index) => ({
      id: `part_${messageId}_${index}`,
      sessionID: "ses_test",
      messageID: messageId,
      ...(part as object),
    })),
  } as unknown as MessageWithParts
}

/** An `artifact` tool call as an old transcript still holds it: the tool published on Nik's nikcli-ai.dev. */
function publishedArtifact(messageId: string) {
  const url = "https://nikcli-ai.dev/artifact/img"
  return message(messageId, [
    {
      type: "tool",
      callID: `call_${messageId}`,
      tool: "artifact",
      state: {
        status: "completed",
        input: {},
        output: `Published\n${url}`,
        title: "image preview",
        metadata: { id: "img", url, viewerUrl: `${url}?key=view-key`, kind: "image", version: 1 },
        time: { start: 1, end: 2 },
      },
    },
  ])
}

/*
 * Brief ragu-via-servizi-nik, package B: the server no longer publishes artifacts (nor sends a session's
 * `artifacts`), so the app shows none. What the chat itself generates (fenced HTML, SVG, Mermaid, a dev server
 * link) is rendered on the phone and stays.
 */
describe("session previews", () => {
  test("an artifact published on Nik's site, in an old transcript, makes no preview", () => {
    const old = publishedArtifact("msg_old")
    expect(extractSessionPreviews([old], "http://192.168.1.10:4096")).toEqual([])
    expect(extractMessageArtifacts(old)).toEqual([])
  })

  test("what the chat generates is still previewed", () => {
    const generated = message("msg_html", [{ type: "text", text: "Here:\n```html\n<h1>hi</h1>\n```" }])
    const previews = extractSessionPreviews([generated], "http://192.168.1.10:4096")
    expect(previews.map((preview) => preview.kind)).toEqual(["html"])
    expect(extractMessageArtifacts(generated).map((preview) => preview.kind)).toEqual(["html"])
  })
})
