/**
 * A local voice pack as the panel shows it (K6): whether the host can run it,
 * whether it is installed, the install under way, and what may be done next.
 *
 * Kept out of the panel so the rules are tested without a DOM: the panel only
 * draws what `packView` says, and `watchInstall` is the one loop that asks
 * the host how an install is going.
 */

/** The providers the host installs, as `tts_install_status` names them. */
export type LocalProvider = "piper" | "kokoro";

/**
 * `tts_install_status` and the end of `tts_install_cancel`, as Rust sends them:
 * `InstallProgress` in `tts.rs` (K3), field names and all.
 */
export interface InstallProgress {
  readonly provider: string;
  readonly running: boolean;
  readonly files_done: number;
  readonly files_total: number;
  readonly bytes_done: number;
  /** `null` while a file of the install has no size written down. */
  readonly bytes_total?: number | null;
  readonly cancelled: boolean;
  /** Why the last install stopped, in the user's words. */
  readonly error?: string | null;
}

/** What the host says about a pack. */
export interface PackStatus {
  readonly installed: boolean;
  /** Bytes the install downloads, from the host's manifest; absent when it does not say. */
  readonly sizeBytes?: number;
}

export interface PackState {
  /** Undefined: this host has no backend for the pack, or it did not answer. */
  readonly status?: PackStatus;
  readonly progress?: InstallProgress;
  /** What the panel itself started and is waiting on. */
  readonly busy?: "install" | "delete";
  /** A failure the panel was told, besides the install's own. */
  readonly error?: string;
}

export type PackPhase = "unavailable" | "absent" | "installing" | "installed";

export interface PackView {
  readonly phase: PackPhase;
  /** The download, written for people: «192 MB». */
  readonly size?: string;
  /** How far the install is, 0 to 100, when its total is known. */
  readonly percent?: number;
  readonly bytesDone?: string;
  readonly bytesTotal?: string;
  readonly error?: string;
  readonly canInstall: boolean;
  readonly canCancel: boolean;
  readonly canTest: boolean;
  readonly canDelete: boolean;
}

const MB = 1024 * 1024;

/** Bytes as the panel says them: whole megabytes, kilobytes under one. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / MB)} MB`;
}

/** What the panel draws for `state`, and which of its buttons do something. */
export function packView(state: PackState): PackView {
  const none = { canInstall: false, canCancel: false, canTest: false, canDelete: false };
  const status = state.status;
  if (!status) return { phase: "unavailable", ...none };
  const size = status.sizeBytes !== undefined && status.sizeBytes > 0 ? formatBytes(status.sizeBytes) : undefined;
  const progress = state.progress;
  const running = progress?.running === true;
  if (state.busy === "install" || running) {
    const total = progress?.bytes_total ?? undefined;
    const done = progress?.bytes_done ?? 0;
    return {
      phase: "installing",
      ...(size ? { size } : {}),
      ...(total && total > 0 ? { percent: Math.min(100, Math.floor((done / total) * 100)), bytesTotal: formatBytes(total) } : {}),
      bytesDone: formatBytes(done),
      ...none,
      // A cancel already asked for is not asked twice.
      canCancel: !progress?.cancelled,
    };
  }
  // The install's own reason, once it has stopped, or the panel's.
  const error = state.error ?? (progress && !progress.running && !progress.cancelled ? progress.error ?? undefined : undefined);
  if (status.installed) {
    return {
      phase: "installed",
      ...(size ? { size } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...none,
      canTest: state.busy !== "delete",
      canDelete: state.busy !== "delete",
    };
  }
  return {
    phase: "absent",
    ...(size ? { size } : {}),
    ...(error ? { error } : {}),
    ...none,
    canInstall: state.busy !== "delete",
  };
}

export interface InstallWatchTimers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: InstallWatchTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Asks the host how an install is going, every `everyMs`, until stopped: the
 * install command itself only answers at the end. A read that fails is
 * skipped, not the end of the watch; the next one may answer. Returns the stop.
 */
export function watchInstall(
  read: () => Promise<InstallProgress | undefined>,
  onProgress: (progress: InstallProgress) => void,
  everyMs = 400,
  timers: InstallWatchTimers = REAL_TIMERS,
): () => void {
  let stopped = false;
  let handle: unknown;
  const tick = async () => {
    if (stopped) return;
    try {
      const progress = await read();
      if (!stopped && progress) onProgress(progress);
    } catch {
      // The next tick asks again.
    }
    if (!stopped) handle = timers.set(() => void tick(), everyMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (handle !== undefined) timers.clear(handle);
  };
}
