import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (Master, after the first round): the release check in CI and the serve image
 * fell back to Nik's Railway service, nikcli-mobile-production.up.railway.app. Without a configured health URL the CI
 * check now fails (check-release-identity.ts already refuses an empty URL), and the image passes --public-url only when
 * Railway gives it a domain.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("no fallback to Nik's Railway host", () => {
  test("the CI release check takes its URL from the repository's variables only", () => {
    const yml = read(".github/workflows/ci-pipeline.yml")
    expect(yml).not.toContain("nikcli-mobile-production")
    expect(yml).toContain("RAGU_HEALTH_URL: ${{ vars.RAILWAY_HEALTH_URL }}")
  })

  test("the serve image names a public URL only when Railway provides a domain", () => {
    const docker = read("Dockerfile.serve")
    expect(docker).not.toContain("nikcli-mobile-production")
    expect(docker).toContain("${RAILWAY_PUBLIC_DOMAIN:+--public-url https://$RAILWAY_PUBLIC_DOMAIN}")
  })
})
