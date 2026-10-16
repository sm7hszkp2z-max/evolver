/** A private, fixed-command protocol. The caller trusts only exit of this process
 * as confirmation that an ambiguous close cannot leave a live descriptor. */
export function runPosixSnapshotWorker(): Promise<void>;