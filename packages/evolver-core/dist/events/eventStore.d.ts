import { type AuditWriteOptions } from './boundedAudit.js';
import { type DeliveryProjectionAuthority } from '../ops/geneContextDeliveryJournal.js';
import { type RootEvent, type RawEvent } from './eventSchema.js';
/** 单行字节上限, 保 O_APPEND+write 在 ext4 的原子性 (军杰 §3.2). */
export declare const MAX_LINE_BYTES = 4096;
export declare const MAX_PROTECTED_HISTORY_BYTES: number;
/** Size-only preflight using the writer's schema and the longest generated envelope. No I/O or IDs consumed. */
export declare function fitsRootEventLine(raw: RawEvent): boolean;
export declare class LineTooLargeError extends Error {
    readonly bytes: number;
    constructor(bytes: number);
}
export interface EventStoreOptions {
    path: string;
    /** Injectable clock for the event `ts` (ms epoch). Defaults to the real clock; inject for deterministic tests. */
    now?: () => number;
}
export interface EventWriteAdmission {
    signal?: AbortSignal;
    deadlineAt?: number;
    operationId?: string;
}
/** This error is minted only before append dispatch, never for an ambiguous filesystem failure. */
export declare class EventWriteNotCommittedError extends Error {
    readonly operationId: string | undefined;
    constructor(operationId: string | undefined, cause?: unknown);
}
/** 唯一权威事件流 (AE). single-writer / append-only / seq 递增 / fsync. */
export declare class EventStore {
    static isBuiltInObservationStore(value: unknown): value is EventStore;
    static usesBuiltInClock(value: unknown): value is EventStore;
    readonly path: string;
    private readonly lockPath;
    private readonly now;
    private chain;
    constructor(opts: EventStoreOptions);
    /** 唯一写路径: 生成 seq/eventId/ts, 校验, 原子 append + fsync. */
    append(raw: RawEvent, options?: EventWriteAdmission): Promise<RootEvent>;
    private appendLocked;
    /** Bounded audit entry used only through Ingestor. Shares the envelope and cross-process writer lock. */
    static appendBounded(raw: RawEvent, opts: EventStoreOptions & AuditWriteOptions): Promise<RootEvent>;
    /** Operation-bound delivery projection. Only Ingestor supplies validated authority. */
    static projectContextDelivery(authority: DeliveryProjectionAuthority, opts: EventStoreOptions & AuditWriteOptions, validate?: (raw: RawEvent) => void): Promise<'projected' | 'pending' | 'unknown'>;
    /** 读全部事件 (跳过尾部半行/损坏行). */
    readAll(): RootEvent[];
    /** Fail-closed replay for decision policies that cannot safely consume a partial history. */
    readAllStrict(): RootEvent[];
    iterate(fromSeq?: number): Generator<RootEvent>;
    tail(n?: number): RootEvent[];
    /** 截断尾部半行 (崩溃恢复). */
    recover(): {
        truncated: boolean;
    };
    private lastSeqFromFile;
}