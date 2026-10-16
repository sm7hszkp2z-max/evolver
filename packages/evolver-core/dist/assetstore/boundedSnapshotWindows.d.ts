import { type WindowsSnapshotApi } from '../events/boundedAuditWindows.js';
/** Only check(), not AuditBudget: the source's absolute deadline must not be reset or capped to 500ms. */
interface Budget {
    check(): void;
}
export interface SnapshotFile {
    stat(): Promise<{
        state: string;
        size: bigint;
    }>;
    read(buffer: Buffer): Promise<number>;
    close(): Promise<void>;
}
/** One snapshot owns all ancestors until final verification/cleanup. Every descent uses
 * FILE_OPEN relative to a retained no-share-delete directory HANDLE. File reads allow
 * concurrent writers, detected by full HANDLE metadata before/after and by named reopen
 * during the outer cross-file verify. No Node lstat/fstat identity is mixed into this path.
 * An aborted in-flight open/read is awaited by the detached outer task, then cleaned up;
 * no new work is submitted after check() observes cancellation.
 */
export declare class WindowsSnapshotReader {
    private readonly budget;
    private readonly api;
    private readonly retained;
    private readonly acquisitions;
    private readonly directories;
    private closing;
    private closed;
    constructor(budget: Budget, api?: WindowsSnapshotApi);
    private check;
    private own;
    private cleanupError;
    private acquire;
    private acquireOwned;
    private checked;
    private validate;
    private child;
    private current;
    private parts;
    private directory;
    stat(path: string, directory?: boolean): Promise<string>;
    open(path: string): Promise<SnapshotFile | undefined>;
    private release;
    close(): Promise<void>;
}
export {};