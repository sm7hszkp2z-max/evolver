/** Incremental length-prefixed frame decoder with one bounded body allocation. */
export declare class ProtectedAuditFrameReceiver {
    private readonly maxBytes;
    private readonly header;
    private headerBytes;
    private body?;
    private bodyBytes;
    private done;
    constructor(maxBytes: number);
    feed(chunk: Buffer): Buffer | undefined;
}