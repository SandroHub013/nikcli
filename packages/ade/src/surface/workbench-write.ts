import { reconcile, unwrap, type SetStoreFunction } from "solid-js/store"
import type { Workbench } from "./state"

/**
 * Applies a whole new workbench to the store, keeping the parts that did not
 * change.
 *
 * The reducers in `state.ts` are pure and return a fresh object; `reconcile`
 * turns that back into the smallest set of writes against the store, keyed by
 * pane id, so replacing the object does not invalidate every pane in it. It
 * also means a nested object such as `fileGoTo` keeps its proxy and has its
 * fields written: whoever holds on to it sees them change.
 */
export function writeWorkbench(
  store: Workbench,
  setStore: SetStoreFunction<Workbench>,
  next: Workbench | ((current: Workbench) => Workbench),
): void {
  const current = unwrap(store)
  const value = typeof next === "function" ? next(current) : next
  if (value !== current) setStore(reconcile(value, { key: "id" }))
}
