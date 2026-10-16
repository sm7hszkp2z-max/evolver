export interface ProtectedAuditStartupOwner {
    assert(): void;
    release(): void;
}
/** A permanent private inode with a kernel lock, never stale-lock deletion or PID guessing. */
export declare function acquireProtectedAuditStartupOwner(socketPath: string, serviceUid: number): ProtectedAuditStartupOwner;