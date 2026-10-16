import type { PromptRecallHookDeps } from './promptRecallRuntime.js';
export type { PromptRecallHookDeps } from './promptRecallRuntime.js';
export { MAX_PROMPT_RECALL_STDIN_BYTES, MAX_PROMPT_RECALL_LOCAL_FILE_BYTES, MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES, promptRecallMode, wrapGeneContext, type PromptRecallMode, } from './promptRecallShared.js';
/**
 * Cold hook entry: env-file/off/argument gates must precede importing the local
 * selection runtime. This matters for npm's unbundled, stable-obfuscated ESM, not
 * just tree-shaken binaries. Off never reads prompt stdin or loads core stores.
 */
export declare function runPromptRecallHook(argv: readonly string[], deps?: PromptRecallHookDeps): Promise<number>;