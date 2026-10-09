// The first import of the entry: the NIKCLI_* settings become RAGU_* before any module reads the environment.
import { adoptLegacyEnv } from "./legacy-env"

adoptLegacyEnv(process.env)
