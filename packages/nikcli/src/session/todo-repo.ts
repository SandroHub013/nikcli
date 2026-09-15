import { eq } from "drizzle-orm"
import { Database } from "@/database/database"
import { todoInfo } from "./todo.sql"
import type { Todo } from "./todo"

/**
 * SQL-backed repository for Todo data.
 *
 * Every operation is an Effect whose failure is `Database.QueryError`; the
 * queries underneath stay synchronous. A corrupt `todos` blob reads as an
 * empty list rather than failing, matching the JSON store it replaced.
 */
export namespace TodoRepo {
  export function get(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "TodoRepo.get",
      (db) => {
        const row = db.select().from(todoInfo).where(eq(todoInfo.sessionId, sessionId)).get()
        if (!row) return [] as Todo.Info[]
        try {
          return JSON.parse(row.todos) as Todo.Info[]
        } catch {
          return [] as Todo.Info[]
        }
      },
      executor,
    )
  }

  export function upsert(sessionId: string, todos: Todo.Info[], executor?: Database.TxOrDb) {
    return Database.query(
      "TodoRepo.upsert",
      (db) => {
        db.insert(todoInfo)
          .values({
            sessionId,
            todos: JSON.stringify(todos),
          })
          .onConflictDoUpdate({
            target: todoInfo.sessionId,
            set: {
              todos: JSON.stringify(todos),
            },
          })
          .run()
      },
      executor,
    )
  }

  export function remove(sessionId: string, executor?: Database.TxOrDb) {
    return Database.query(
      "TodoRepo.remove",
      (db) => {
        const result = db.delete(todoInfo).where(eq(todoInfo.sessionId, sessionId)).run()
        return (result as { changes: number }).changes > 0
      },
      executor,
    )
  }
}
