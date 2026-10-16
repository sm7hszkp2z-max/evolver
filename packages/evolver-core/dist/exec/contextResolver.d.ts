import type { AssetStoreProvider } from '../assetstore/provider.js';
import { ProvenanceStore } from '../assetstore/provenance.js';
import { ReviewLedger } from '../assetstore/reviewLedger.js';
import { type GeneContextBudget, type GeneContextContentMode, type GeneContextOmission } from '../assetstore/geneContext.js';
import type { BenchmarkContext } from '../assetstore/sourceQualification.js';
import type { GeneDecision } from '../algo/geneSelection.js';
import { type GeneStrategyInfo } from './prompt.js';
import { type ExecutionBindingInput } from './executionBinding.js';
export interface ExecContextOptions {
    /** Controls optional context, never selection, permissions or the existing full strategy prompt. */
    contentMode?: GeneContextContentMode;
    examples?: 'on' | 'off';
    budget?: GeneContextBudget;
    timeoutMs?: number;
}
export interface ExecContextReceipt {
    schema: 'exec-input-context.v1';
    contentMode: GeneContextContentMode;
    inputGeneAssetIds: string[];
    inputCaseAssetIds: string[];
    /** Digest of the exact appended text, after prompt sanitization. Not a verification receipt. */
    digest: string;
    /** Bounded diagnostic sample (at most 512); not an exhaustive rejected-case inventory. */
    omissions: GeneContextOmission[];
}
export interface ResolvedExecContext {
    text: string;
    receipt: ExecContextReceipt;
}
export interface ExecContextRequest {
    decision: GeneDecision;
    gene: GeneStrategyInfo | null;
    basePrompt: string;
    taskText?: string;
    signal?: AbortSignal;
    deadlineAt?: number;
}
export type ExecContextResolver = (request: ExecContextRequest) => Promise<ResolvedExecContext>;
export interface ExecContextDependencies {
    provenance?: ProvenanceStore;
    review?: ReviewLedger;
    benchmark?: BenchmarkContext;
    /** Frozen identities only. Null Capsule means no case lookup, including under the default context mode. */
    selectedContext?: ExecutionBindingInput['selected_context'];
    /** Product-only admission rechecked immediately before each optional V1 operation. */
    assertPromptAdapter?: () => void;
}
export declare const execContextTimeoutIsOptional: (resolver: ExecContextResolver) => boolean;
/** Factory resolvers retain each real source owner independently of caller deadlines. */
export declare const execContextResolverIsFactoryOwned: (resolver: ExecContextResolver) => boolean;
/** Own the receipt before any runner/observer callback can mutate resolver-owned data. */
export declare function snapshotExecInputContext(value: ResolvedExecContext, expectedGeneAssetId?: string): ResolvedExecContext;
export declare function execContextOptionsFromEnv(env?: Readonly<NodeJS.ProcessEnv>): ExecContextOptions;
export declare function makeExecContextResolver(store: AssetStoreProvider, dependencies?: ExecContextDependencies, options?: ExecContextOptions): ExecContextResolver;
/** Explicit upstream seam, to call BEFORE freeze/preflight/journal.created. It prepares identities, never
 * authority/consent, and never mutates a binding. The consumer re-reads and qualifies the exact case later.
 * Requires exact canonical Gene and Capsule references; no logical-id ambiguity or implicit case selection.
 * The Capsule's relation may be logical history only when the shared assembler proves it unambiguous.
 */
export declare function prepareExecutionContext(store: AssetStoreProvider, input: {
    geneAssetId: string;
    capsuleAssetId: string;
    basePrompt?: string;
    signal?: AbortSignal;
}, dependencies?: Omit<ExecContextDependencies, 'selectedContext'>, options?: ExecContextOptions): Promise<{
    selectedContext: ExecutionBindingInput['selected_context'];
    context: ResolvedExecContext;
}>;