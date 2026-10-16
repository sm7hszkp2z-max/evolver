export interface OutboxDirectory {
    readonly path: string;
    assertTrusted(): void;
}
/** Only new directories are hardened; existing directories must already be private. */
export declare function prepareOutboxDirectory(directory: string): OutboxDirectory;
export declare function withOutboxLock<T>(directory: OutboxDirectory, operation: () => T, ..._syncOnly: Extract<T, PromiseLike<unknown>> extends never ? [] : [never]): T;