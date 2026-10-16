import { contextDeliveryRejectionCode, startContextReadStage } from '@evomap/evolver-core/prompt-recall';
import { waitContextDelivery, writeHookStdout } from './promptRecallShared.js';
export { waitContextDelivery } from './promptRecallShared.js';
/** Both production context entrypoints share the same prepare -> actual callback -> projection protocol. */
export async function deliverContextOutput(options) {
    const deadlineAt = Date.now() + 200;
    const finishPreparation = startContextReadStage('delivery_prepare');
    let failureCode = 'timeout';
    const { text, prepare, stdout, stdoutWithSettlement, onOutputWritten } = options;
    let prepared;
    const release = (owned) => {
        try {
            owned.release();
        }
        catch { /* Release is unconfirmed; the durable core/service owner remains authoritative. */ }
    };
    const unused = (owned) => {
        const finishCleanup = startContextReadStage('delivery_cleanup');
        try {
            owned.outputUnknown();
        }
        catch {
            finishCleanup?.('rejected');
            return;
        } // Keep the capability when its unknown-output transition is unconfirmed.
        try {
            owned.release();
            finishCleanup?.('fulfilled');
        }
        catch {
            finishCleanup?.('rejected'); /* The durable owner remains authoritative. */
        }
    };
    const valid = (owned) => Boolean(owned && typeof owned.confirmOutput === 'function' && typeof owned.outputUnknown === 'function'
        && typeof owned.project === 'function' && typeof owned.release === 'function');
    // Start the one absolute budget before invoking preparation. Its original
    // continuation retains ownership after caller timeout; only a timely durable
    // capability admits stdout, and a late one can never dispatch or project.
    let expired = false;
    try {
        const attempt = prepare?.({ deadlineAt });
        if (!prepare)
            failureCode = 'not_configured';
        const continuation = Promise.resolve(attempt).then(owned => {
            if (!valid(owned)) {
                if (prepare)
                    failureCode = 'invalid_capability';
                return undefined;
            }
            if (expired || Date.now() >= deadlineAt) {
                failureCode = 'deadline';
                unused(owned);
                return undefined;
            }
            return owned;
        }, error => { failureCode = contextDeliveryRejectionCode(error); return undefined; });
        prepared = await waitContextDelivery(continuation, Math.max(0, deadlineAt - Date.now()));
        if (!prepared) {
            expired = true;
            finishPreparation?.('rejected', failureCode);
            return 'prepare_failed';
        }
        if (Date.now() >= deadlineAt) {
            expired = true;
            unused(prepared);
            finishPreparation?.('rejected', 'deadline');
            return 'prepare_failed';
        }
        finishPreparation?.('fulfilled', 'prepared');
    }
    catch (error) {
        finishPreparation?.('rejected', contextDeliveryRejectionCode(error));
        return 'prepare_failed';
    }
    let settled = false;
    let outputWritten = false;
    let projection;
    const actual = (written) => {
        if (settled)
            return;
        settled = true;
        outputWritten = written;
        if (!written) {
            try {
                prepared?.outputUnknown();
            }
            catch { /* Private transition remains retained. */ }
            if (prepared)
                release(prepared);
            return;
        }
        // Confirmation precedes optional logging and the caller's completion notification.
        try {
            prepared?.confirmOutput();
        }
        catch { /* Same capability is retained for confirmation-only recovery. */ }
        try {
            onOutputWritten?.();
        }
        catch { /* Observer cannot invalidate stdout. */ }
        const owned = prepared;
        try {
            // Join the original projection, including after our bounded wait. A
            // cleanup RPC failure cannot revoke the physical write acknowledgement
            // or become a detached rejection. It does not prove the owner released.
            projection = owned.project({ deadlineAt: Date.now() + 200 }).catch(() => undefined).then(() => release(owned));
        }
        catch { /* A malformed synchronous projector retains its original owner for recovery. */ }
    };
    try {
        if (stdoutWithSettlement) {
            // Adapter completion may lag its actual write callback indefinitely.
            // Bound only caller waiting; the original callback still owns settlement,
            // and a late rejection cannot revoke a write or dispatch output again.
            await waitContextDelivery(Promise.resolve().then(() => stdoutWithSettlement(text, actual)), 1000);
        }
        else if (stdout) {
            // A custom callback is privileged. Its actual promise owns the attempt even after our bounded wait.
            const run = Promise.resolve().then(() => stdout(text)).then(() => { actual(true); return true; }, () => { actual(false); return false; });
            const result = await waitContextDelivery(run, 1000);
            if (!result)
                return 'output_unknown';
        }
        else {
            await writeHookStdout(text, { onSettled: actual });
        }
    }
    catch {
        // Adapter failure cannot revoke the original callback's acknowledgement.
        // Without one, timeout is not settlement and the callback still owns prepared.
        if (!outputWritten)
            return 'output_unknown';
    }
    if (!outputWritten)
        return 'output_unknown'; // Adapter completion alone is not an actual write acknowledgement.
    if (projection)
        await waitContextDelivery(projection);
    return 'written';
}