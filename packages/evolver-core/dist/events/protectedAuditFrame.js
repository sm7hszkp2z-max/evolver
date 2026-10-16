/** Incremental length-prefixed frame decoder with one bounded body allocation. */
export class ProtectedAuditFrameReceiver {
    maxBytes;
    header = Buffer.alloc(4);
    headerBytes = 0;
    body;
    bodyBytes = 0;
    done = false;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
    }
    feed(chunk) {
        if (this.done)
            throw new Error('frame_trailing_bytes');
        let offset = 0;
        while (offset < chunk.length) {
            if (this.headerBytes < 4) {
                const count = Math.min(4 - this.headerBytes, chunk.length - offset);
                chunk.copy(this.header, this.headerBytes, offset, offset + count);
                this.headerBytes += count;
                offset += count;
                if (this.headerBytes === 4) {
                    const size = this.header.readUInt32BE(0);
                    if (size < 1 || size > this.maxBytes)
                        throw new Error('frame_size_invalid');
                    this.body = Buffer.allocUnsafe(size);
                }
            }
            else {
                const body = this.body;
                const count = Math.min(body.length - this.bodyBytes, chunk.length - offset);
                chunk.copy(body, this.bodyBytes, offset, offset + count);
                this.bodyBytes += count;
                offset += count;
                if (this.bodyBytes === body.length) {
                    if (offset !== chunk.length)
                        throw new Error('frame_trailing_bytes');
                    this.done = true;
                    return body;
                }
            }
        }
        return undefined;
    }
}