// Auto-recall observation (#274) — derive a session's recall verdicts from its TRANSCRIPT, not from an agent
// self-reporting via a tool it will skip. For a session that had a `value.inject` (tied by #205 sessionId), run
// the recallVerifier over the transcript turns and emit one `value.recall` per injected gene (used/unused/unknown).
// This feeds the experience loop with OBSERVED data, turning the inert manual `evolver recall` into the loop's
// real, unbiased input. PURE-ish + injectable; best-effort + never throws (it must never break session ingest).
import { events, ops, assetstore, util } from '@evomap/evolver-core';
import { createHash } from 'node:crypto';
import { sessionIdFromTranscript, pickInjectEvent, geneIdsOf, geneFromRecallSelection, resolveGene } from './recall.js';
const builtInObservationSink = events.Ingestor.isBuiltInObservationSink;
// Prefer the persistence target over callback identity. In-memory embedders share their sink.
// A busy session is retried by a later tick, never queued behind a possibly hung backend.
// Bounded waiting retains an independent intent for an unknown append before releasing these leases.
const injectedPathLeases = new Map();
const injectedSinkLeases = new WeakMap();
// Failed SQLite close or lease release still owns a resource. Keep one active/
// pending resource per canonical log path instead of replacing it on retry.
// Admission is bounded: never evict an owner to make room for a new allocation.
const MAX_OWNED_RECALL_RESOURCES = 64;
const ownedRecallResources = new Map();
function observationDispatch(ingestor, expectedPath) {
    if (!expectedPath || !builtInObservationSink(ingestor))
        throw new Error('unsupported_unsupervised_context_observation_sink_v1');
    return raw => ops.builtInContextObservationDispatch(ingestor, raw, expectedPath);
}
function finishOwnedRecallCleanup(path) {
    const owned = ownedRecallResources.get(path);
    if (!owned)
        return true;
    if (owned.active)
        return false;
    try {
        owned.cleanup();
        ownedRecallResources.delete(path);
        return true;
    }
    catch {
        // Retry only cleanup on the next call. An already acknowledged append must
        // never be replayed to recover a database handle or its tick lease.
        return false;
    }
}
function hasOwnedRecallCapacity() {
    if (ownedRecallResources.size < MAX_OWNED_RECALL_RESOURCES)
        return true;
    // Recover abandoned logs without revisiting their business operation. Active
    // owners and failed cleanup stay retained; at most 64 owners are examined.
    for (const path of [...ownedRecallResources.keys()]) {
        finishOwnedRecallCleanup(path);
        if (ownedRecallResources.size < MAX_OWNED_RECALL_RESOURCES)
            return true;
    }
    return false;
}
/**
 * Derive + emit `value.recall` for ONE session transcript. Returns the number of verdicts emitted (0 when there is
 * no matching inject, no resolvable gene, or the session was already recalled). Idempotent: a session whose
 * `value.recall` already exists is skipped, so a polling daemon never re-emits. Best-effort: failures retain the
 * acknowledged prefix count (0 if none); an unconfirmed append is never counted as successful.
 */
