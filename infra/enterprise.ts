import { SECRET } from "./secret"
import { shortDomain } from "./stage"

const storage = new sst.cloudflare.Bucket("EnterpriseStorage")

const teams = new sst.cloudflare.x.SolidStart("Teams", {
  domain: shortDomain,
  path: "packages/enterprise",
  buildCommand: "bun run build:cloudflare",
  environment: {
    RAGU_STORAGE_ADAPTER: "r2",
    RAGU_STORAGE_ACCOUNT_ID: sst.cloudflare.DEFAULT_ACCOUNT_ID,
    RAGU_STORAGE_ACCESS_KEY_ID: SECRET.R2AccessKey.value,
    RAGU_STORAGE_SECRET_ACCESS_KEY: SECRET.R2SecretKey.value,
    RAGU_STORAGE_BUCKET: storage.name,
  },
})
