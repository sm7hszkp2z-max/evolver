export interface FeedbackOutboxCliDeps {
    env?: Record<string, string | undefined>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
/** Read-only visibility plus explicit reconciliation. No sender or replay path is reachable here. */
export declare function runAutoExecFeedbackCommand(argv: readonly string[], deps?: FeedbackOutboxCliDeps): Promise<number>;