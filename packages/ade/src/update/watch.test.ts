import { expect, test } from "bun:test"
import { checkOnce } from "./watch"

const releases = async () => [
  {
    tag_name: "ade-v1.1.0",
    html_url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.1.0",
    draft: false,
    prerelease: false,
  },
]

test("a new version is announced once per run", async () => {
  const announced = new Set<string>()
  const options = { currentVersion: async () => "1.0.0", onUpdate: () => {}, fetchReleases: releases }
  expect((await checkOnce(options, announced))?.version).toBe("1.1.0")
  expect(await checkOnce(options, announced)).toBeUndefined()
})

test("an up-to-date build hears nothing", async () => {
  const options = { currentVersion: async () => "1.1.0", onUpdate: () => {}, fetchReleases: releases }
  expect(await checkOnce(options, new Set())).toBeUndefined()
})
