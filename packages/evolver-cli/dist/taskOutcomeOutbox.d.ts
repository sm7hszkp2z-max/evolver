import { type exec } from '@evomap/evolver-core';
import type { OutcomeReceipt, OutcomeReport } from '@evomap/evolver-adapter-public';
declare const SCHEMA_VERSION = "autoexec-task-outcome-outbox.v1";
export type TaskOutcomeLocalStatus = 'pending' | 'acknowledged';
export type TaskOutcomeNetworkStatus = 'pending' | 'ambiguous' | 'acknowledged' | 'terminal';
export type TaskOutcomeUseEvidence = Pick<exec.AppliedUseOutcome, 'schemaVersion' | 'assetId' | 'geneId' | 'cycleId' | 'source' | 'outcome' | 'producedValue' | 'applicationBinding' | 'verification' | 'hubOriginDestinationId'>;
export interface TaskOutcomeRecord {
    schemaVersion: typeof SCHEMA_VERSION;
    /** Derived from the queue claim root, so a reused task id gets a new operation. */
    operationId: string;
    claimRootDigest: string;
    taskId: string;
    generation?: string;
    /** Nonsecret fingerprint of the effective Hub destination and principal. */
    destinationId: string;
    verdictStatus: exec.AutoExecVerdict['status'];
    /** A committed bridge observation; required before task-wide Hub learning. */
    agentInvoked: true;
    producedValue?: boolean;
    appliedUse?: TaskOutcomeUseEvidence;
    report: OutcomeReport;
    payloadDigest: string;
    localStatus: TaskOutcomeLocalStatus;
    networkStatus: TaskOutcomeNetworkStatus;
    revision: number;
    preparedAt: string;
    localAcknowledgedAt?: string;
    dispatchStartedAt?: string;
    settledAt?: string;
    terminalReason?: string;
    ambiguousReason?: string;
    reconciliationEvidence?: string;
}
export interface PrepareTaskOutcomeInput {
    claimRoot: string;
    destinationId: string;
    task: Pick<exec.AutoExecTask, 'id' | 'signals' | 'generation'>;
    verdict: Pick<exec.AutoExecVerdict, 'taskId' | 'status' | 'generation' | 'outcome' | 'producedValue' | 'appliedUse' | 'agentInvoked' | 'failureKind' | 'execution_terminal'>;
}
/** The caller supplies the actual Hub adapter's recordOutcome method. */
export type TaskOutcomeSender = (report: Readonly<OutcomeReport>) => Promise<OutcomeReceipt>;
export type TaskOutcomeReconciliation = {
    status: 'acknowledged';
    evidence: string;
} | {
    status: 'terminal';
    evidence: string;
    reason: string;
};
export declare class TaskOutcomeOutboxError extends Error {
    constructor(message: string);
}
export declare function taskOutcomeIdentity(claimRoot: string): {
    operationId: string;
    claimRootDigest: string;
};
export declare class TaskOutcomeOutbox {
    readonly dir: string;
    private readonly directory;
    private readonly reportedUnreadable;
    constructor(dir: string);
    private path;
    get(operationId: string): Readonly<TaskOutcomeRecord> | null;
    private save;
    /** Called after the queue claim receipt is durable and before the claim is archived. */
    prepare(input: PrepareTaskOutcomeInput): Readonly<TaskOutcomeRecord> | null;
    private rows;
    localPending(): Readonly<TaskOutcomeRecord>[];
    /** Acknowledge only after the queue's local receipt is committed. */
    acknowledgeLocal(operationId: string): Readonly<TaskOutcomeRecord>;
    pending(destinationId?: string): Readonly<TaskOutcomeRecord>[];
    /** An explicit false receipt is terminal; an indeterminate send remains ambiguous. */
    deliver(operationId: string, destinationId: string, sender: TaskOutcomeSender): Promise<Readonly<TaskOutcomeRecord>>;
    /** A later receipt or operator evidence can settle ambiguity without resending. */
    reconcile(operationId: string, resolution: TaskOutcomeReconciliation): Readonly<TaskOutcomeRecord>;
    /** Skip rows bound to another destination; never retry started or settled sends. */
    flush(destinationId: string, sender: TaskOutcomeSender): Promise<{
        delivered: number;
        terminal: number;
        ambiguous: number;
    }>;
}
export {};