import type { ContextReadOperationV1 } from './provider.js';
/** Own a local read from synchronous admission through its returned Promise.
 * This helper is suitable for side-effect-free local readers. An external
 * adapter must additionally stop and join its own worker before resolving
 * cancelAndSettle; forwarding an AbortSignal alone does not satisfy V1.
 */
export declare function beginLocalContextReadV1<T>(signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>): ContextReadOperationV1<T>;