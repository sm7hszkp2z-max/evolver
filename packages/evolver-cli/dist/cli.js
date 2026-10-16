#!/usr/bin/env -S node --
import { settleCliProcess } from './cliLifecycle.js';
import { isReadOnlyStatusInvocation, runCliEntry } from './cliEntry.js';
const workerFlag = '--internal-posix-snapshot-worker';
if (process.argv[2] === workerFlag && process.argv.length === 3) {
    void import('@evomap/evolver-core/snapshot-worker').then(({ runPosixSnapshotWorker }) => runPosixSnapshotWorker()).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
}
else if (process.argv[2] === '--internal-protected-audit-service' && process.argv.length === 4) {
    void import('@evomap/evolver-core/protected-audit-service').then(({ runProtectedAuditService }) => runProtectedAuditService(process.argv[3])).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
}
else if (process.argv[2] === '--internal-protected-audit-ready' && process.argv.length === 4) {
    void import('@evomap/evolver-core/protected-audit-service').then(({ runProtectedAuditReady }) => runProtectedAuditReady(process.argv[3])).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
}
else if (process.argv[2] === '--internal-protected-audit-rpc-child' && process.argv.length === 3) {
    void settleCliProcess(async () => {
        const { runProtectedAuditRpcChild } = await import('@evomap/evolver-core/protected-audit-rpc-child');
        await runProtectedAuditRpcChild();
        return Number(process.exitCode ?? 0);
    });
}
else if (process.argv[2] === '--internal-protected-audit-migrate' && process.argv.length === 4) {
    void settleCliProcess(async () => {
        const { runProtectedAuditMigration } = await import('@evomap/evolver-core/protected-audit-migration');
        runProtectedAuditMigration(process.argv[3]);
        return 0;
    });
}
else if (process.argv[2] === '--internal-protected-audit-verify' && process.argv.length === 4) {
    void settleCliProcess(async () => {
        const { runProtectedAuditMigration } = await import('@evomap/evolver-core/protected-audit-migration');
        runProtectedAuditMigration(process.argv[3], 'verify');
        return 0;
    });
}
else if (process.argv[2] === '--internal-protected-audit-upgrade-verify' && process.argv.length === 4) {
    void settleCliProcess(async () => {
        const { runProtectedAuditMigration } = await import('@evomap/evolver-core/protected-audit-migration');
        runProtectedAuditMigration(process.argv[3], 'upgrade-verify');
        return 0;
    });
}
else if (process.argv[2] === '--internal-protected-audit-fence' && process.argv.length === 4) {
    void settleCliProcess(async () => {
        const { runProtectedAuditMigration } = await import('@evomap/evolver-core/protected-audit-migration');
        runProtectedAuditMigration(process.argv[3], 'fence');
        return 0;
    });
}
else if (process.argv[2] === '--internal-protected-audit-unfence' && process.argv.length === 4) {
    void settleCliProcess(async () => {
        const { runProtectedAuditMigration } = await import('@evomap/evolver-core/protected-audit-migration');
        runProtectedAuditMigration(process.argv[3], 'unfence');
        return 0;
    });
}
else {
    // Version is a pure metadata query used to authenticate an installer binary
    // even while the required marker is published and activation is incomplete.
    // Internal workers must not initialize the service/schema graph within their
    // caller's I/O deadline. Normal commands retain the original admission gate.
    void settleCliProcess(async () => {
        const { configureProtectedAuditRpcChildCommand, requireProtectedAuditServiceForProcess } = await import('@evomap/evolver-core/protected-audit-rpc-child');
        const readOnlyStatus = isReadOnlyStatusInvocation(process.argv.slice(2));
        if (!(process.argv.length === 3 && process.argv[2] === '--version') && !readOnlyStatus)
            requireProtectedAuditServiceForProcess();
        const { configurePosixSnapshotWorkerCommand } = await import('@evomap/evolver-core/snapshot-worker');
        const entry = process.argv[1] && /\.[cm]?js$/.test(process.argv[1]) ? [process.argv[1]] : [];
        configurePosixSnapshotWorkerCommand({ command: process.execPath, args: [...entry, workerFlag] });
        configureProtectedAuditRpcChildCommand({ command: process.execPath, args: [...entry, '--internal-protected-audit-rpc-child'] });
        return runCliEntry(process.argv.slice(2));
    });
}