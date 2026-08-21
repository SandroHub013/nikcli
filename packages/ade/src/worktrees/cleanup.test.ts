import { describe, expect, test } from "bun:test";
import { describeSpace, planCleanup } from "./cleanup";
import type { Occupant, Worktree } from "./model";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const PROJECT = "/repo/alpha";

function occupant(state: Occupant["state"], sessionId: string): Occupant {
  return { sessionId, agentId: "agy", state };
}

function makeTree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-1",
    projectId: "proj-alpha",
    name: "sessione",
    path: "/repo/.ade-trees/sessione",
    branch: "agente/sessione",
    ahead: 0,
    behind: 0,
    dirty: 0,
    occupants: [],
    // Two days idle: past the default threshold without any custom input.
    updatedAt: NOW - 48 * HOUR,
    ...overrides,
  };
}

describe("planCleanup", () => {
  test("a clean, idle, unoccupied tree is removable and produces remove + prune", () => {
    const tree = makeTree();
    const plan = planCleanup({ trees: [tree], projectPath: PROJECT, now: NOW });

    expect(plan.candidates[0].removable).toBe(true);
    expect(plan.candidates[0].keep).toBeUndefined();
    expect(plan.candidates[0].idleFor).toBe(48 * HOUR);
    expect(plan.steps).toEqual([
      { args: ["worktree", "remove", tree.path], about: expect.any(String) },
      { args: ["worktree", "prune"], about: expect.any(String) },
    ]);
  });

  test("a working or waiting agent keeps its tree", () => {
    for (const state of ["working", "waiting"] as const) {
      const tree = makeTree({ occupants: [occupant(state, "s1")] });
      const plan = planCleanup({
        trees: [tree],
        projectPath: PROJECT,
        now: NOW,
      });

      expect(plan.candidates[0].keep).toBe("occupato");
      expect(plan.candidates[0].removable).toBe(false);
      expect(plan.steps).toEqual([]);
    }
  });

  /*
   * The distinction the rest of the package already makes: a stopped agent has
   * terminated its process and cannot race anyone, so it must not keep a dead
   * checkout alive. This is exactly the case cleanup exists for — trees left
   * behind by sessions that ended days ago.
   */
  test("a stopped occupant does not keep the tree alive", () => {
    const tree = makeTree({ occupants: [occupant("stopped", "s1")] });
    const plan = planCleanup({ trees: [tree], projectPath: PROJECT, now: NOW });

    expect(plan.candidates[0].keep).toBeUndefined();
    expect(plan.candidates[0].removable).toBe(true);
    expect(plan.steps.map((step) => step.args)).toContainEqual([
      "worktree",
      "remove",
      tree.path,
    ]);
  });

  test("unsaved changes keep the tree", () => {
    const plan = planCleanup({
      trees: [makeTree({ dirty: 3 })],
      projectPath: PROJECT,
      now: NOW,
    });

    expect(plan.candidates[0].keep).toBe("modifiche non salvate");
    expect(plan.candidates[0].removable).toBe(false);
  });

  test("commits that exist only here keep the tree", () => {
    const plan = planCleanup({
      trees: [makeTree({ ahead: 2 })],
      projectPath: PROJECT,
      now: NOW,
    });

    expect(plan.candidates[0].keep).toBe("commit non integrati");
    expect(plan.candidates[0].removable).toBe(false);
  });

  test("the project directory is never removable, whatever else is true of it", () => {
    const project = makeTree({
      name: "principale",
      path: PROJECT,
      branch: "main",
      occupants: [occupant("working", "s1")],
      dirty: 2,
      ahead: 1,
    });
    const plan = planCleanup({
      trees: [project],
      projectPath: PROJECT,
      now: NOW,
    });

    expect(plan.candidates[0].keep).toBe("è il progetto");
    expect(plan.candidates[0].removable).toBe(false);
    expect(plan.steps).toEqual([]);
  });

  test("a tree idle for less than the threshold waits, without being accused of anything", () => {
    const tree = makeTree({ updatedAt: NOW - HOUR });
    const plan = planCleanup({ trees: [tree], projectPath: PROJECT, now: NOW });

    // Recency is not one of the four hard reasons: `idleFor` tells the caller why.
    expect(plan.candidates[0].removable).toBe(false);
    expect(plan.candidates[0].keep).toBeUndefined();
    expect(plan.candidates[0].idleFor).toBe(HOUR);
    // Nothing to remove, so no prune either.
    expect(plan.steps).toEqual([]);
  });

  test("the idle threshold is overridable", () => {
    const fresh = makeTree({ updatedAt: NOW - 15 * 60 * 1000 });
    const settled = makeTree({
      id: "wt-2",
      path: "/repo/.ade-trees/altro",
      updatedAt: NOW - 45 * 60 * 1000,
    });
    const minIdleMs = 30 * 60 * 1000;
    const plan = planCleanup({
      trees: [fresh, settled],
      projectPath: PROJECT,
      now: NOW,
      minIdleMs,
    });

    expect(plan.candidates[0].removable).toBe(false);
    expect(plan.candidates[1].removable).toBe(true);
  });

  test("idle time never goes negative when timestamps disagree with the clock", () => {
    const plan = planCleanup({
      trees: [makeTree({ updatedAt: NOW + HOUR })],
      projectPath: PROJECT,
      now: NOW,
    });

    expect(plan.candidates[0].idleFor).toBe(0);
    expect(plan.candidates[0].removable).toBe(false);
  });

  test("one prune at the end, after every removal", () => {
    const kept = makeTree({ dirty: 1 });
    const goneA = makeTree({ id: "wt-2", path: "/repo/.ade-trees/a" });
    const goneB = makeTree({ id: "wt-3", path: "/repo/.ade-trees/b" });
    const plan = planCleanup({
      trees: [kept, goneA, goneB],
      projectPath: PROJECT,
      now: NOW,
    });

    expect(plan.steps.map((step) => step.args)).toEqual([
      ["worktree", "remove", goneA.path],
      ["worktree", "remove", goneB.path],
      ["worktree", "prune"],
    ]);
  });

  test("no step ever contains --force, in any mix of trees or thresholds", () => {
    const trees = [
      makeTree(),
      makeTree({ occupants: [occupant("working", "s1")] }),
      makeTree({ occupants: [occupant("waiting", "s2")] }),
      makeTree({ occupants: [occupant("stopped", "s3")] }),
      makeTree({ dirty: 4 }),
      makeTree({ ahead: 2 }),
      makeTree({ name: "principale", path: PROJECT, branch: "main" }),
      makeTree({ updatedAt: NOW - HOUR }),
    ];
    for (const minIdleMs of [undefined, 0, HOUR]) {
      const plan = planCleanup({
        trees,
        projectPath: PROJECT,
        now: NOW,
        minIdleMs,
      });
      expect(plan.steps.length).toBeGreaterThan(0);
      for (const step of plan.steps) {
        expect(step.args).not.toContain("--force");
        expect(step.args).not.toContain("-f");
      }
    }
  });

  test("an empty set of trees gives an empty plan", () => {
    const plan = planCleanup({ trees: [], projectPath: PROJECT, now: NOW });

    expect(plan.candidates).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toBe("Nessun albero da valutare.");
  });
});

