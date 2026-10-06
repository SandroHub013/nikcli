/**
 * The conversion of the lessons, run by hand when a YAML changes: `bun run scripts/learn-content.ts`.
 *
 * It writes `src/nikverse/learn/content.json`, the only file the lesson page is served. Nothing else happens here: the schema of a
 * lesson is `learn/schema.json` and `learn/content.test.ts` decides whether what came out is any good, so a bad lesson fails the test
 * and not the writer.
 */
import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { convert, lessonFiles, toJson } from "../src/nikverse/learn/content-build"

const root = resolve(import.meta.dirname, "../src/nikverse/learn")
const lessons = root + "/lezzioni"
const target = `${root}/content.json`

try {
  const files = lessonFiles(lessons)
  const content = convert(lessons)
  writeFileSync(target, toJson(content))
  const exercises = content.percorsi.reduce(
    (sum, percorso) => sum + percorso.lezioni.reduce((n, lesson) => n + (lesson.esercizi as unknown[]).length, 0),
    0,
  )
  console.log(`content.json: ${files.length} lezioni, ${exercises} esercizi, da ${files[0] ?? "-"} a ${files.at(-1) ?? "-"}`)
  const { convertGioco, giocoFiles, toGiocoJson } = await import("../src/nikverse/learn/gioco-build")
  const giocoDir = root + "/gioco"
  const gFiles = giocoFiles(giocoDir)
  const gContent = convertGioco(giocoDir)
  writeFileSync(`${root}/gioco.json`, toGiocoJson(gContent))
  console.log(`gioco.json: ${gFiles.length} livelli, da ${gFiles[0] ?? "-"} a ${gFiles.at(-1) ?? "-"}`)
} catch (error) {
  console.error(`learn-content: ${(error as Error).message}`)
  process.exit(1)
}