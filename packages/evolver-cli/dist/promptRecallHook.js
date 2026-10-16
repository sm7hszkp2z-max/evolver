import { loadEnvFileFromEnv } from '@evomap/evolver-mcp/env-file';
import { promptRecallMode, waitContextDelivery, writeHookStdout } from './promptRecallShared.js';
export { MAX_PROMPT_RECALL_STDIN_BYTES, MAX_PROMPT_RECALL_LOCAL_FILE_BYTES, MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES, promptRecallMode, wrapGeneContext, } from './promptRecallShared.js';
/**
 * Cold hook entry: env-file/off/argument gates must precede importing the local
 * selection runtime. This matters for npm's unbundled, stable-obfuscated ESM, not
 * just tree-shaken binaries. Off never reads prompt stdin or loads core stores.
 */
export async function runPromptRecallHook(argv, deps = {}) {
    const env = deps.env ?? process.env;
    const envFile = loadEnvFileFromEnv(env);
    if ((env['EVOLVER_ENV_FILE']?.trim() && !envFile.loaded)
        || promptRecallMode(env) === 'off' || !argv.includes('--hook-stdin')) {
        try {
            await waitContextDelivery(Promise.resolve().then(() => (deps.stdout ?? writeHookStdout)('{}\n')), 1000);
        }
        catch { /* One attempt only, including EPIPE. Off has no audit. */ }
        return 0;
    }
    let run;
    try {
        ({ runPromptRecallHook: run } = await import('./promptRecallRuntime.js'));
    }
    catch {
        try {
            await waitContextDelivery(Promise.resolve().then(() => (deps.stdout ?? writeHookStdout)('{}\n')), 1000);
        }
        catch { /* Failed loading must not block submission or retry a failed write. */ }
        return 0;
    }
    return run(argv, deps);
}