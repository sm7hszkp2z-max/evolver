interface SqliteStatement {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
    run(...args: unknown[]): {
        changes?: number | bigint;
    };
}
export interface SqliteDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): SqliteStatement;
    close(): void;
}
/** The public npm runtime is Node; standalone releases run Bun, which has no node:sqlite module. */
export declare function openSqliteDatabase(path: string, options?: {
    readOnly?: boolean;
    create?: boolean;
}): SqliteDatabase;
export {};