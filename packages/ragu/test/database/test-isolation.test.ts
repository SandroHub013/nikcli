import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { Database } from "../../src/database/database"
import { assertNotARealFolder, realFolderOf } from "../../src/database/test-guard"
import { removeTestDirSync } from "../helpers/fs"

// A made-up "real" user folder inside the temp dir: the real database is never named, let alone opened.
function fakeUser() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ragu-guard-"))
  const localAppData = path.join(root, "user", "AppData", "Local")
  const allowed = path.join(root, "scratch")
  return { root, localAppData, allowed, db: path.join(localAppData, "nikcli", "nikcli.db") }
}

describe("tests never open the user's own database", () => {
  it("keeps the suite's default database inside the temporary test home", () => {
    const filename = Database.path()
    const home = process.env.RAGU_TEST_HOME
    expect(home).toBeTruthy()
    expect(path.resolve(filename).toLowerCase().startsWith(path.resolve(home!).toLowerCase())).toBe(true)
    expect(realFolderOf(filename)).toBeUndefined()
  })

  it("refuses to open a database inside a real user folder, before anything is created", () => {
    const fake = fakeUser()
    try {
      process.env.RAGU_TEST_FORBIDDEN_DIRS = fake.localAppData
      process.env.RAGU_TEST_ALLOWED_DIRS = fake.allowed
      process.env.RAGU_DB = fake.db

      expect(() => Database.rawSql("test/test-isolation")).toThrow("user's real database")

      // The guard runs before the folder is made: without it the file would be created here.
      expect(existsSync(path.dirname(fake.db))).toBe(false)
    } finally {
      removeTestDirSync(fake.root)
    }
  })

  it("names the real folder and what to do about it", () => {
    const fake = fakeUser()
    try {
      const env = {
        RAGU_TEST_MODE: "1",
        RAGU_TEST_FORBIDDEN_DIRS: fake.localAppData,
        RAGU_TEST_ALLOWED_DIRS: fake.allowed,
      }
      expect(() => assertNotARealFolder(fake.db, env)).toThrow(fake.localAppData)
      expect(() => assertNotARealFolder(fake.db, env)).toThrow("RAGU_TEST_HOME")
    } finally {
      removeTestDirSync(fake.root)
    }
  })

  it("lets a test use the temp folder even when it sits inside the forbidden one", () => {
    const fake = fakeUser()
    try {
      const env = {
        RAGU_TEST_MODE: "1",
        RAGU_TEST_FORBIDDEN_DIRS: fake.root,
        RAGU_TEST_ALLOWED_DIRS: fake.allowed,
      }
      expect(realFolderOf(path.join(fake.allowed, "x", "nikcli.db"), env)).toBeUndefined()
      expect(realFolderOf(fake.db, env)).toBeDefined()
    } finally {
      removeTestDirSync(fake.root)
    }
  })

  it("does nothing outside a test run, or for an in-memory database", () => {
    const fake = fakeUser()
    try {
      const forbidden = { RAGU_TEST_FORBIDDEN_DIRS: fake.localAppData, RAGU_TEST_ALLOWED_DIRS: fake.allowed }
      expect(realFolderOf(fake.db, { ...forbidden })).toBeUndefined()
      expect(realFolderOf(":memory:", { ...forbidden, RAGU_TEST_MODE: "1" })).toBeUndefined()
      expect(realFolderOf(fake.db, { ...forbidden, RAGU_TEST_MODE: "1" })).toBeDefined()
    } finally {
      removeTestDirSync(fake.root)
    }
  })
})
