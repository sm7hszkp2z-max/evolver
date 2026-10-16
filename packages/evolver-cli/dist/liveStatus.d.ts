import { type ProxyRuntimeStatus } from './lifecycle.js';
import { type IngestionTelemetry } from './runtimeTelemetry.js';
export declare const LIVE_STATUS_USAGE = "Usage: evolver status [--json]\n       evolver status --live [--json] [--home=<dir>] [--autoexec-home=<dir>]\n\nDefault: historical event/cycle statistics. --live: read-only local runtime observations.\nExit codes (--live): 0 observed running with recent/idle loop; 1 selected runtimes stopped; 2 inactive/unknown/degraded.\nProxy settings follow EVOLVER_PROXY_SETTINGS_FILE / EVOLVER_SETTINGS_DIR. No restart or cleanup is performed.\n";
export interface AutoexecRuntimeStatus {
    state: 'running' | 'stopped' | 'unknown';
    pid?: number;
    reason?: string;
    progress: 'recent' | 'overdue_or_blocked' | 'unknown';
    lastTickAt?: number;
    lastHeartbeatAt?: number;
    lastTickOutcome?: 'completed' | 'failed' | 'blocked';
    ingestion: IngestionTelemetry;
}
export interface LiveStatusReport {
    schema: 'evolver.runtime-status.v1';
    observedAt: string;
    proxy: ProxyRuntimeStatus;
    autoexec: AutoexecRuntimeStatus;
}
export declare function observeAutoexecRuntime(autoexecHome: string, eventsPath: string, now?: number): AutoexecRuntimeStatus;
export declare function collectLiveStatus(env?: NodeJS.ProcessEnv, autoexecHome?: string): Promise<LiveStatusReport>;
export declare function liveStatusExitCode(report: LiveStatusReport): number;
export declare function formatLiveStatus(report: LiveStatusReport): string;
export declare function runLiveStatus(argv: readonly string[], options?: {
    env?: NodeJS.ProcessEnv;
    stdout?: (text: string) => void;
}): Promise<number>;