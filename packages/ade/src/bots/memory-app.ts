/**
 * The app's one store of the bots' memory (B8a): the Bots panel and the
 * chats' gateway write through it, and the Memoria section follows both,
 * through a signal. Two stores over the same storage would each save, and
 * the section would not see what a chat proposed until it was reopened.
 */

import { createSignal } from "solid-js"
import { localMemoryStore, type MemoryStore } from "./memory"

const disk = localMemoryStore()
const [writes, setWrites] = createSignal(0)

export const appMemoryStore: MemoryStore = {
  get: (bot) => {
    writes()
    return disk.get(bot)
  },
  set: (bot, memory) => {
    disk.set(bot, memory)
    setWrites((n) => n + 1)
  },
}
