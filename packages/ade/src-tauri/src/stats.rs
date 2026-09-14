//! What the machine is spending, for the strip at the foot of the sidebar.
//!
//! Three numbers: the CPU in use across all cores, the RAM in use on the
//! machine, and the memory ADE itself holds — the app, its webview and every
//! agent it started, because those are what a user closes panes to get back.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// One `System` for the life of the app: CPU usage is a difference between
/// two refreshes, so a fresh instance per call would always read zero.
pub struct Stats(pub Mutex<System>);

impl Stats {
    pub fn new() -> Self {
        Stats(Mutex::new(System::new()))
    }
}

/// Only ADE: this process and everything it started — the webview, the
/// agents in the panes, their own children. The machine's totals appear
/// only as the denominator for the percentages.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// CPU used by ADE's processes, 0–100 of the whole machine's capacity.
    cpu: f32,
    /// Resident memory of ADE's processes, in bytes.
    app_mem: u64,
    /// The machine's RAM, in bytes — what `app_mem` is a share of.
    ram_total: u64,
    /// How many processes belong to ADE right now.
    processes: u32,
}

#[tauri::command]
pub fn system_stats(stats: tauri::State<'_, Stats>) -> Result<SystemStats, String> {
    let mut sys = stats.0.lock().map_err(|_| "statistiche bloccate")?;
    sys.refresh_memory();
    // Per-process CPU is a difference between this refresh and the previous
    // one, which is why the `System` lives in managed state.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );

    let me = Pid::from_u32(std::process::id());
    let mut cpu = 0.0_f32;
    let mut app_mem = 0_u64;
    let mut processes = 0_u32;
    for process in sys.processes().values() {
        if !descends_from(&sys, process.pid(), me) {
            continue;
        }
        cpu += process.cpu_usage();
        app_mem += process.memory();
        processes += 1;
    }

    // `cpu_usage` is per core: a process saturating two cores reads 200.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;

    Ok(SystemStats {
        cpu: (cpu / cores).clamp(0.0, 100.0),
        app_mem,
        ram_total: sys.total_memory(),
        processes,
    })
}

/// True for `root` itself and anything started under it, however deep.
fn descends_from(sys: &System, pid: Pid, root: Pid) -> bool {
    let mut current = Some(pid);
    // Bounded: a pid reused by an unrelated process can make a parent chain
    // loop, and a loop here would hang the command.
    for _ in 0..64 {
        match current {
            Some(p) if p == root => return true,
            Some(p) => current = sys.process(p).and_then(|process| process.parent()),
            None => return false,
        }
    }
    false
}
