export interface ProtectedAuditReadyPlan {
    readonly version: 1;
    readonly serviceUid: number;
    readonly clientGid: number;
    readonly socketPath: string;
    readonly configSha256: string;
    readonly executableSha256: string;
    readonly timeoutMs: 5000;
}
export interface ProtectedAuditHealth {
    readonly version: 1;
    readonly ready: true;
    readonly serviceUid: number;
    readonly clientGid: number;
    readonly socketPath: string;
    readonly configSha256: string;
    readonly executableSha256: string;
    readonly pid: number;
    readonly processStartedAt: number;
    readonly processNonce: string;
}
export interface ProtectedAuditPublication {
    health?: ProtectedAuditHealth;
}
/** Root-only, bounded, nofollow plan admission independent of unpublished client config. */
export declare function readProtectedAuditReadyPlan(path: string): ProtectedAuditReadyPlan;
export declare function validateProtectedAuditReadyPlan(value: unknown): ProtectedAuditReadyPlan;
/** Captured before listening. A replaced live pathname cannot change this process receipt. */
export declare function captureProtectedAuditHealth(configPath: string, config: {
    serviceUid: number;
    clientGid: number;
    socketPath: string;
}): ProtectedAuditHealth;
export declare function validateProtectedAuditHealth(value: unknown, plan: ProtectedAuditReadyPlan): ProtectedAuditHealth;
/** One read-only request. Settlement waits for this owned socket's actual close. */
export declare function protectedAuditReadyRpc(plan: ProtectedAuditReadyPlan, deadlineAt: number, operationId?: `${string}-${string}-${string}-${string}-${string}`): Promise<ProtectedAuditHealth>;
export declare function runProtectedAuditReady(planPath: string): Promise<void>;