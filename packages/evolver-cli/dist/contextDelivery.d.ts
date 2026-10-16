import type { PreparedContextDelivery } from '@evomap/evolver-core/prompt-recall';
export { waitContextDelivery } from './promptRecallShared.js';
/** Both production context entrypoints share the same prepare -> actual callback -> projection protocol. */
export declare function deliverContextOutput(options: {
    text: string;
    prepare?: (options: {
        deadlineAt: number;
    }) => PreparedContextDelivery | Promise<PreparedContextDelivery>;
    stdout?: (text: string) => void | Promise<void>;
    stdoutWithSettlement?: (text: string, onSettled: (written: boolean) => void) => Promise<void>;
    onOutputWritten?: () => void;
}): Promise<'written' | 'prepare_failed' | 'output_unknown'>;