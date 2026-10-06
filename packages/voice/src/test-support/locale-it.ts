/*
 * Preloaded for every test of the package: the texts the engine writes are checked in Italian, so the language is pinned
 * here and not read from the machine that runs the tests (Bun reports the OS's: «en-US» on most CI runners).
 * A test that wants English says so with `resetLocaleForTests("en")` and puts it back.
 */
import { resetLocaleForTests } from "@nikcli-ai/ade/i18n"

resetLocaleForTests("it")
