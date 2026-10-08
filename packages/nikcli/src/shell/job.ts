import { dlopen, FFIType, type Pointer } from "bun:ffi"

/**
 * A Windows Job Object, through kernel32.
 *
 * `taskkill /t` follows the chain of parent PIDs, so a process whose parent is gone, or one a shell started in the background and left,
 * is not stopped with the command. A job holds every process the command ever started, whoever their parent is, and
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ends them all when the last handle closes: also when nikcli exits or crashes, because the handle
 * dies with the process.
 */
export namespace ProcessJob {
  /** A job handle: `bun:ffi` hands the HANDLE back as a pointer value. */
  export type Handle = Pointer | bigint

  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
  const JobObjectBasicAccountingInformation = 1
  const JobObjectExtendedLimitInformation = 9
  // PROCESS_TERMINATE | PROCESS_SET_QUOTA: what AssignProcessToJobObject needs on the process.
  const PROCESS_ASSIGN = 0x0001 | 0x0100

  type Kernel32 = ReturnType<typeof load>

  function load() {
    return dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      QueryInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    })
  }

  let api: Kernel32 | null | undefined
  let reason: string | undefined

  function kernel() {
    if (api !== undefined) return api
    if (process.platform !== "win32") return (api = null)
    try {
      api = load()
    } catch (error) {
      api = null
      reason = error instanceof Error ? error.message : String(error)
    }
    return api
  }

  /** Why the job API could not be loaded, if it could not. */
  export function unavailable(): string | undefined {
    kernel()
    return reason
  }

  /** A new job that kills what is in it when its last handle closes, or nothing if Windows (or `bun:ffi`) refuses. */
  export function create(): Handle | undefined {
    const k = kernel()
    if (!k) return undefined
    const job = k.symbols.CreateJobObjectW(null, null)
    if (!job) return undefined
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags is the DWORD at offset 16 of its basic part.
    const info = new Uint8Array(144)
    new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
    if (!k.symbols.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.byteLength)) {
      k.symbols.CloseHandle(job)
      return undefined
    }
    return job
  }

  /** Puts the process in the job. Whatever it starts from now on joins the job; what it started before does not. */
  export function assign(job: Handle, pid: number): boolean {
    const k = kernel()
    if (!k) return false
    const process = k.symbols.OpenProcess(PROCESS_ASSIGN, 0, pid)
    if (!process) return false
    try {
      return k.symbols.AssignProcessToJobObject(job, process) !== 0
    } finally {
      k.symbols.CloseHandle(process)
    }
  }

  /** Ends every process in the job. */
  export function terminate(job: Handle): boolean {
    const k = kernel()
    return !!k && k.symbols.TerminateJobObject(job, 1) !== 0
  }

  /** How many processes are still running in the job, or undefined if it cannot be asked. */
  export function active(job: Handle): number | undefined {
    const k = kernel()
    if (!k) return undefined
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four 8-byte times, then page faults, total, ACTIVE, terminated (4 bytes each).
    const info = new Uint8Array(48)
    if (!k.symbols.QueryInformationJobObject(job, JobObjectBasicAccountingInformation, info, info.byteLength, null)) {
      return undefined
    }
    return new DataView(info.buffer).getUint32(40, true)
  }

  /** Closes the handle: whatever is still in the job is ended with it. */
  export function close(job: Handle): void {
    kernel()?.symbols.CloseHandle(job)
  }

  /** Lets go of the job without ending what is in it: the kill-on-close flag is cleared, then the handle closed. */
  export function release(job: Handle): void {
    const k = kernel()
    if (!k) return
    const info = new Uint8Array(144)
    k.symbols.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.byteLength)
    k.symbols.CloseHandle(job)
  }
}
