/**
 * The app's one store of the bots' money a day (`spend.ts`): the Bots panel's turns and the chats' gateway count
 * through it, and the line «Spesa di oggi» follows both through a signal, as the Memoria section follows
 * `memory-app.ts`.
 */

import { createSignal } from "solid-js"
import { localSpendStore, type SpendStore } from "./spend"

const disk = localSpendStore()
const [writes, setWrites] = createSignal(0)

export const appSpendStore: SpendStore = {
  get: (bot) => {
    writes()
    return disk.get(bot)
  },
  set: (bot, spend) => {
    disk.set(bot, spend)
    setWrites((n) => n + 1)
  },
}
