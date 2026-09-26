import { describe, expect, test } from "bun:test";
import { formatBytes, packView, watchInstall, type InstallProgress } from "./voice-pack";

const MB = 1024 * 1024;

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    provider: "kokoro",
    running: true,
    files_done: 0,
    files_total: 3,
    bytes_done: 0,
    bytes_total: 200 * MB,
    cancelled: false,
    error: null,
    ...overrides,
  };
}

describe("a voice pack as the panel shows it", () => {
  test("a host without the backend offers nothing to press", () => {
    const view = packView({});
    expect(view.phase).toBe("unavailable");
    expect([view.canInstall, view.canCancel, view.canTest, view.canDelete]).toEqual([false, false, false, false]);
  });

  test("not installed: install, with the size the host gives", () => {
    const view = packView({ status: { installed: false, sizeBytes: 192 * MB } });
    expect(view).toMatchObject({ phase: "absent", size: "192 MB", canInstall: true, canTest: false, canDelete: false });
    // No size from the host: no number made up in its place.
    expect(packView({ status: { installed: false } }).size).toBeUndefined();
  });

  test("installing: how far, and cancel once", () => {
    const view = packView({ status: { installed: false, sizeBytes: 192 * MB }, progress: progress({ bytes_done: 50 * MB }) });
    expect(view).toMatchObject({ phase: "installing", percent: 25, bytesDone: "50 MB", bytesTotal: "200 MB", canCancel: true, canInstall: false });
    expect(packView({ status: { installed: false }, progress: progress({ cancelled: true }) }).canCancel).toBe(false);
    // A total not known yet: the bytes, no percentage.
    const unknown = packView({ status: { installed: false }, progress: progress({ bytes_total: null, bytes_done: 3 * MB }) });
    expect(unknown.percent).toBeUndefined();
    expect(unknown.bytesDone).toBe("3 MB");
    // The panel's own install counts before the first progress arrives.
    expect(packView({ status: { installed: false }, busy: "install" }).phase).toBe("installing");
  });

  test("an install that stopped says why, and may be tried again; a cancel is not a failure", () => {
    const failed = packView({ status: { installed: false }, progress: progress({ running: false, error: "Il file scaricato non corrisponde a quello atteso: scartato." }) });
    expect(failed).toMatchObject({ phase: "absent", canInstall: true });
    expect(failed.error).toContain("non corrisponde");
    const cancelled = packView({ status: { installed: false }, progress: progress({ running: false, cancelled: true, error: "Installazione annullata." }) });
    expect(cancelled.error).toBeUndefined();
  });

  test("installed: test and delete, not while deleting", () => {
    expect(packView({ status: { installed: true } })).toMatchObject({ phase: "installed", canTest: true, canDelete: true, canInstall: false });
    expect(packView({ status: { installed: true }, busy: "delete" })).toMatchObject({ canTest: false, canDelete: false });
  });

  test("sizes in whole megabytes, kilobytes under one", () => {
    expect(formatBytes(163.5 * MB)).toBe("164 MB");
    expect(formatBytes(28.2 * MB)).toBe("28 MB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(-1)).toBe("0 MB");
  });
});

describe("watching an install", () => {
  function fakeTimers() {
    const queue: (() => void)[] = [];
    return {
      timers: { set: (run: () => void) => queue.push(run), clear: () => queue.splice(0) },
      next: async () => {
        queue.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
      },
      pending: () => queue.length,
    };
  }

  test("asks until stopped, and a failed read is only skipped", async () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    let n = 0;
    const stop = watchInstall(
      async () => {
        n++;
        if (n === 2) throw new Error("non risponde");
        return progress({ bytes_done: n });
      },
      (p) => seen.push(p.bytes_done),
      400,
      clock.timers,
    );
    await Promise.resolve();
    await Promise.resolve();
    await clock.next();
    await clock.next();
    expect(seen).toEqual([1, 3]);
    stop();
    expect(clock.pending()).toBe(0);
    await clock.next();
    expect(seen).toEqual([1, 3]);
  });
});
