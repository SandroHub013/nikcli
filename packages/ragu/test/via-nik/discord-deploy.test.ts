import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: the Discord bot stays (ragu imports it: the /discord wizard sets up the user's
 * own bot), but its Cloudflare Worker deployed to discord.nikcli-ai.dev on Nik's zone and forwarded prompts to Nik's
 * Railway host. The Worker now deploys on the user's workers.dev, RAGU_URL is a secret the user sets, and the README
 * shows the user's own endpoint.
 */
const DISCORD = path.join(import.meta.dir, "../../../discord")
const read = (file: string) => fs.readFileSync(path.join(DISCORD, file), "utf8")
const NIK = /nikcli-ai\.dev|nikcli\.store|nikcli-mobile-production/

describe("the Discord Worker deploys for its user, not for Nik", () => {
  test("wrangler.toml has no Nik domain and no Nik host", () => {
    const toml = read("wrangler.toml")
    expect(toml).not.toMatch(NIK)
    expect(toml).toContain("workers_dev = true")
    expect(toml).not.toMatch(/^RAGU_URL\s*=/m)
  })

  test("the README shows the user's own endpoint", () => {
    expect(read("README.md")).not.toMatch(NIK)
  })
})
