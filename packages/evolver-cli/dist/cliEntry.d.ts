export declare function isReadOnlyStatusInvocation(argv: readonly string[]): boolean;
/** Executable-only routing; launchers retain their exit contract and prompt hooks arm a process watchdog. */
export declare function runCliEntry(argv: string[]): Promise<number>;