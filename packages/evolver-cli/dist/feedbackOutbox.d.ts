import { hub, type exec } from '@evomap/evolver-core';
declare const SCHEMA_VERSION = "autoexec-feedback-outbox.v1";
export type FeedbackNetworkStatus = 'not_applicable' | 'pending' | 'ambiguous' | 'acknowledged' | 'terminal';
export type FeedbackLocalStatus = 'pending' | 'acknowledged';
export interface FeedbackOutboxRecord {
    schemaVersion: typeof SCHEMA_VERSION;
    /** Stable across daemon restarts and independent of a task id reused by a later claim. */
    operationId: string;
    /** Stable source id for idempotent local event projection. */
    sourceEventId: string;
    /** The claim identity is hashed; its raw path/name is not retained. */
    claimRootDigest: string;
    taskId: string;
    signals: readonly string[];
    appliedUse: exec.AppliedUseOutcome;
    /** Present only when exact Hub use is proven to originate at this destination. */
    report?: hub.ReuseResultReport;
    /** Nonsecret fingerprint of the observed destination; dispatch also requires origin agreement. */
    destinationId?: string;
    payloadDigest: string;
    localStatus: FeedbackLocalStatus;
    networkStatus: FeedbackNetworkStatus;
    revision: number;
    preparedAt: string;
    localAcknowledgedAt?: string;
    dispatchStartedAt?: string;
    settledAt?: string;
    receiptId?: string;
    terminalReason?: string;
    ambiguousReason?: string;
    reconciliationEvidence?: string;
}
export interface PrepareFeedbackInput {
    claimRoot: string;
    /** If supplied, must equal feedbackIdentity(claimRoot, appliedUse.assetId).operationId. */
    operationId?: string;
    /** Required for reportable Hub use; sha256 fingerprint of the effective destination and principal. */
    destinationId?: string;
    task: Pick<exec.AutoExecTask, 'id' | 'signals' | 'generation'>;
    verdict: Pick<exec.AutoExecVerdict, 'taskId' | 'status' | 'generation' | 'appliedUse'>;
}
export type FeedbackSendResult = {
    status: 'acknowledged';
    receiptId?: string;
} | {
    status: 'terminal';
    reason: string;
} | {
    status: 'ambiguous';
    reason?: string;
};
export type FeedbackSender = (record: Readonly<FeedbackOutboxRecord>) => Promise<FeedbackSendResult>;
export type FeedbackReconciliation = {
    status: 'acknowledged';
    evidence: string;
    receiptId?: string;
} | {
    status: 'terminal';
    evidence: string;
    reason: string;
};
export declare class FeedbackOutboxError extends Error {
    constructor(message: string);
}
/** Only a sender that proves no Hub request began may permit a later retry. */
export declare class FeedbackNotDispatchedError extends Error {
    constructor(message: string);
}
/** One operation per claim root and exact asset, even if the task id is later reused. */
export declare function feedbackIdentity(claimRoot: string, assetId: string): {
    operationId: string;
    sourceEventId: string;
    claimRootDigest: string;
};
export declare class FeedbackOutbox {
    readonly dir: string;
    private readonly directory;
    private readonly reportedUnreadable;
    constructor(dir: string);
    private path;
    get(operationId: string): Readonly<FeedbackOutboxRecord> | null;
    private save;
    /** Persist exact applied-use evidence before any local projection or Hub call. */
    prepare(input: PrepareFeedbackInput): Readonly<FeedbackOutboxRecord> | null;
    private rows;
    localPending(): Readonly<FeedbackOutboxRecord>[];
    /** This acknowledgement follows idempotent ingestion under sourceEventId. */
    acknowledgeLocal(operationId: string): Readonly<FeedbackOutboxRecord>;
    /** Never dispatched Hub rows; ambiguous rows are intentionally excluded. */
    pending(): Readonly<FeedbackOutboxRecord>[];
    /** Mark ambiguous durably before first send. No replay from ambiguous state. */
    deliver(operationId: string, destinationId: string, sender: FeedbackSender): Promise<Readonly<FeedbackOutboxRecord>>;
    /** External receipt or operator evidence can settle ambiguity without resending. */
    reconcile(operationId: string, resolution: FeedbackReconciliation): Readonly<FeedbackOutboxRecord>;
}
export {};