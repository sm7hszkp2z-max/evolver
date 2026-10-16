import { util } from '@evomap/evolver-core';
export interface IngestionTelemetry {
    state: 'disabled' | 'unknown' | 'observed' | 'degraded';
    lastTickAt?: number;
    recorded?: number;
    parseFailures?: number;
}
export declare function runtimeOwnerGeneration(owner: util.FileLockOwnerRecord): string;
export declare function autoexecHeartbeatTelemetry(owner: util.FileLockOwnerRecord, lastTickAt: number, lastTickOutcome: 'completed' | 'failed' | 'blocked', heartbeatIntervalMs: number, ingestion: IngestionTelemetry): Record<string, unknown>;