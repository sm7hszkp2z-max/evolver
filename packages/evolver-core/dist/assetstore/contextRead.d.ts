/** Constructor brands reject Proxy wrappers. A trusted Union must still hold
 * only branded children and its original prompt operations. This separates
 * external adapter backpressure from product-owned readers; it is not an
 * in-process JavaScript sandbox. */
export declare function isBuiltInContextReadSource(source: object): boolean;
/** Trusted V1/product owner API. The caller must retain this admission until
 * actual read and cleanup settle; constructor identity is not a JS sandbox. */
export declare function acquireContextRead(source: object): () => void;
/** Independent callbacks share external capacity even when their source is a
 * branded reader: the source brand cannot certify this arbitrary callback. */
export declare function withContextRead<T>(source: object, read: () => T | Promise<T>): Promise<T>;