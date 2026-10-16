import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { events, util } from '@evomap/evolver-core';
import { lifecyclePaths, probeProxyRuntime } from './lifecycle.js';
import { runtimeOwnerGeneration } from './runtimeTelemetry.js';
export const LIVE_STATUS_USAGE = 'Usage: evolver status [--json]\n       evolver status --live [--json] [--home=<dir>] [--autoexec-home=<dir>]\n\nDefault: historical event/cycle statistics. --live: read-only local runtime observations.\nExit codes (--live): 0 observed running with recent/idle loop; 1 selected runtimes stopped; 2 inactive/unknown/degraded.\nProxy settings follow EVOLVER_PROXY_SETTINGS_FILE / EVOLVER_SETTINGS_DIR. No restart or cleanup is performed.\n';
const MAX_HISTORY_TAIL_BYTES = 1024 * 1024;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function nonnegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Only a stable, bounded tail is diagnostic evidence. It never opens an Ingestor or journal. */
function readHeartbeatTail(path) {
    let fd;
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink())
            throw new Error('invalid history');
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
            || opened.ctimeNs !== before.ctimeNs || opened.mtimeNs !== before.mtimeNs)
            throw new Error('changed history');
        const size = Number(opened.size);
        if (!Number.isSafeInteger(size))
            throw new Error('invalid history size');
        const start = Math.max(0, size - MAX_HISTORY_TAIL_BYTES);
        const buffer = Buffer.alloc(size - start);
        let total = 0;
        while (total < buffer.length) {
            const count = readSync(fd, buffer, total, buffer.length - total, start + total);
            if (!count)
                break;
            total += count;
        }
        const after = fstatSync(fd, { bigint: true });
        const named = lstatSync(path, { bigint: true });
        if (total !== buffer.length || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino
            || after.size !== opened.size || after.ctimeNs !== opened.ctimeNs || after.mtimeNs !== opened.mtimeNs
            || named.size !== after.size || named.ctimeNs !== after.ctimeNs || named.mtimeNs !== after.mtimeNs)
            throw new Error('changed history');
        let text = buffer.toString('utf8');
        if (start > 0)
            text = text.slice(text.indexOf('\n') + 1);
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function ingestionStatus(value, lastTickAt, recent) {
    const input = record(value);
    if (input?.['state'] === 'disabled')
        return { state: 'disabled' };
    if (!input || (input['state'] !== 'observed' && input['state'] !== 'degraded')
        || !nonnegativeInteger(input['lastTickAt']) || input['lastTickAt'] > lastTickAt
        || !nonnegativeInteger(input['recorded']) || !nonnegativeInteger(input['parseFailures']))
        return { state: 'unknown' };
    return {
        state: recent ? input['state'] : 'unknown', lastTickAt: input['lastTickAt'],
        recorded: input['recorded'], parseFailures: input['parseFailures'],
    };
}
export function observeAutoexecRuntime(autoexecHome, eventsPath, now = Date.now()) {
    const base = { state: 'unknown', progress: 'unknown', ingestion: { state: 'unknown' } };
    const lockPath = join(autoexecHome, 'autoexec.lock');
    try {
        const owner = util.readFileLockOwner(lockPath);
        if (!owner)
            return { ...base, state: 'stopped', reason: 'owner_lock_absent' };
        const ownerState = util.inspectFileLockOwnerProcess(owner);
        if (ownerState === 'dead' || ownerState === 'pid_reused')
            return { ...base, state: 'stopped', pid: owner.pid, reason: ownerState };
        if (ownerState !== 'current')
            return { ...base, pid: owner.pid, reason: 'process_identity_unavailable' };
        const generation = runtimeOwnerGeneration(owner);
        let candidates;
        try {
            candidates = readHeartbeatTail(eventsPath);
        }
        catch {
            candidates = [];
        }
        let result = { ...base, state: 'running', pid: owner.pid, reason: 'current_heartbeat_unavailable' };
        for (const candidate of candidates.reverse()) {
            const event = record(candidate);
            const payload = record(event?.['payload']);
            const runtime = record(payload?.['runtime']);
            if (event?.['type'] !== 'cycle.heartbeat' || !runtime || runtime['generation'] !== generation || runtime['pid'] !== owner.pid)
                continue;
            const identity = util.parseFileLockProcessStartIdentity(runtime['processStartIdentity']);
            if (!identity || !util.sameFileLockProcessStartIdentity(identity, owner.processStartIdentity))
                break;
            const ts = typeof event['ts'] === 'string' ? Date.parse(event['ts']) : NaN;
            const tick = runtime['lastTickAt'];
            const interval = runtime['heartbeatIntervalMs'];
            const delay = payload?.['nextDelayMs'];
            const outcome = runtime['lastTickOutcome'];
            if (!nonnegativeInteger(ts) || ts > now || !nonnegativeInteger(tick) || tick > ts
                || !nonnegativeInteger(interval) || interval > 2_147_483_647 || !nonnegativeInteger(delay) || delay === 0 || delay > 2_147_483_647
                || (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'blocked'))
                break;
            const recent = now - tick <= Math.max(interval, delay) * 2 + 5_000;
            result = {
                state: 'running', pid: owner.pid, progress: recent ? 'recent' : 'overdue_or_blocked',
                lastTickAt: tick, lastHeartbeatAt: ts, lastTickOutcome: outcome,
                ingestion: ingestionStatus(runtime['ingestion'], tick, recent),
            };
            break;
        }
        const finalOwner = util.readFileLockOwner(lockPath);
        if (!finalOwner || runtimeOwnerGeneration(finalOwner) !== generation || util.inspectFileLockOwnerProcess(finalOwner) !== 'current') {
            return { ...base, reason: 'owner_changed_during_observation' };
        }
        return result;
    }
    catch {
        return { ...base, reason: 'owner_unreadable_or_unverifiable' };
    }
}
export async function collectLiveStatus(env = process.env, autoexecHome) {
    const proxy = await probeProxyRuntime(lifecyclePaths(env));
    const autoexec = observeAutoexecRuntime(autoexecHome ?? join(events.evomapHome(env), 'autoexec'), events.rootEventsPath(env));
    return { schema: 'evolver.runtime-status.v1', observedAt: new Date().toISOString(), proxy, autoexec };
}
export function liveStatusExitCode(report) {
    if (report.proxy.state === 'stopped' && report.autoexec.state === 'stopped')
        return 1;
    const proxyReady = report.proxy.state === 'running' && ['recent', 'idle'].includes(report.proxy.loop.state)
        && report.proxy.hubAuth !== 'auth_failed' && report.proxy.hubAuth !== 'retired' && report.proxy.hubAuth !== 'rate_limited' && !report.proxy.syncErrorPresent;
    const autoexecReady = report.autoexec.state === 'running' && report.autoexec.progress === 'recent'
        && report.autoexec.lastTickOutcome === 'completed'
        && (report.autoexec.ingestion.state === 'observed' || report.autoexec.ingestion.state === 'disabled');
    return (proxyReady || autoexecReady) && report.proxy.state !== 'unknown' && report.autoexec.state !== 'unknown'
        && (report.proxy.state !== 'running' || proxyReady) && (report.autoexec.state !== 'running' || autoexecReady) ? 0 : 2;
}
export function formatLiveStatus(report) {
    const proxy = report.proxy;
    const ae = report.autoexec;
    const time = (value) => value === undefined ? '-' : new Date(value).toISOString();
    return `Evolver runtime (${report.observedAt})\n`
        + `Proxy: ${proxy.state} pid=${proxy.pid ?? '-'} IPC=${proxy.ipc} loop=${proxy.loop.state}${proxy.reason ? ` reason=${proxy.reason}` : ''}\n`
        + `  lastTick=${time(proxy.loop.lastTickAt)} nextTick=${time(proxy.loop.nextTickDueAt)} failures=${proxy.loop.consecutiveFailures ?? '-'} hubAuth=${proxy.hubAuth ?? 'unknown'} syncError=${proxy.syncErrorPresent === undefined ? 'unknown' : proxy.syncErrorPresent ? 'present' : 'none'}\n`
        + `Autoexec: ${ae.state} pid=${ae.pid ?? '-'} progress=${ae.progress}${ae.reason ? ` reason=${ae.reason}` : ''}\n`
        + `  lastTick=${time(ae.lastTickAt)} lastOutcome=${ae.lastTickOutcome ?? 'unknown'}\n`
        + `Ingestion (hosted by autoexec): ${ae.ingestion.state} lastTick=${time(ae.ingestion.lastTickAt)} recorded=${ae.ingestion.recorded ?? '-'}\n`
        + 'Unknown/overdue observations do not prove a process has died. No services were restarted or state repaired.\n';
}
export async function runLiveStatus(argv, options = {}) {
    const write = options.stdout ?? ((text) => { process.stdout.write(text); });
    if (argv.includes('--help') || argv.includes('-h')) {
        write(LIVE_STATUS_USAGE);
        return 0;
    }
    const env = { ...(options.env ?? process.env) };
    let home;
    let autoexecHome;
    let json = false;
    const seen = new Set();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const key = arg.split('=', 1)[0];
        if (seen.has(key)) {
            write('Invalid status option: duplicate flag\n');
            return 2;
        }
        seen.add(key);
        if (arg === '--live')
            continue;
        if (arg === '--json') {
            json = true;
            continue;
        }
        if (key !== '--home' && key !== '--autoexec-home') {
            write('Invalid status option\n');
            return 2;
        }
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
        if (!value?.trim() || value.startsWith('--')) {
            write('Missing status directory option\n');
            return 2;
        }
        if (key === '--home')
            home = value;
        else
            autoexecHome = value;
    }
    if (home !== undefined)
        env['EVOLVER_HOME'] = home;
    const report = await collectLiveStatus(env, autoexecHome);
    write(json ? `${JSON.stringify(report)}\n` : formatLiveStatus(report));
    return liveStatusExitCode(report);
}