describe("planCleanup summaries", () => {
  test("counts what goes and names why the rest stays", () => {
    const trees = [
      makeTree({ id: "wt-1", path: "/repo/.ade-trees/a" }),
      makeTree({ id: "wt-2", occupants: [occupant("working", "s1")] }),
      makeTree({ id: "wt-3", dirty: 1 }),
      makeTree({ id: "wt-4", ahead: 3 }),
      makeTree({
        id: "wt-5",
        path: "/repo/.ade-trees/b",
        occupants: [occupant("stopped", "s2")],
      }),
    ];
    const plan = planCleanup({ trees, projectPath: PROJECT, now: NOW });

    expect(plan.summary).toBe(
      "2 dei 5 alberi possono essere rimossi; gli altri 3 restano: " +
        "1 occupato, 1 con modifiche non salvate, 1 con commit non integrati.",
    );
  });

  test("names the directory of the project among what stays", () => {
    const trees = [
      makeTree({ name: "principale", path: PROJECT, branch: "main" }),
      makeTree({ id: "wt-2", path: "/repo/.ade-trees/a" }),
    ];
    const plan = planCleanup({ trees, projectPath: PROJECT, now: NOW });

    expect(plan.summary).toBe(
      "1 dei 2 alberi può essere rimosso; l'altro resta: 1 è la directory del progetto.",
    );
  });

  test("a tree held back only by its recency says so", () => {
    const trees = [
      makeTree(),
      makeTree({
        id: "wt-2",
        path: "/repo/.ade-trees/b",
        updatedAt: NOW - HOUR,
      }),
    ];
    const plan = planCleanup({ trees, projectPath: PROJECT, now: NOW });

    expect(plan.summary).toBe(
      "1 dei 2 alberi può essere rimosso; l'altro resta: 1 fermo da meno di 24 ore.",
    );
  });

  test("when nothing can go, the sentence says so outright", () => {
    const trees = [
      makeTree({ dirty: 1 }),
      makeTree({ ahead: 1, path: "/repo/.ade-trees/b" }),
    ];
    const plan = planCleanup({ trees, projectPath: PROJECT, now: NOW });

    expect(plan.summary).toBe(
      "Nessuno dei 2 alberi si può togliere: 1 con modifiche non salvate, 1 con commit non integrati.",
    );
  });

  test("when everything can go, there is nothing left to explain", () => {
    const trees = [
      makeTree(),
      makeTree({ id: "wt-2", path: "/repo/.ade-trees/b" }),
    ];
    const plan = planCleanup({ trees, projectPath: PROJECT, now: NOW });

    expect(plan.summary).toBe("2 alberi: tutti possono essere rimossi.");
  });
});

describe("describeSpace", () => {
  test("bytes stay bytes", () => {
    expect(describeSpace(0)).toBe("0 B");
    expect(describeSpace(500)).toBe("500 B");
  });

  test("round kilobytes carry no decimal comma", () => {
    expect(describeSpace(1024)).toBe("1 KB");
    expect(describeSpace(839680)).toBe("820 KB");
  });

  test("fractions use one decimal and the Italian comma", () => {
    expect(describeSpace(13107200)).toBe("12,5 MB");
    expect(describeSpace(1503238554)).toBe("1,4 GB");
  });

  test("caps at terabytes instead of inventing units", () => {
    expect(describeSpace(3298534883328)).toBe("3 TB");
  });

  test("sizes that make no sense collapse to zero rather than throwing", () => {
    expect(describeSpace(-5)).toBe("0 B");
    expect(describeSpace(Number.NaN)).toBe("0 B");
  });
});
