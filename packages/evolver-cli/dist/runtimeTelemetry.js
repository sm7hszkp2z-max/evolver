import { createHash } from 'node:crypto';
import { util } from '@evomap/evolver-core';
export function runtimeOwnerGeneration(owner) {
    return createHash('sha256').update(util.serializeFileLockOwnerRecord(owner)).digest('hex');
}
export function autoexecHeartbeatTelemetry(owner, lastTickAt, lastTickOutcome, heartbeatIntervalMs, ingestion) {
    return {
        pid: owner.pid,
        generation: runtimeOwnerGeneration(owner),
        processStartIdentity: owner.processStartIdentity,
        lastTickAt,
        lastTickOutcome,
        ...(Number.isSafeInteger(heartbeatIntervalMs) && heartbeatIntervalMs >= 0 ? { heartbeatIntervalMs } : {}),
        ingestion: { ...ingestion },
    };
}