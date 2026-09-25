import { describe, expect, test } from "bun:test"
import { localAccountStore, memoryAccountStore, parseAccount, ACCOUNT_PLAN } from "./account"
import { readAgentFile } from "./nikcli"

describe("l'account di un bot", () => {
  test("il parse è rigoroso: tutto ciò che non è atteso vale abbonamento", () => {
    expect(parseAccount(undefined)).toEqual(ACCOUNT_PLAN)
    expect(parseAccount("plan")).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "boh" })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "key" })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "key", key: 1 })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "key", key: "  " })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "key", key: "lavoro", value: "sk-or-v1-VALORE-FINTO" })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "plan", key: "lavoro" })).toEqual(ACCOUNT_PLAN)
    expect(parseAccount({ mode: "key", key: "lavoro" })).toEqual({ mode: "key", key: "lavoro" })
  })

  test("si salva solo il nome, per percorso", () => {
    const key = `ade.bots.account.test.${Date.now()}`
    const store = localAccountStore(key)
    expect(store.get("C:/bot.md")).toEqual(ACCOUNT_PLAN)
    store.set("C:/bot.md", { mode: "key", key: "lavoro" })
    expect(store.get("C:/bot.md")).toEqual({ mode: "key", key: "lavoro" })
    expect(store.get("C:/altro.md")).toEqual(ACCOUNT_PLAN)
    const raw = localStorage.getItem(key) ?? ""
    expect(raw).toContain("lavoro")
    expect(raw).not.toContain("sk-")
    expect(raw).not.toContain("value")
    store.set("C:/bot.md", { mode: "key", key: "lavoro", value: "segreto" } as unknown as { mode: "key"; key: string })
    expect(store.get("C:/bot.md")).toEqual(ACCOUNT_PLAN)
    localStorage.setItem(key, "{")
    expect(localAccountStore(key).get("C:/bot.md")).toEqual(ACCOUNT_PLAN)
    localStorage.removeItem(key)
  })

  test("un campo account nel frontmatter del bot viene ignorato", () => {
    const file = readAgentFile({
      path: "C:/bot.md",
      scope: "global",
      text: "---\ndescription: uno\nrunner: claude\naccount: key\n---\n\nCiao\n",
    })
    expect(file.runner).toBe("claude")
    expect("account" in file).toBe(false)
    expect(memoryAccountStore().get(file.path)).toEqual(ACCOUNT_PLAN)
  })
})
