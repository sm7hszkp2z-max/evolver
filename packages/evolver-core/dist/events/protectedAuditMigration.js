import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeSync, writeFileSync, chownSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { openSqliteDatabase } from '../util/sqlite.js';
import { rootEvent } from './eventSchema.js';
import { rootEventArchiveDir } from './eventArchive.js';
const SEGMENT = /^root-events-(\d{16})-(\d{16})\.jsonl$/;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
function fail(reason) { throw new Error(`protected_audit_migration: ${reason}`); }
function statOptional(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function requireDirectory(path, owner) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o022) !== 0) {
        fail('directory_untrusted');
    }
}
function sourceAncestors(path, clientUid) {
    let current = dirname(resolve(path));
    for (;;) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, clientUid].includes(stat.uid))
            fail('source_parent_untrusted');
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}
function readSource(path, clientUid) {
    const named = statOptional(path);
    if (!named)
        return undefined;
    sourceAncestors(path, clientUid);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.uid !== clientUid
        || named.size > MAX_SOURCE_BYTES)
        fail(`source_untrusted:${path}`);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== clientUid
            || before.dev !== named.dev || before.ino !== named.ino || before.size > MAX_SOURCE_BYTES) {
            fail(`source_changed:${path}`);
        }
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count < 1)
                fail(`source_short_read:${path}`);
            offset += count;
        }
        const after = fstatSync(fd), now = lstatSync(path);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1
            || now.dev !== before.dev || now.ino !== before.ino || now.nlink !== 1)
            fail(`source_changed:${path}`);
        return { bytes, identity: identity(before), size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
    }
    finally {
        closeSync(fd);
    }
}
function writeSnapshot(path, source) {
    const fd = openSync(path, 'wx', 0o600);
    try {
        let offset = 0;
        while (offset < source.bytes.length)
            offset += writeSync(fd, source.bytes, offset, source.bytes.length - offset);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== source.size)
        fail('copy_changed');
    return { bytes: source.bytes, identity: identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function checkSqlite(path) {
    for (const suffix of ['-wal', '-shm', '-journal'])
        if (statOptional(`${path}${suffix}`))
            fail(`sqlite_sidecar_present:${path}${suffix}`);
    const db = openSqliteDatabase(path, { create: false, readOnly: true });
    try {
        if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok')
            fail(`sqlite_integrity:${path}`);
    }
    finally {
        db.close();
    }
}
function parseLines(snapshot, source) {
    if (snapshot.bytes.length && snapshot.bytes[snapshot.bytes.length - 1] !== 10)
        fail(`partial_root_tail:${source}`);
    const out = [];
    for (const raw of snapshot.bytes.toString('utf8').split('\n')) {
        if (!raw)
            continue;
        try {
            const event = rootEvent.parse(JSON.parse(raw));
            out.push({ seq: event.seq, raw });
        }
        catch {
            fail(`invalid_root_row:${source}`);
        }
    }
    return out;
}
function validateHistory(active, archive) {
    const bySeq = new Map();
    for (const [name, source] of archive) {
        const rows = parseLines(source, name);
        const match = SEGMENT.exec(name);
        if (!rows.length || rows[0].seq !== Number(match[1]) || rows.at(-1).seq !== Number(match[2]))
            fail(`archive_range_invalid:${name}`);
        for (let i = 1; i < rows.length; i++)
            if (rows[i].seq !== rows[i - 1].seq + 1)
                fail(`archive_gap:${name}`);
        for (const row of rows) {
            const prior = bySeq.get(row.seq);
            if (prior !== undefined && prior !== row.raw)
                fail(`archive_conflict:${row.seq}`);
            bySeq.set(row.seq, row.raw);
        }
    }
    if (active)
        for (const row of parseLines(active, 'active')) {
            const prior = bySeq.get(row.seq);
            if (prior !== undefined && prior !== row.raw)
                fail(`active_archive_conflict:${row.seq}`);
            bySeq.set(row.seq, row.raw);
        }
    const ordered = [...bySeq.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i++)
        if (ordered[i] !== i + 1)
            fail(`root_history_gap:${i + 1}`);
    return Buffer.byteLength(JSON.stringify(ordered.map(seq => JSON.parse(bySeq.get(seq)))));
}
function callSnapshotBytes(source) {
    if (!source)
        return 2;
    const rows = [];
    for (const line of source.bytes.toString('utf8').split('\n')) {
        if (!line)
            continue;
        try {
            const value = JSON.parse(line);
            if (value && typeof value === 'object' && !Array.isArray(value)
                && typeof value['timestamp'] === 'string'
                && typeof value['action'] === 'string'
                && value['action'])
                rows.push(value);
        }
        catch { /* Legacy call reader skips corrupt lines. */ }
    }
    return Buffer.byteLength(JSON.stringify(rows));
}
function migrateDeliveryJournal(sourcePath, destination, oldTarget, newTarget, oldFiles, newFiles) {
    const db = openSqliteDatabase(destination, { create: false });
    try {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        try {
            const instance = db.prepare('SELECT target, parent_identity, journal_identity FROM context_delivery_instance WHERE id=1').get();
            if (!instance || instance['target'] !== oldTarget
                || instance['parent_identity'] !== identity(lstatSync(dirname(oldTarget)))
                || instance['journal_identity'] !== identity(lstatSync(sourcePath)))
                fail('delivery_namespace_unverified');
            const map = new Map();
            for (const [name, source] of oldFiles) {
                const replacement = newFiles.get(name);
                if (replacement)
                    map.set(source.identity, replacement.identity);
            }
            const findPlan = (value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    fail('delivery_plan_invalid');
                const plan = value;
                const file = plan['archive'] === undefined ? oldTarget : join(rootEventArchiveDir(oldTarget), String(plan['archive']));
                const old = oldFiles.get(file), next = newFiles.get(file);
                if (!old || !next || old.identity !== plan['identity'] || !Number.isSafeInteger(plan['offset'])
                    || typeof plan['line'] !== 'string' || old.bytes.subarray(Number(plan['offset']), Number(plan['offset']) + Buffer.byteLength(plan['line'])).toString('utf8') !== plan['line']) {
                    return value; // Ambiguous locator remains unknown; recovery may only perform exact readback.
                }
                const updated = { ...plan, identity: next.identity };
                if (plan['previous'] && typeof plan['previous'] === 'object' && !Array.isArray(plan['previous'])) {
                    const previous = plan['previous'];
                    updated['previous'] = { ...previous, identity: map.get(String(previous['identity'])) ?? previous['identity'] };
                }
                return updated;
            };
            const rows = db.prepare('SELECT operation_id, state, target_identity, plan FROM context_deliveries').all();
            for (const row of rows) {
                if (!['prepared', 'output_unknown', 'confirmed', 'projecting', 'projection_unknown', 'projected'].includes(String(row['state'])))
                    fail('delivery_state_invalid');
                let target = row['target_identity'];
                if (typeof target === 'string') {
                    if (target.startsWith('[')) {
                        const values = JSON.parse(target);
                        if (!Array.isArray(values) || values.length !== 2 || values.some(value => typeof value !== 'string'))
                            fail('delivery_identity_invalid');
                        target = JSON.stringify(values.map(value => map.get(value) ?? value));
                    }
                    else
                        target = map.get(target) ?? target;
                }
                else if (target !== null)
                    fail('delivery_identity_invalid');
                const plan = row['plan'] === null ? null : JSON.stringify(findPlan(JSON.parse(String(row['plan']))));
                db.prepare('UPDATE context_deliveries SET target_identity=?, plan=? WHERE operation_id=?').run(target, plan, row['operation_id']);
            }
            db.prepare('UPDATE context_delivery_instance SET target=?, parent_identity=?, journal_identity=? WHERE id=1')
                .run(newTarget, identity(lstatSync(dirname(destination))), identity(lstatSync(destination)));
            db.exec('COMMIT');
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    finally {
        db.close();
    }
    checkSqlite(destination);
}
function migrateIndex(sourcePath, destination, oldTarget, newTarget, oldFiles, newFiles) {
    const db = openSqliteDatabase(destination, { create: false });
    try {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        try {
            const version = db.prepare("SELECT value FROM context_state WHERE key='version'").get()?.['value'];
            if (version !== '5')
                fail('context_index_version_unverified');
            const relocated = (value) => value === oldTarget ? newTarget
                : value.startsWith(`${rootEventArchiveDir(oldTarget)}/`)
                    ? join(rootEventArchiveDir(newTarget), value.slice(rootEventArchiveDir(oldTarget).length + 1))
                    : fail('context_index_path_unverified');
            for (const row of db.prepare('SELECT path, state FROM context_cursors').all()) {
                const source = oldFiles.get(String(row['path']));
                const replacement = newFiles.get(String(row['path']));
                const state = JSON.parse(String(row['state']));
                if (!source || !replacement || state['identity'] !== source.identity || !Number.isSafeInteger(state['offset'])
                    || Number(state['offset']) < 0 || Number(state['offset']) > source.size)
                    fail('context_cursor_unverified');
                state['identity'] = replacement.identity;
                state['mtimeMs'] = replacement.mtimeMs;
                const path = relocated(String(row['path']));
                db.prepare('DELETE FROM context_cursors WHERE path=?').run(row['path']);
                db.prepare('INSERT INTO context_cursors VALUES (?, ?)').run(path, JSON.stringify(state));
            }
            for (const row of db.prepare('SELECT path, reason FROM context_issues').all()) {
                if (!oldFiles.has(String(row['path'])))
                    fail('context_issue_unverified');
                const path = relocated(String(row['path']));
                db.prepare('DELETE FROM context_issues WHERE path=?').run(row['path']);
                db.prepare('INSERT INTO context_issues VALUES (?, ?)').run(path, row['reason']);
            }
            db.exec('COMMIT');
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    finally {
        db.close();
    }
    checkSqlite(destination);
}
function chownTree(path, uid, gid) {
    for (const name of readdirSync(path)) {
        const child = join(path, name), stat = lstatSync(child);
        if (stat.isSymbolicLink())
            fail('staged_symlink');
        if (stat.isDirectory())
            chownTree(child, uid, gid);
        else if (stat.isFile())
            chownSync(child, uid, gid);
        else
            fail('staged_object_invalid');
    }
    chownSync(path, uid, gid);
}
function fsyncDirectory(path) {
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sourceInventory(plan) {
    const root = plan.rootEventsPath;
    const files = new Map();
    for (const path of [root, plan.assetCallLogPath, `${root}.context-deliveries.sqlite`,
        `${root}.context-observation-intents.sqlite`, `${root}.context-index.sqlite`]) {
        files.set(path, readSource(path, plan.clientUid));
    }
    const archiveDir = rootEventArchiveDir(root), stat = statOptional(archiveDir);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== plan.clientUid))
        fail('archive_directory_untrusted');
    const archiveNames = stat ? readdirSync(archiveDir).sort() : [];
    for (const name of archiveNames) {
        if (!SEGMENT.test(name))
            fail(`archive_entry_unverified:${name}`);
        files.set(join(archiveDir, name), readSource(join(archiveDir, name), plan.clientUid));
    }
    return { files, archivePresent: Boolean(stat), archiveNames };
}
function fenceDirectories(plan) {
    const selected = new Map();
    for (const source of [plan.rootEventsPath, plan.assetCallLogPath]) {
        let current = dirname(source), highest;
        for (;;) {
            const stat = statOptional(current);
            if (!stat) {
                current = dirname(current);
                continue;
            }
            if (!stat.isDirectory() || stat.isSymbolicLink())
                fail('fence_parent_untrusted');
            if (stat.uid === plan.clientUid) {
                highest = { path: current, identity: identity(stat), uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode) & 0o7777 };
            }
            else {
                if (stat.uid !== 0 || (Number(stat.mode) & 0o022) !== 0)
                    fail('fence_parent_untrusted');
                break;
            }
            const parent = dirname(current);
            if (parent === current)
                fail('fence_root_untrusted');
            current = parent;
        }
        if (!highest)
            fail('client_owned_source_parent_required');
        selected.set(highest.path, highest);
    }
    return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function readFence(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0
        || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024)
        fail('source_fence_untrusted');
    return JSON.parse(readFileSync(path, 'utf8'));
}
function normalizeFenceDirectories(fence) {
    if (!Array.isArray(fence.directories))
        fail('source_fence_changed');
    for (const directory of fence.directories) {
        if (!directory || typeof directory.path !== 'string' || typeof directory.identity !== 'string'
            || !Number.isSafeInteger(directory.uid) || !Number.isSafeInteger(directory.gid)
            || !Number.isInteger(directory.mode) || directory.mode < 0 || directory.mode > 0o7777) {
            fail('source_fence_changed');
        }
        const stat = lstatSync(directory.path), mode = stat.mode & 0o7777;
        const clientState = stat.uid === directory.uid && stat.gid === directory.gid;
        const rootState = stat.uid === 0 && stat.gid === 0;
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== directory.identity
            || !((clientState || rootState) && (mode === directory.mode || mode === 0o700))) {
            fail('source_fence_changed');
        }
        // Tighten before changing ownership. This makes every interrupted state retryable
        // without leaving a root-owned directory writable by the client.
        if (mode !== 0o700)
            chmodSync(directory.path, 0o700);
        if (!rootState)
            chownSync(directory.path, 0, 0);
        const fenced = lstatSync(directory.path);
        if (fenced.uid !== 0 || fenced.gid !== 0 || (fenced.mode & 0o7777) !== 0o700
            || identity(fenced) !== directory.identity)
            fail('source_fence_changed');
    }
}
/** Root takes the highest client-owned source ancestors before the first import read. */
export function fenceProtectedAuditSources(plan, planPath) {
    if (process.getuid?.() !== 0 || plan.clientUid === plan.serviceUid)
        fail('source_fence_principal_invalid');
    const fencePath = `${planPath}.fence`;
    let fence;
    if (existsSync(fencePath))
        fence = readFence(fencePath);
    else {
        const inventory = sourceInventory(plan);
        fence = { version: 1, clientUid: plan.clientUid, rootEventsPath: plan.rootEventsPath,
            assetCallLogPath: plan.assetCallLogPath, directories: fenceDirectories(plan),
            source: sourceManifest(inventory.files), archivePresent: inventory.archivePresent,
            archiveNames: inventory.archiveNames };
        writeFileSync(fencePath, JSON.stringify(fence), { flag: 'wx', mode: 0o600 });
        const fd = openSync(fencePath, 'r');
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        fsyncDirectory(dirname(fencePath));
    }
    if (fence.version !== 1 || fence.clientUid !== plan.clientUid
        || fence.rootEventsPath !== plan.rootEventsPath || fence.assetCallLogPath !== plan.assetCallLogPath
        || !Array.isArray(fence.directories) || !Array.isArray(fence.source))
        fail('source_fence_changed');
    normalizeFenceDirectories(fence);
    const inventory = sourceInventory(plan);
    if (JSON.stringify(sourceManifest(inventory.files)) !== JSON.stringify(fence.source)
        || inventory.archivePresent !== fence.archivePresent
        || JSON.stringify(inventory.archiveNames) !== JSON.stringify(fence.archiveNames))
        fail('source_changed_during_fence');
}
/** Repeatable after a crash; used only after protected admission or explicit administrator rollback. */
export function unfenceProtectedAuditSources(plan, planPath) {
    const fence = readFence(`${planPath}.fence`);
    if (process.getuid?.() !== 0 || fence.version !== 1 || fence.clientUid !== plan.clientUid
        || fence.rootEventsPath !== plan.rootEventsPath || fence.assetCallLogPath !== plan.assetCallLogPath)
        fail('source_fence_changed');
    // Re-lock partial rollback states before inspecting source files again.
    normalizeFenceDirectories(fence);
    const inventory = sourceInventory(plan);
    if (JSON.stringify(sourceManifest(inventory.files)) !== JSON.stringify(fence.source)
        || inventory.archivePresent !== fence.archivePresent
        || JSON.stringify(inventory.archiveNames) !== JSON.stringify(fence.archiveNames))
        fail('source_changed_before_unfence');
    for (const directory of [...fence.directories].reverse()) {
        const stat = lstatSync(directory.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== directory.identity
            || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) {
            fail('source_fence_changed');
        }
        chownSync(directory.path, directory.uid, directory.gid);
        chmodSync(directory.path, directory.mode);
        const restored = lstatSync(directory.path);
        if (!restored.isDirectory() || identity(restored) !== directory.identity
            || restored.uid !== directory.uid || restored.gid !== directory.gid
            || (restored.mode & 0o7777) !== directory.mode)
            fail('source_fence_changed');
    }
}
function sourceManifest(files) {
    return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, source]) => ({ path,
        identity: source?.identity ?? null, size: source?.size ?? 0, mtimeMs: source?.mtimeMs ?? 0,
        ctimeMs: source?.ctimeMs ?? 0, sha256: source ? digest(source.bytes) : null }));
}
function verifySourceInventory(files, clientUid, archiveDir, archivePresent, archiveNames) {
    const archive = statOptional(archiveDir);
    if (Boolean(archive) !== archivePresent || (archive && (!archive.isDirectory() || archive.uid !== clientUid
        || archive.isSymbolicLink())))
        fail('source_archive_changed');
    if (archive && JSON.stringify(readdirSync(archiveDir).sort()) !== JSON.stringify([...archiveNames].sort())) {
        fail('source_archive_changed');
    }
    for (const [path, expected] of files) {
        const current = readSource(path, clientUid);
        if (JSON.stringify(sourceManifest(new Map([[path, expected]])))
            !== JSON.stringify(sourceManifest(new Map([[path, current]]))))
            fail(`source_drift:${path}`);
    }
}
function destinationManifest(root) {
    const files = [];
    const visit = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name), stat = lstatSync(path);
            if (stat.isSymbolicLink())
                fail('private_symlink');
            if (stat.isDirectory())
                visit(path);
            else if (stat.isFile()) {
                const name = relative(root, path);
                if (name !== 'import-manifest.json')
                    files.push({ path: name, sha256: digest(readFileSync(path)) });
            }
            else
                fail('private_object_invalid');
        }
    };
    visit(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
function verifyPrivateTree(path, plan, exactDestination = true) {
    requireDirectory(path, plan.serviceUid);
    if ((lstatSync(path).mode & 0o077) !== 0)
        fail('private_store_public');
    const manifestPath = join(path, 'import-manifest.json');
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== plan.serviceUid
        || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024)
        fail('import_manifest_untrusted');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.clientUid !== plan.clientUid || manifest.serviceUid !== plan.serviceUid
        || manifest.serviceGid !== plan.serviceGid || manifest.rootEventsPath !== plan.rootEventsPath
        || manifest.assetCallLogPath !== plan.assetCallLogPath || !Array.isArray(manifest.source)
        || !Array.isArray(manifest.destination) || typeof manifest.archivePresent !== 'boolean'
        || !Array.isArray(manifest.archiveNames))
        fail('import_manifest_changed');
    const source = new Map();
    for (const row of manifest.source) {
        if (!row || typeof row.path !== 'string' || source.has(row.path))
            fail('import_manifest_changed');
        source.set(row.path, readSource(row.path, plan.clientUid));
    }
    if (JSON.stringify(sourceManifest(source)) !== JSON.stringify(manifest.source))
        fail('source_drift_since_import');
    const archiveDir = rootEventArchiveDir(plan.rootEventsPath);
    const archive = statOptional(archiveDir);
    if (Boolean(archive) !== manifest.archivePresent
        || (archive && JSON.stringify(readdirSync(archiveDir).sort()) !== JSON.stringify([...manifest.archiveNames].sort()))) {
        fail('source_archive_changed');
    }
    if (exactDestination && JSON.stringify(destinationManifest(path)) !== JSON.stringify(manifest.destination))
        fail('private_store_drift');
}
/** A running service may append after import, so an upgrade verifies the
 * original source and import identity without comparing obsolete destination
 * hashes. Every current private object must still belong to the service. */
