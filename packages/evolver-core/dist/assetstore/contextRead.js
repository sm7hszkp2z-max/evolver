// Optional context callers may stop waiting, but that does not settle their
// provider's Promise. Keep backpressure attached to the actual read, shared by
// repeated requests/resolver instances. No queued replay and no force-cancellation
// claim: a provider that never settles remains unavailable until its owner recovers.
import { LocalJsonlProvider } from './localJsonl.js';
import { ForeignJsonlSource } from './foreignJsonlSource.js';
import { UnionReadStore } from './unionReadStore.js';
const active = new WeakMap();
const count = { builtin: 0, external: 0 };
const MAX_ACTIVE_READS = 64;
/** Constructor brands reject Proxy wrappers. A trusted Union must still hold
 * only branded children and its original prompt operations. This separates
 * external adapter backpressure from product-owned readers; it is not an
 * in-process JavaScript sandbox. */
export function isBuiltInContextReadSource(source) {
    return LocalJsonlProvider.isBuiltInPromptReader(source)
        || ForeignJsonlSource.isBuiltInPromptReader(source)
        || UnionReadStore.isBuiltInPromptReader(source);
}
function acquireInLane(source, lane) {
    if (active.has(source))
        throw new Error('context_source_busy');
    if (count[lane] >= MAX_ACTIVE_READS)
        throw new Error('context_source_capacity');
    active.set(source, lane);
    count[lane]++;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        active.delete(source);
        count[lane]--;
    };
}
/** Trusted V1/product owner API. The caller must retain this admission until
 * actual read and cleanup settle; constructor identity is not a JS sandbox. */
export function acquireContextRead(source) {
    return acquireInLane(source, isBuiltInContextReadSource(source) ? 'builtin' : 'external');
}
/** Independent callbacks share external capacity even when their source is a
 * branded reader: the source brand cannot certify this arbitrary callback. */
export async function withContextRead(source, read) {
    const release = acquireInLane(source, 'external');
    try {
        return await read();
    }
    finally {
        release();
    }
}