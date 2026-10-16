/** Operator inspection and evidence-based reconciliation for autoexec feedback. */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { events, hub } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { FeedbackOutbox, FeedbackOutboxError } from './feedbackOutbox.js';
import { TaskOutcomeOutbox, TaskOutcomeOutboxError } from './taskOutcomeOutbox.js';
const EXACT_OPERATION_ID = /^autoexec-feedback:[a-f0-9]{64}$/;
const TASK_OPERATION_ID = /^autoexec-task-outcome:[a-f0-9]{64}$/;
const ROW_NAME = /^[a-f0-9]{64}\.json$/;
const EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const USAGE = [
    'Usage:',
    '  evolver autoexec-feedback list [--home <autoexec-dir>] [--json]',
    '  evolver autoexec-feedback reconcile --operation <id> (--ack | --terminal) --evidence <operator-ref> [--reason <operator-reason>] [--home <autoexec-dir>] [--json]',
    'References must not contain credentials. Known credential formats and configured environment values are rejected; an opaque identifier is not proof of secrecy.',
    'List includes exact-use and task-wide outcomes. An ambiguous Hub write must be checked externally before reconciliation. A pending write can only be terminally settled after local commit, with evidence and an explicit reason. This command never resends it.',
].join('\n') + '\n';
function parseArgs(argv) {
    const command = argv[0];
    if (command !== 'list' && command !== 'reconcile')
        throw new FeedbackOutboxError('invalid feedback command');
    const args = { command, json: false };
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--home' || arg === '--operation' || arg === '--evidence' || arg === '--reason') {
            const value = argv[++i];
            if (!value || value.startsWith('--'))
                throw new FeedbackOutboxError(`missing ${arg} value`);
            if (arg === '--home') {
                if (args.home !== undefined)
                    throw new FeedbackOutboxError('duplicate --home');
                args.home = value;
            }
            else if (arg === '--operation') {
                if (args.operationId !== undefined)
                    throw new FeedbackOutboxError('duplicate --operation');
                args.operationId = value;
            }
            else if (arg === '--evidence') {
                if (args.evidence !== undefined)
                    throw new FeedbackOutboxError('duplicate --evidence');
                args.evidence = value;
            }
            else {
                if (args.reason !== undefined)
                    throw new FeedbackOutboxError('duplicate --reason');
                args.reason = value;
            }
        }
        else if (arg === '--json') {
            if (args.json)
                throw new FeedbackOutboxError('duplicate --json');
            args.json = true;
        }
        else if (arg === '--ack' || arg === '--terminal') {
            if (args.disposition)
                throw new FeedbackOutboxError('choose one feedback disposition');
            args.disposition = arg === '--ack' ? 'ack' : 'terminal';
        }
        else {
            throw new FeedbackOutboxError('unknown feedback option');
        }
    }
    if (command === 'list') {
        if (args.operationId || args.evidence || args.reason || args.disposition)
            throw new FeedbackOutboxError('list accepts only --home and --json');
    }
    else {
        if (!args.operationId || (!EXACT_OPERATION_ID.test(args.operationId) && !TASK_OPERATION_ID.test(args.operationId))) {
            throw new FeedbackOutboxError('valid --operation required');
        }
        if (!args.disposition)
            throw new FeedbackOutboxError('choose --ack or --terminal');
        if (!args.evidence || !EVIDENCE_REFERENCE.test(args.evidence)) {
            throw new FeedbackOutboxError('nonsecret --evidence reference required');
        }
        if (args.reason && (args.disposition !== 'terminal' || !EVIDENCE_REFERENCE.test(args.reason))) {
            throw new FeedbackOutboxError('nonsecret --reason valid only with --terminal');
        }
    }
    return args;
}
function visibleExact(row) {
    return {
        operationId: row.operationId,
        localStatus: row.localStatus,
        networkStatus: row.networkStatus,
        assetId: row.appliedUse.assetId,
        destinationId: row.destinationId ?? null,
    };
}
function visibleTask(row) {
    return {
        operationId: row.operationId,
        localStatus: row.localStatus,
        networkStatus: row.networkStatus,
        assetId: row.report.usedAssetIds?.[0] ?? null,
        destinationId: row.destinationId,
        kind: 'task-outcome',
        outcomeStatus: row.report.status,
    };
}
function listExactRows(outbox) {
    return readdirSync(outbox.dir)
        .filter((name) => ROW_NAME.test(name))
        .sort()
        .map((name) => outbox.get(`autoexec-feedback:${name.slice(0, -5)}`))
        .filter((row) => row !== null)
        .filter((row) => row.localStatus === 'pending'
        || row.networkStatus === 'pending' || row.networkStatus === 'ambiguous')
        .map(visibleExact);
}
function listTaskRows(outbox) {
    return readdirSync(outbox.dir)
        .filter((name) => ROW_NAME.test(name))
        .sort()
        .map((name) => outbox.get(`autoexec-task-outcome:${name.slice(0, -5)}`))
        .filter((row) => row !== null)
        .filter((row) => row.localStatus === 'pending'
        || row.networkStatus === 'pending' || row.networkStatus === 'ambiguous')
        .map(visibleTask);
}
function outboxExists(directory) {
    try {
        lstatSync(directory);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function line(row) {
    return `${row.operationId} local=${row.localStatus} network=${row.networkStatus} asset=${row.assetId ?? '-'} destination=${row.destinationId ?? '-'}${row.kind === 'task-outcome' ? ` kind=task-outcome outcome=${row.outcomeStatus}` : ''}\n`;
}
/** Read-only visibility plus explicit reconciliation. No sender or replay path is reachable here. */
export async function runAutoExecFeedbackCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((value) => { process.stdout.write(value); });
    const stderr = deps.stderr ?? ((value) => { process.stderr.write(value); });
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        stdout(USAGE);
        return 0;
    }
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (error) {
        const reason = error instanceof FeedbackOutboxError ? error.message : 'invalid feedback command';
        stderr(`autoexec-feedback: ${reason}\n${USAGE}`);
        return 1;
    }
    const env = deps.env ?? process.env;
    if ((args.home === undefined || args.command === 'reconcile') && loadEnvFileFromEnv(env).error) {
        stderr('autoexec-feedback: env_file_unavailable\n');
        return 1;
    }
    const home = args.home ?? join(events.evomapHome(env), 'autoexec');
    const exactDirectory = join(home, 'feedback-outbox');
    const taskDirectory = join(home, 'task-outcome-outbox');
    try {
        for (const value of [args.evidence, args.reason]) {
            if (value !== undefined && hub.fullLeakCheck(value, env).found) {
                throw new FeedbackOutboxError('credential-bearing reconciliation reference rejected');
            }
        }
        if (args.command === 'list') {
            const rows = [
                ...(outboxExists(exactDirectory) ? listExactRows(new FeedbackOutbox(exactDirectory)) : []),
                ...(outboxExists(taskDirectory) ? listTaskRows(new TaskOutcomeOutbox(taskDirectory)) : []),
            ].sort((a, b) => a.operationId.localeCompare(b.operationId));
            stdout(args.json
                ? `${JSON.stringify({ operations: rows })}\n`
                : rows.length > 0 ? rows.map(line).join('') : 'No pending or ambiguous feedback operations.\n');
            return 0;
        }
        const operationId = args.operationId;
        const evidence = args.evidence;
        const task = TASK_OPERATION_ID.test(operationId);
        const directory = task ? taskDirectory : exactDirectory;
        if (!outboxExists(directory)) {
            throw task ? new TaskOutcomeOutboxError('task outcome operation not found')
                : new FeedbackOutboxError('feedback operation not found');
        }
        const taskBox = task ? new TaskOutcomeOutbox(directory) : undefined;
        const exactBox = task ? undefined : new FeedbackOutbox(directory);
        const current = task ? taskBox.get(operationId) : exactBox.get(operationId);
        if (args.disposition === 'terminal' && current?.networkStatus === 'pending' && !args.reason) {
            throw new FeedbackOutboxError('--reason required for pending terminal reconciliation');
        }
        const resolution = args.disposition === 'ack'
            ? { status: 'acknowledged', evidence }
            : { status: 'terminal', evidence, reason: args.reason ?? 'operator_reconciled_terminal' };
        const result = task
            ? visibleTask(taskBox.reconcile(operationId, resolution))
            : visibleExact(exactBox.reconcile(operationId, resolution));
        stdout(args.json ? `${JSON.stringify(result)}\n` : line(result));
        return 0;
    }
    catch (error) {
        const reason = error instanceof FeedbackOutboxError || error instanceof TaskOutcomeOutboxError
            ? error.message : 'unable to read feedback outbox';
        stderr(`autoexec-feedback: ${reason}\n`);
        return 1;
    }
}