export async function emitSessionRecall(transcriptPath, turns, deps) {
    // A structural V1 method is only a promise supplied by the adapter: a hung or
    // dishonest same-process callback cannot be stopped and joined by its caller.
    // Product recall therefore admits only the built-in writer, whose owned I/O
    // and durable receipt can be recovered after cancellation or process restart.
    // Check the constructor brand before reading ANY property from the injected
    // value: a Proxy getter itself can dispatch unsupervised work.
    if (!builtInObservationSink(deps.ingestor))
        throw new Error('unsupported_unsupervised_context_observation_sink_v1');
    // A pathless injected sink cannot bind its terminal receipt to durable history.
    // Its in-memory intent disappears on restart, so the same observation could be
    // dispatched again even after a successful append to an unknown destination.
    // Reject before reading or reserving; a caller-supplied readEvents callback is
    // not proof that the sink writes to that reader's source.
    let sinkPath;
    try {
        sinkPath = deps.ingestor.path;
    }
    catch {
        throw new Error('unsupported_unbound_context_observation_sink_v1');
    }
    if (typeof sinkPath !== 'string' || !sinkPath.trim())
        throw new Error('unsupported_unbound_context_observation_sink_v1');
    if (deps.contextIndex && !deps.contextIndex.observationReady)
        return 0;
    const session = deps.sessionId ?? sessionIdFromTranscript(transcriptPath);
    if (!session)
        return 0;
    let path;
    try {
        const declared = [deps.contextIndex?.eventsPath, deps.eventsPath, sinkPath]
            .filter((value) => value !== undefined).map(util.canonicalEventPath);
        path = declared[0];
        // A receipt checked/indexed in one log cannot be acknowledged by writing to
        // another. Validate every declared identity before any read, allocation or
        // retained cleanup; rejecting a bad composition must not replace its owner.
        if (declared.some(value => value !== path))
            return 0;
    }
    catch {
        return 0;
    }
    if (!path)
        return 0;
    if (path && !finishOwnedRecallCleanup(path))
        return 0;
    const sinkLeases = injectedSinkLeases.get(deps.ingestor) ?? new Set();
    const pathLeases = path ? (injectedPathLeases.get(path) ?? new Set()) : undefined;
    // Hold BOTH identities. Explicit/implicit paths and wrappers of the same sink must
    // overlap, while the public Ingestor.path unifies distinct writers of the same log.
    if (sinkLeases.has(session) || pathLeases?.has(session))
        return 0;
    let readerLease;
    if (path && deps.readEvents && !deps.contextIndex) {
        if (!hasOwnedRecallCapacity())
            return 0;
        const lockPath = `${path}.context-index.sqlite.lock`;
        let owner;
        try {
            owner = util.acquireLock(lockPath, { maxTries: 1, waitMs: 0 });
        }
        catch {
            return 0;
        }
        // Trusted readers must take a fresh snapshot of this declared path AFTER
        // acquiring the same lease used by the durable production index.
        readerLease = { active: true, cleanup: () => {
                const result = util.releaseLock(lockPath, owner);
                if (!result.released)
                    throw new util.LockReleaseError(result.reason);
            } };
        ownedRecallResources.set(path, readerLease);
    }
    injectedSinkLeases.set(deps.ingestor, sinkLeases);
    sinkLeases.add(session);
    if (path && pathLeases) {
        injectedPathLeases.set(path, pathLeases);
        pathLeases.add(session);
    }
    try {
        return await emitSessionRecallUnderLease(transcriptPath, turns, { ...deps, eventsPath: path });
    }
    finally {
        sinkLeases.delete(session);
        if (sinkLeases.size === 0)
            injectedSinkLeases.delete(deps.ingestor);
        pathLeases?.delete(session);
        if (path && pathLeases?.size === 0)
            injectedPathLeases.delete(path);
        if (path && readerLease) {
            readerLease.active = false;
            finishOwnedRecallCleanup(path);
        }
    }
}
async function emitSessionRecallUnderLease(transcriptPath, turns, deps) {
    let ownedPath;
    let ownedIndex;
    let emitted = 0;
    let wait;
    // The default sink budget starts after durable reservation. An explicit absolute
    // caller deadline still includes preparation and is never extended.
    const waiting = () => wait ??= { ...deps.observationWait };
    const sharedWait = {};
    const intents = () => ops.durableObservationIntents(deps.eventsPath);
    const dispatch = observationDispatch(deps.ingestor, deps.eventsPath);
    const stillBound = () => {
        try {
            const current = deps.ingestor.path;
            return typeof current === 'string' && util.canonicalEventPath(current) === deps.eventsPath;
        }
        catch {
            return false;
        }
    };
    try {
        const sessionId = deps.sessionId ?? sessionIdFromTranscript(transcriptPath);
        if (!sessionId)
            return 0; // no stable session key → cannot dedup safely → skip (never risk re-emitting)
        let index = deps.contextIndex;
        if (!index && !deps.readEvents && deps.eventsPath) {
            if (!hasOwnedRecallCapacity())
                return 0;
            ownedPath = deps.eventsPath;
            const created = new ops.GeneContextObservationIndex(ownedPath);
            index = created;
            ownedIndex = { cleanup: () => created.close(), active: true };
            ownedRecallResources.set(ownedPath, ownedIndex);
            index.beginTick();
        }
        if (index) {
            const observation = await index.observeSession(sessionId, deps.ingestor, 64, waiting());
            emitted += observation.emitted;
            if (observation.hasDelivery || !observation.historyComplete || deps.contextOnly)
                return observation.emitted;
        }
        const read = deps.readEvents ?? events.readEvents;
        const evts = read(deps.eventsPath);
        // A static reader may rebind an injected sink. Refuse before reserving a
        // durable intent; a factory that throws after reservation is ambiguous.
        if (!stillBound())
            return emitted;
        const deliveries = evts.filter((event) => event.type === ops.GENE_CONTEXT_DELIVERY_EVENT
            && event.payload?.['sessionId'] === sessionId && event.payload['transport'] === 'stdout_written'
            && ops.readGeneContextDeliveryReceipt(event.payload['receipt']));
        if (deliveries.length > 0) {
            const observed = new Set(evts.filter((event) => event.type === ops.GENE_CONTEXT_OBSERVATION_EVENT
                && event.payload?.['sessionId'] === sessionId).map((event) => `${String(event.payload['deliverySeq'])}:${String(event.payload['digest'])}:${String(event.payload['deliveryIdentity'] ?? '')}`));
            for (const delivery of deliveries) {
                if (!stillBound())
                    return emitted;
                const receipt = ops.readGeneContextDeliveryReceipt(delivery.payload['receipt']);
                const identity = ops.geneContextDeliveryIdentity(delivery, sessionId, receipt.digest);
                const legacyKey = `${delivery.seq}:${receipt.digest}:`;
                const key = `${legacyKey}${identity}`;
                if (observed.has(key) || observed.has(legacyKey))
                    continue;
                const hash = (value) => createHash('sha256').update(value).digest('hex');
                const session = hash(sessionId);
                const result = await ops.settleContextObservation(intents(), JSON.stringify([deps.eventsPath ?? null, session, identity]), dispatch({ type: ops.GENE_CONTEXT_OBSERVATION_EVENT,
                    human: { title: 'Context delivery attribution unavailable' },
                    payload: { sessionId, deliverySeq: delivery.seq, digest: receipt.digest, deliveryIdentity: identity,
                        observedUse: 'unknown', reason: 'no_trusted_turn_boundary',
                        geneCount: receipt.geneAssetIds.length, caseCount: receipt.capsuleAssetIds.length,
                        receiptTruncated: receipt.truncated } }), waiting(), sharedWait);
                if (result === 'pending')
                    continue;
                observed.add(key);
                if (result === 'committed')
                    emitted++;
            }
            return emitted;
        }
        if (deps.contextOnly || turns.length === 0)
            return 0;
        const inject = pickInjectEvent(evts, sessionId);
        // Only auto-recall when the inject is PROVABLY this session's (#205 stamped match). Without a stamped match we
        // would be guessing which inject produced this transcript — too weak a basis to emit observed verdicts.
        if (!inject || inject.payload?.['sessionId'] !== sessionId)
            return 0;
        const geneIds = [...new Set(geneIdsOf(inject))]; // dedup: a duplicated inject id must not double-emit (#275 Bugbot)
        if (geneIds.length === 0)
            return 0;
        // Per-gene state from prior ticks (#275 Bugbot). A `used` verdict is TERMINAL — using a gene is monotonic as the
        // transcript grows, so once used it stays used. `unused`/`unknown` are PROVISIONAL: the ingest tick can run while
        // a transcript is still growing, so a later tick (longer transcript) may UPGRADE them to `used`. Therefore: skip
        // genes already `used`; emit a first verdict; for a gene that only has a provisional verdict, emit ONLY when it
        // now upgrades to `used` — never duplicate the same provisional, and never lock a stale `unused`.
        const usedGenes = new Set();
        const seenGenes = new Set();
        for (const e of evts) {
            if (e.type !== ops.VALUE_RECALL_EVENT || e.payload?.['sessionId'] !== sessionId)
                continue;
            const gid = e.payload['geneId'];
            if (typeof gid !== 'string')
                continue;
            seenGenes.add(gid);
            if (e.payload['recalled'] === 'used')
                usedGenes.add(gid);
        }
        const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
        const genes = [];
        for (const id of geneIds) {
            const a = await resolveGene(store, id);
            if (a) {
                const gene = geneFromRecallSelection(a, id, inject);
                if (gene)
                    genes.push(gene);
            }
        }
        if (genes.length === 0)
            return 0;
        const results = ops.verifyInjectedGenes(genes, turns);
        for (const r of results) {
            if (!stillBound())
                return emitted;
            if (usedGenes.has(r.geneId))
                continue; // terminal: already used
            if (seenGenes.has(r.geneId) && r.recalled !== 'used')
                continue; // provisional already recorded; only an upgrade to `used` is new
            const payload = { geneId: r.geneId, recalled: r.recalled, score: r.score, sessionId };
            try {
                const result = await ops.settleContextObservation(intents(), JSON.stringify([deps.eventsPath ?? null, sessionId,
                    inject.eventId, inject.seq, inject.ts, r.geneId, r.recalled]), dispatch({
                    type: ops.VALUE_RECALL_EVENT,
                    // 展示标题遵守既有 80 字符上限；payload 中的完整版本身份不能截断。
                    human: { title: `recall ${r.recalled}: ${r.geneId}`.slice(0, 80), detail: `session ${sessionId}` },
                    payload: payload,
                }), waiting(), sharedWait);
                if (result === 'committed')
                    emitted += 1;
            }
            catch { /* per-gene best-effort; keep going */ }
        }
        return emitted;
    }
    catch (error) {
        return error instanceof ops.ContextObservationFailure ? Math.max(emitted, error.emitted) : emitted;
    }
    finally {
        if (ownedIndex && ownedPath) {
            ownedIndex.active = false;
            finishOwnedRecallCleanup(ownedPath);
        }
    }
}