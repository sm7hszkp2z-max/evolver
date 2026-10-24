import { z } from 'zod';
import type { Ingestor } from '../events/ingest.js';
import type { PolicyViolation } from './policy/constraints.js';
import type { ValidationIsolationTier } from '../verify/sandboxedValidation.js';
import { type ProofOfWork } from '../schema/proofOfWork.js';
export declare const executionBindingInputSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"execution-binding.v1">;
    bounty_id: z.ZodNullable<z.ZodString>;
    task_id: z.ZodString;
    claim_identity: z.ZodObject<{
        claim_id: z.ZodString;
        claimant_id: z.ZodString;
    }, z.core.$strict>;
    lease_identity: z.ZodObject<{
        lease_id: z.ZodString;
        lease_expires_at: z.ZodString;
    }, z.core.$strict>;
    target_descriptor: z.ZodObject<{
        repo_id: z.ZodString;
        selector: z.ZodString;
        expected_effect: z.ZodString;
        base_revision: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    target_digest: z.ZodString;
    acceptance_spec: z.ZodObject<{
        spec_id: z.ZodString;
        version: z.ZodString;
        digest: z.ZodString;
        validation_plan_digest: z.ZodString;
    }, z.core.$strict>;
    deadline: z.ZodString;
    budget: z.ZodObject<{
        max_credits: z.ZodNumber;
    }, z.core.$strict>;
    resource_grant: z.ZodObject<{
        allowed_roots: z.ZodArray<z.ZodString>;
        max_runtime_ms: z.ZodNumber;
        max_files: z.ZodNumber;
        max_lines: z.ZodNumber;
        validation_commands: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    consent_grant: z.ZodObject<{
        grant_id: z.ZodString;
        subject: z.ZodString;
        scopes: z.ZodArray<z.ZodString>;
        issued_at: z.ZodString;
        expires_at: z.ZodString;
        target_digest: z.ZodString;
    }, z.core.$strict>;
    correlation: z.ZodObject<{
        run_id: z.ZodString;
        cycle_id: z.ZodString;
    }, z.core.$strict>;
    selected_context: z.ZodObject<{
        gene_id: z.ZodNullable<z.ZodString>;
        gene_asset_id: z.ZodNullable<z.ZodString>;
        capsule_id: z.ZodNullable<z.ZodString>;
        capsule_asset_id: z.ZodNullable<z.ZodString>;
        context_digest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ExecutionBindingInput = z.infer<typeof executionBindingInputSchema>;
export type BindingDigest = `sha256:${string}`;
export type FrozenExecutionBinding = Readonly<ExecutionBindingInput & {
    binding_digest: BindingDigest;
}>;
export type ExecutionBindingErrorCode = 'binding_malformed' | 'binding_missing' | 'binding_stale' | 'binding_mismatched' | 'binding_target_invalid' | 'binding_deadline_exceeded' | 'binding_budget_exceeded' | 'binding_resource_denied' | 'binding_consent_denied' | 'binding_acceptance_invalid' | 'binding_replay_duplicate' | 'binding_replay_unsafe' | 'binding_provenance_unavailable';
export declare class ExecutionBindingError extends Error {
    readonly code: ExecutionBindingErrorCode;
    readonly detail: string;
    readonly unsafeToReplay: boolean;
    constructor(code: ExecutionBindingErrorCode, detail: string, unsafeToReplay?: boolean);
}
export interface BindingExecutionContext {
    taskId: string;
    runId?: string;
    cycleId?: string;
    repoPath?: string;
    target?: string;
    expectedEffect?: string;
    baseRevision?: string | null;
    currentRevision?: string | null | Promise<string | null>;
    allowedRoots?: readonly string[];
    maxRuntimeMs?: number;
    maxFiles?: number;
    maxLines?: number;
    now?: number | (() => number);
    requiredConsentScope?: string;
    authoritative?: BindingAuthorityChecks;
}
export interface BindingAuthorityChecks {
    claimLease: (binding: FrozenExecutionBinding) => boolean | Promise<boolean>;
    acceptanceSpec: (binding: FrozenExecutionBinding) => boolean | Promise<boolean>;
    budget: (binding: FrozenExecutionBinding) => boolean | Promise<boolean>;
    consent: (binding: FrozenExecutionBinding) => boolean | Promise<boolean>;
}
export interface BindingPreflightResult {
    binding: FrozenExecutionBinding;
    binding_digest: BindingDigest;
    remaining_deadline_ms: number;
    effective_allowed_roots: readonly string[];
}
export type ExecutionTerminalDisposition = 'completed' | 'denied' | 'invalid_target' | 'deadline_exceeded' | 'budget_exceeded' | 'resource_denied' | 'consent_denied' | 'timed_out' | 'cancelled' | 'crashed' | 'rejected' | 'unsafe_to_replay';
export interface ToolDecision {
    tool_name: string;
    decision: 'allowed' | 'denied';
    status?: 'not_run' | 'started' | 'completed' | 'failed';
    call_id?: string;
    duration_ms?: number;
}
export interface PolicyDecision {
    version: string;
    allowed: boolean;
    violations: readonly PolicyViolation[];
}
export interface ValidatorResult {
    label: string;
    cmd: string;
    allowed: boolean;
    exitCode: number | null;
    stdoutSummary: string;
    passed: boolean;
}
export interface ValidatorEvidence {
    id: string;
    version: string;
    status: 'ran' | 'not_run';
    reason?: 'policy_denied' | 'no_commands' | 'malformed_plan' | 'sandbox_unavailable' | 'not_configured';
    plan_digest?: BindingDigest;
    passed?: boolean;
    score?: number;
    results: readonly ValidatorResult[];
    skipped: readonly {
        cmd: string;
        script: string;
        reason: 'missing_script';
    }[];
    isolated: boolean;
    /** Absent in legacy receipts; never infer the stronger tier from `isolated` alone. */
    isolationTier?: ValidationIsolationTier;
    /** Keep sandbox setup/cleanup failures actionable after journal replay. */
    failureReason?: 'sandbox_setup_failed' | 'sandbox_cleanup_failed';
}
export interface ProofReference {
    kind: ProofOfWork['kind'];
    ref?: string;
    asset_id?: string;
}
export interface PermitDecision {
    ok: boolean;
    reason?: string;
    detail?: string;
}
export interface ImmutableExecutionProvenance {
    gene_ids: readonly string[];
    capsule_ids: readonly string[];
    input_context?: {
        schema: 'exec-input-context.v1';
        gene_asset_ids: readonly string[];
        capsule_asset_ids: readonly string[];
        digest: string;
    };
    tool_decisions: readonly ToolDecision[];
    policy_decisions: readonly PolicyDecision[];
    validator: ValidatorEvidence | null;
    permit?: PermitDecision;
    result_asset_refs: readonly string[];
    proof_refs: readonly ProofReference[];
    terminal_disposition: ExecutionTerminalDisposition;
}
export interface ExecutionTerminalRecord {
    binding_digest: BindingDigest;
    task_id: string;
    run_id: string;
    disposition: ExecutionTerminalDisposition;
    final_stage?: string;
    outcome?: {
        status: string;
        score: number;
        reason?: string;
    };
    proof_of_work?: ProofOfWork;
    provenance: ImmutableExecutionProvenance;
}
export type ExecutionRecovery = {
    kind: 'new';
    task_id: string;
    binding_digest: BindingDigest;
} | {
    kind: 'claimed';
    task_id: string;
    binding_digest: BindingDigest;
} | {
    kind: 'created';
    task_id: string;
    binding_digest: BindingDigest;
} | {
    kind: 'terminal';
    task_id: string;
    binding_digest: BindingDigest;
    terminal: ExecutionTerminalRecord;
} | {
    kind: 'unsafe_to_replay';
    task_id: string;
    binding_digest: BindingDigest;
    reason: string;
} | {
    kind: 'mismatched';
    task_id: string;
    binding_digest: BindingDigest;
    reason: string;
};
export declare function canonicalExecutionBinding(input: ExecutionBindingInput | FrozenExecutionBinding): string;
export declare function computeTargetDigest(target: ExecutionBindingInput['target_descriptor']): BindingDigest;
export declare function computeValidationPlanDigest(commands: readonly string[]): BindingDigest;
export declare function computeSelectedContextDigest(context: Omit<ExecutionBindingInput['selected_context'], 'context_digest'>): BindingDigest;
export declare function computeExecutionBindingDigest(input: ExecutionBindingInput): BindingDigest;
export declare function freezeExecutionBinding(input: unknown): FrozenExecutionBinding;
export declare function preflightExecutionBinding(input: unknown, context: BindingExecutionContext): Promise<BindingPreflightResult>;
export declare class ExecutionBindingJournal {
    private readonly ingestor;
    private readonly lockPath;
    constructor(ingestor: Ingestor);
    private withLock;
    private appendCreated;
    claim(binding: FrozenExecutionBinding): Promise<ExecutionRecovery>;
    recordCreated(binding: FrozenExecutionBinding): Promise<void>;
    recordStarted(binding: FrozenExecutionBinding): Promise<void>;
    recordDecision(bindingDigest: BindingDigest, decision: Record<string, unknown>): Promise<void>;
    recordDecision(taskId: string, bindingDigest: BindingDigest, decision: Record<string, unknown>): Promise<void>;
    recordTerminal(record: ExecutionTerminalRecord): Promise<void>;
    recordRecovered(taskId: string, bindingDigest: BindingDigest, disposition: string): Promise<void>;
    recover(taskId: string, bindingDigest?: BindingDigest): ExecutionRecovery;
}
export declare function parseExecutionTerminalRecord(input: unknown): ExecutionTerminalRecord;