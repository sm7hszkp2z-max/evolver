import { type BigIntStats } from 'node:fs';
export { runPosixSnapshotWorker } from './boundedSnapshotPosixWorker.js';
export interface PosixSnapshotFile {
    fd: number;
    stat(): Promise<PosixSnapshotStat>;
    read(buffer: Buffer): Promise<number>;
    close(): Promise<void>;
}
export type PosixSnapshotStat = Pick<BigIntStats, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeNs' | 'ctimeNs' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>;
export declare class PosixSnapshotExitConfirmedError extends Error {
    readonly cleanupConfirmed = true;
    constructor(cause: unknown);
}
type WorkerCommand = {
    command: string;
    args: readonly string[];
};
/** The CLI registers its own entrypoint so a Bun single-file executable starts
 * the same embedded worker. Library callers use the copied package worker file. */
export declare function configurePosixSnapshotWorkerCommand(command: WorkerCommand | undefined): void;
/** No descriptor exists in this process. A failed close poisons the child and
 * blocks admission until its actual exit confirms kernel-wide fd cleanup. */
export declare class PosixSnapshotProcess {
    private readonly firstIpcDiagnostic;
    private readonly bootstrapDiagnostic;
    private nativeDiagnostic;
    private lstatDiagnostic;
    private diagnosticInput;
    private diagnosticBytes;
    private readonly diagnosticMarkers;
    private readonly child;
    private readonly finished;
    private readonly pending;
    private serial;
    private response;
    private nextId;
    private exited;
    private closed;
    private closing;
    private closeFailure;
    private readonly abort;
    constructor(signal: AbortSignal, override?: WorkerCommand);
    private diagnostic;
    private poison;
    private request;
    lstat(path: string): Promise<PosixSnapshotStat | null>;
    private owned;
    openRoot(path: string): Promise<PosixSnapshotFile>;
    openChild(parent: number, name: string, directory?: boolean): Promise<PosixSnapshotFile>;
    terminate(): Promise<void>;
    private terminateBefore;
    close(): Promise<void>;
}