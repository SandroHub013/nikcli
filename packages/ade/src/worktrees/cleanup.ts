/**
 * Clearing out worktrees nobody uses anymore.
 *
 * Every session gets its own checkout under `.ade-trees/`, and until now
 * nothing ever took them back: after a week of work the folder holds dozens of
 * full copies of the repository, and the user notices when the disk fills up.
 *
 * This module is the model for the cleanup, not its execution: it decides
 * which trees can go and produces the exact git commands, so a caller can show
 * the whole plan before anything runs. The rule underneath everything is that
 * work must never be removed unless it exists somewhere else. A tree is only
 * removable when nothing holds it (no active occupant), it is clean, every
 * commit it has is already upstream, and it has been idle long enough that
 * removing it cannot interrupt anyone mid-turn.
 *
 * Like the rest of the package, removal never uses `--force`: if git refuses
 * to drop a tree, it has a reason — unmerged state, locks, a path gone stale —
 * and the user needs to be able to read that reason instead of watching the
 * command bulldoze through it.
 */
import { isHolding } from "./model";
import type { Worktree } from "./model";

export type KeepReason =
  | "occupato"
  | "modifiche non salvate"
  | "commit non integrati"
  | "è il progetto";

export interface CleanupCandidate {
  tree: Worktree;
  /** Vero quando l'albero può essere rimosso senza perdere niente. */
  removable: boolean;
  /** Perché va tenuto, quando va tenuto. */
  keep?: KeepReason;
  /** Da quanto tempo non viene toccato, in millisecondi. */
  idleFor: number;
}

export interface CleanupPlan {
  candidates: CleanupCandidate[];
  /** Comandi git da eseguire, in ordine, nella directory del progetto. */
  steps: { args: string[]; about: string }[];
  /** Riassunto in una frase per l'utente. */
  summary: string;
}

/** Un albero fermo da meno di così non si tocca. */
const DEFAULT_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * The first reason that applies, in a fixed order, so the same tree always
 * gets the same label. Identity comes first ("è il progetto" beats anything
 * happening inside it), then what could be lost right now: an active occupant
 * before unsaved changes, unsaved changes before unpushed commits.
 */
function keepReasonFor(
  tree: Worktree,
  projectPath: string,
): KeepReason | undefined {
  if (tree.path === projectPath) return "è il progetto";
  if (tree.occupants.some(isHolding)) return "occupato";
  if (tree.dirty > 0) return "modifiche non salvate";
  if (tree.ahead > 0) return "commit non integrati";
  return undefined;
}

export function planCleanup(input: {
  trees: Worktree[];
  projectPath: string;
  /** Epoca in ms; niente orologi letti dentro. */
  now: number;
  /** Un albero fermo da meno di così non si tocca. Default: 24 ore. */
  minIdleMs?: number;
}): CleanupPlan {
  const minIdleMs = input.minIdleMs ?? DEFAULT_MIN_IDLE_MS;

  const candidates: CleanupCandidate[] = input.trees.map((tree) => {
    // A negative idle time means the caller's clock runs ahead of the tree's
    // own timestamps; clamping keeps "fermo da -3 minuti" out of summaries.
    const idleFor = Math.max(0, input.now - tree.updatedAt);
    const keep = keepReasonFor(tree, input.projectPath);

    // A tree blocked only by recency gets no `keep`: none of the four reasons
    // applies, and `idleFor` already tells the caller why it waits.
    if (keep !== undefined) return { tree, removable: false, keep, idleFor };
    return { tree, removable: idleFor > minIdleMs, idleFor };
  });

  /*
   * One plain remove per removable tree, then a single prune. No `--force`
   * anywhere: on a clean tree `worktree remove` cannot lose work, and when it
   * refuses the refusal is information worth more than the space saved.
   */
  const removable = candidates.filter((candidate) => candidate.removable);
  const steps = removable.map((candidate) => ({
    args: ["worktree", "remove", candidate.tree.path],
    about: `rimuove l'albero "${candidate.tree.name}", fermo e senza lavoro solo qui`,
  }));
  if (steps.length > 0) {
    steps.push({
      args: ["worktree", "prune"],
      about: "pulisce i riferimenti agli alberi rimossi",
    });
  }

  return {
    candidates,
    steps,
    summary: summarize(input.trees.length, candidates, minIdleMs),
  };
}

/**
 * One sentence instead of a table: how many trees are in play, how many can go,
 * and why the rest stay, grouped by reason.
 */
function summarize(
  total: number,
  candidates: CleanupCandidate[],
  minIdleMs: number,
): string {
  if (total === 0) return "Nessun albero da valutare.";

  const kept = candidates.filter((candidate) => !candidate.removable);
  const count = (reason: KeepReason) =>
    kept.filter((candidate) => candidate.keep === reason).length;

  // Trees with no hard reason against them are held back only by the idle
  // threshold; they are counted apart because their reason is a clock, not work.
  const fresh = kept.filter((candidate) => candidate.keep === undefined).length;

  const parts: string[] = [];
  const occupied = count("occupato");
  if (occupied > 0)
    parts.push(`${occupied} occupat${occupied === 1 ? "o" : "i"}`);
  const dirty = count("modifiche non salvate");
  if (dirty > 0) parts.push(`${dirty} con modifiche non salvate`);
  const ahead = count("commit non integrati");
  if (ahead > 0) parts.push(`${ahead} con commit non integrati`);
  const project = count("è il progetto");
  if (project > 0)
    parts.push(
      `${project} ${project === 1 ? "è" : "sono"} la directory del progetto`,
    );
  if (fresh > 0)
    parts.push(
      `${fresh} ferm${fresh === 1 ? "o" : "i"} da meno di ${describeDuration(minIdleMs)}`,
    );

  const removableCount = total - kept.length;
  if (removableCount === 0) {
    // "Nessuno dei 1 alberi" non è italiano: il caso solitario merita una frase sua.
    if (total === 1)
      return `L'unico albero non si può togliere: ${parts.join(", ")}.`;
    return `Nessuno dei ${total} alberi si può togliere: ${parts.join(", ")}.`;
  }

  const verb = removableCount === 1 ? "può" : "possono";
  // "Alberi" è sempre plurale, quindi l'articolo partitivo resta "dei";
  // il participio invece si accorda con il numero degli alberi rimossi.
  const removed = removableCount === 1 ? "rimosso" : "rimossi";
  if (kept.length === 0) {
    return `${total} alber${total === 1 ? "o" : "i"}: tutt${total === 1 ? "o" : "i"} ${verb} essere ${removed}.`;
  }
  return (
    `${removableCount} dei ${total} alberi ${verb} essere ${removed}; ` +
    `${kept.length === 1 ? "l'altro resta" : `gli altri ${kept.length} restano`}: ${parts.join(", ")}.`
  );
}

/** Human words for an idle threshold, used only in the summary. */
function describeDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) return `${Math.round(hours)} ore`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return `${minutes} minut${minutes === 1 ? "o" : "i"}`;
}

/**
 * Byte occupati, quando il chiamante li conosce; puro, solo formattazione.
 *
 * Una cifra sola di decimale, virgola come separatore (convenzione italiana),
 * e nessun ",0" quando il numero è tondo: "820 KB", non "820,0 KB".
 */
export function describeSpace(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  // Round before formatting so a value like 1023,97 KB shows as "1024 KB"
  // rather than lying by one decimal about which unit it belongs to.
  const [integerPart, decimalPart] = value.toFixed(1).split(".");
  const number =
    decimalPart === "0" ? integerPart : `${integerPart},${decimalPart}`;
  return `${number} ${units[unit]}`;
}