export function verifyProtectedAuditUpgrade(plan) {
    if (process.getuid?.() !== 0 || !isAbsolute(plan.storageRoot))
        fail('upgrade_plan_invalid');
    requireDirectory(plan.storageRoot, plan.serviceUid);
    const visit = (dir) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name), stat = lstatSync(path);
            if (stat.isSymbolicLink() || stat.uid !== plan.serviceUid || stat.gid !== plan.serviceGid
                || (stat.mode & 0o077) !== 0 || (stat.isFile() && stat.nlink !== 1))
                fail('private_store_untrusted');
            if (stat.isDirectory())
                visit(path);
            else if (!stat.isFile())
                fail('private_store_untrusted');
        }
    };
    visit(plan.storageRoot);
    if (existsSync(join(plan.storageRoot, 'import-manifest.json'))) {
        verifyPrivateTree(plan.storageRoot, plan, false);
    }
}
export function migrateProtectedAuditState(plan, fault) {
    if (process.platform === 'win32' || process.getuid?.() !== 0 || plan.version !== 1
        || !Number.isSafeInteger(plan.clientUid) || plan.clientUid < 1
        || !Number.isSafeInteger(plan.serviceUid) || plan.serviceUid < 1
        || !Number.isSafeInteger(plan.serviceGid) || plan.serviceGid < 1
        || [plan.storageRoot, plan.rootEventsPath, plan.assetCallLogPath].some(path => !isAbsolute(path)
            || path.includes('\0') || resolve(path) !== path)
        || plan.rootEventsPath === plan.assetCallLogPath)
        fail('plan_invalid');
    requireDirectory(dirname(plan.storageRoot), 0);
    const root = plan.rootEventsPath, call = plan.assetCallLogPath;
    const archiveDir = rootEventArchiveDir(root);
    const active = readSource(root, plan.clientUid), callSource = readSource(call, plan.clientUid);
    let rootPhysicalBytes = active?.size ?? 0;
    if (rootPhysicalBytes > 256 * 1024 * 1024 - 4096 || (callSource?.size ?? 0) > 256 * 1024 * 1024 - 4096) {
        fail('source_exceeds_protected_append_capacity');
    }
    const archive = new Map();
    const archiveStat = statOptional(archiveDir);
    if (archiveStat) {
        if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink() || archiveStat.uid !== plan.clientUid)
            fail('archive_directory_untrusted');
        for (const name of readdirSync(archiveDir)) {
            if (!SEGMENT.test(name))
                fail(`archive_entry_unverified:${name}`);
            rootPhysicalBytes += lstatSync(join(archiveDir, name)).size;
            if (rootPhysicalBytes > 256 * 1024 * 1024 - 4096)
                fail('source_exceeds_protected_append_capacity');
            const source = readSource(join(archiveDir, name), plan.clientUid);
            if (!source)
                fail('archive_entry_missing');
            archive.set(name, source);
        }
    }
    const deliveryPath = `${root}.context-deliveries.sqlite`, intentPath = `${root}.context-observation-intents.sqlite`;
    const indexPath = `${root}.context-index.sqlite`;
    const delivery = readSource(deliveryPath, plan.clientUid), intent = readSource(intentPath, plan.clientUid);
    const index = readSource(indexPath, plan.clientUid);
    for (const path of [root, call, deliveryPath, intentPath, indexPath]) {
        for (const suffix of ['.lock', '-wal', '-shm', '-journal'])
            if (statOptional(`${path}${suffix}`))
                fail(`live_or_unrecovered_sidecar:${path}${suffix}`);
    }
    if (!active && (archive.size || delivery || intent || index))
        fail('orphaned_root_state');
    const rootSnapshotSize = validateHistory(active, archive);
    if (rootSnapshotSize > 512 * 1024 * 1024 || callSnapshotBytes(callSource) > 512 * 1024 * 1024) {
        fail('source_exceeds_protected_read_capacity');
    }
    const imported = Boolean(active || callSource || archiveStat || delivery || intent || index);
    if (!imported)
        return { imported: false, rootRecords: 0, callBytes: 0 };
    const rootDir = join(plan.storageRoot, `root-${createHash('sha256').update(root).digest('hex')}`);
    const callDir = join(plan.storageRoot, `call-${createHash('sha256').update(call).digest('hex')}`);
    const sourceFiles = new Map([
        [root, active], [call, callSource], [deliveryPath, delivery], [intentPath, intent], [indexPath, index],
        ...[...archive].map(([name, source]) => [join(archiveDir, name), source]),
    ]);
    if (existsSync(plan.storageRoot)) {
        verifyPrivateTree(plan.storageRoot, plan);
        return { imported: true, rootRecords: active ? parseLines(active, 'active').length : 0, callBytes: callSource?.size ?? 0 };
    }
    const stageRoot = `${plan.storageRoot}.import-${randomUUID()}`;
    const rootStage = join(stageRoot, relative(plan.storageRoot, rootDir));
    const callStage = join(stageRoot, relative(plan.storageRoot, callDir));
    let published = false;
    try {
        mkdirSync(stageRoot, { mode: 0o700 });
        mkdirSync(rootStage, { mode: 0o700 });
        mkdirSync(callStage, { mode: 0o700 });
        const oldFiles = new Map(), newFiles = new Map();
        const stagedRoot = join(rootStage, 'root_events.jsonl'), finalRoot = join(rootDir, 'root_events.jsonl');
        if (active) {
            oldFiles.set(root, active);
            newFiles.set(root, writeSnapshot(stagedRoot, active));
        }
        if (archiveStat) {
            const stagedArchive = rootEventArchiveDir(stagedRoot);
            mkdirSync(stagedArchive, { mode: 0o700 });
            for (const [name, source] of archive) {
                const oldPath = join(archiveDir, name);
                oldFiles.set(oldPath, source);
                newFiles.set(oldPath, writeSnapshot(join(stagedArchive, name), source));
            }
            fsyncDirectory(stagedArchive);
        }
        if (callSource)
            writeSnapshot(join(callStage, 'asset_call_log.jsonl'), callSource);
        if (delivery) {
            const staged = join(rootStage, 'root_events.jsonl.context-deliveries.sqlite');
            writeSnapshot(staged, delivery);
            checkSqlite(staged);
            migrateDeliveryJournal(deliveryPath, staged, root, finalRoot, oldFiles, newFiles);
        }
        if (intent) {
            const staged = join(rootStage, 'root_events.jsonl.context-observation-intents.sqlite');
            writeSnapshot(staged, intent);
            checkSqlite(staged);
        }
        if (index) {
            const staged = join(rootStage, 'root_events.jsonl.context-index.sqlite');
            writeSnapshot(staged, index);
            checkSqlite(staged);
            migrateIndex(indexPath, staged, root, finalRoot, oldFiles, newFiles);
        }
        const manifest = { version: 1, clientUid: plan.clientUid, serviceUid: plan.serviceUid,
            serviceGid: plan.serviceGid, rootEventsPath: root, assetCallLogPath: call,
            archivePresent: Boolean(archiveStat), archiveNames: [...archive.keys()].sort(),
            source: sourceManifest(sourceFiles), destination: destinationManifest(stageRoot) };
        const manifestPath = join(stageRoot, 'import-manifest.json');
        writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
        const manifestFd = openSync(manifestPath, 'r');
        try {
            fsyncSync(manifestFd);
        }
        finally {
            closeSync(manifestFd);
        }
        verifySourceInventory(sourceFiles, plan.clientUid, archiveDir, Boolean(archiveStat), [...archive.keys()]);
        chownTree(stageRoot, plan.serviceUid, plan.serviceGid);
        fsyncDirectory(rootStage);
        fsyncDirectory(callStage);
        fsyncDirectory(stageRoot);
        fault?.beforePublish?.();
        renameSync(stageRoot, plan.storageRoot);
        published = true;
        fsyncDirectory(dirname(plan.storageRoot));
        fault?.afterPublish?.();
        verifyPrivateTree(plan.storageRoot, plan);
        return { imported: true, rootRecords: active ? parseLines(active, 'active').length : 0, callBytes: callSource?.size ?? 0 };
    }
    finally {
        // A published generation is immutable until activation. A failed staging
        // generation is ours alone and can be discarded without touching old data.
        if (!published && resolve(stageRoot).startsWith(`${resolve(dirname(plan.storageRoot))}/`)
            && existsSync(stageRoot))
            rmSync(stageRoot, { recursive: true, force: true });
    }
}
/** Last pre-activation check: no source drift and no private generation drift. */
export function verifyProtectedAuditImport(plan) {
    if (process.getuid?.() !== 0 || !isAbsolute(plan.storageRoot) || !existsSync(plan.storageRoot)) {
        fail('import_not_published');
    }
    verifyPrivateTree(plan.storageRoot, plan);
}
export function runProtectedAuditMigration(planPath, action = 'import') {
    if (!isAbsolute(planPath) || resolve(planPath) !== planPath || process.getuid?.() !== 0)
        fail('plan_path_invalid');
    let parent = dirname(planPath);
    for (;;) {
        requireDirectory(parent, 0);
        const next = dirname(parent);
        if (next === parent)
            break;
        parent = next;
    }
    const stat = lstatSync(planPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o077) !== 0 || stat.size > 4096)
        fail('plan_file_untrusted');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    if (plan.version !== 1 || !Number.isSafeInteger(plan.clientUid) || plan.clientUid < 1
        || !Number.isSafeInteger(plan.serviceUid) || plan.serviceUid < 1
        || !Number.isSafeInteger(plan.serviceGid) || plan.serviceGid < 1
        || plan.clientUid === plan.serviceUid
        || [plan.storageRoot, plan.rootEventsPath, plan.assetCallLogPath].some(path => typeof path !== 'string'
            || !isAbsolute(path) || resolve(path) !== path || path.includes('\0'))
        || plan.rootEventsPath === plan.assetCallLogPath)
        fail('plan_invalid');
    if (action === 'fence')
        fenceProtectedAuditSources(plan, planPath);
    else if (action === 'unfence')
        unfenceProtectedAuditSources(plan, planPath);
    else if (action === 'upgrade-verify') {
        verifyProtectedAuditUpgrade(plan);
        process.stdout.write('protected_audit_upgrade_verified\n');
    }
    else if (action === 'verify') {
        verifyProtectedAuditImport(plan);
        process.stdout.write('protected_audit_import_verified\n');
    }
    else
        process.stdout.write(`${JSON.stringify(migrateProtectedAuditState(plan))}\n`);
}