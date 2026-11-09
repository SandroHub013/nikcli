import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { forgetBotGateways, offSwitches } from "./off-switches"

function fakes(fail = false) {
  const off: string[] = []
  const revoked: string[] = []
  const commands: string[] = []
  const invoke = async (command: string) => {
    commands.push(command)
    if (fail) throw new Error("portachiavi non disponibile")
    return undefined
  }
  const live = () => ({
    off: (bot: string, platform?: string) => void off.push(`${bot}/${platform ?? "*"}`),
    revoke: (bot: string, platform: string, sender: string) => void revoked.push(`${bot}/${platform}/${sender}`),
  })
  return { off, revoked, commands, invoke, live }
}

describe("every way off reaches the page too (BOT-2)", () => {
  test("switching a gateway off stops what it had queued or running", async () => {
    const f = fakes()
    await offSwitches(f.invoke, f.live).setEnabled("b", "telegram", false)
    expect(f.commands).toEqual(["gateway_set_enabled"])
    expect(f.off).toEqual(["b/telegram"])
  })

  test("switching one on stops nothing", async () => {
    const f = fakes()
    await offSwitches(f.invoke, f.live).setEnabled("b", "telegram", true, "C:/p")
    expect(f.off).toEqual([])
  })

  test("clearing the token stops it, even when the keychain refused: Rust had halted the link already", async () => {
    const ok = fakes()
    await offSwitches(ok.invoke, ok.live).clearToken("b", "telegram")
    expect(ok.off).toEqual(["b/telegram"])
    const refused = fakes(true)
    await expect(offSwitches(refused.invoke, refused.live).clearToken("b", "telegram")).rejects.toThrow("portachiavi")
    expect(refused.off).toEqual(["b/telegram"])
  })

  test("switching off whose command failed still stops it", async () => {
    const refused = fakes(true)
    await expect(offSwitches(refused.invoke, refused.live).setEnabled("b", "telegram", false)).rejects.toThrow()
    expect(refused.off).toEqual(["b/telegram"])
  })

  test("a revocation reaches the page only once Rust has it", async () => {
    const ok = fakes()
    await offSwitches(ok.invoke, ok.live).pairingRevoke("b", "telegram", "42")
    expect(ok.revoked).toEqual(["b/telegram/42"])
    const refused = fakes(true)
    await expect(offSwitches(refused.invoke, refused.live).pairingRevoke("b", "telegram", "42")).rejects.toThrow()
    expect(refused.revoked).toEqual([])
  })

  test("with no controller listening there is nothing to stop, and the command still goes", async () => {
    const f = fakes()
    await offSwitches(f.invoke, () => undefined).setEnabled("b", "telegram", false)
    expect(f.commands).toEqual(["gateway_set_enabled"])
  })

  test("deleting a bot stops its gateways here, whether or not the keychain let go of the tokens", async () => {
    const ok = fakes()
    let stopped = 0
    await forgetBotGateways(ok.invoke, "b", () => void stopped++)
    expect(ok.commands).toEqual(["gateway_forget_bot"])
    expect(stopped).toBe(1)
    const refused = fakes(true)
    await expect(forgetBotGateways(refused.invoke, "b", () => void stopped++)).rejects.toThrow()
    expect(stopped).toBe(2)
  })

  test("lint: the app's panel API and the deletion of a bot are made of these, and the deletion names the bot", () => {
    const bridge = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8")
    expect(bridge).toContain("...offSwitches(invoke, () => activeController)")
    expect(bridge).not.toContain('"gateway_clear_token"')
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8")
    expect(store).toContain("forgetBotGateways(invoke, bot,")
    expect(store).toContain("switchOffBotGateways(bot)")
  })
})
