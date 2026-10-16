import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
/** The public npm runtime is Node; standalone releases run Bun, which has no node:sqlite module. */
export function openSqliteDatabase(path, options = {}) {
    if (options.create === false && (path === '' || path === ':memory:'))
        throw new Error('sqlite_existing_file_required');
    if (typeof process.versions.bun === 'string') {
        const { Database } = require('bun:sqlite');
        const database = options.readOnly ? new Database(path, { readonly: true })
            : options.create === false ? new Database(path, { readwrite: true, create: false }) : new Database(path);
        const pending = new Set();
        let closed = false;
        let closing = false;
        const live = () => { if (closed || closing)
            throw new Error('sqlite_database_closed'); };
        const prepare = (sql) => { live(); const statement = database.prepare(sql); pending.add(statement); return statement; };
        return {
            exec: (sql) => { live(); return database.exec(sql); },
            close: () => {
                if (closed)
                    return;
                closing = true; // Partial finalization is terminal for admission, but cleanup remains retryable.
                for (const statement of pending) {
                    statement.finalize();
                    pending.delete(statement);
                }
                database.close(true);
                closed = true;
            },
            prepare: (sql) => {
                let statement = prepare(sql);
                // Bun 1.3.14 close(false) keeps prepare() handles alive; close(true) only reports BUSY.
                // Finalize after each materialized operation so long-lived stores do not accumulate native
                // statements until GC. Wrappers remain reusable and reprepare on subsequent operations.
                const use = (run) => {
                    live();
                    const current = statement ??= prepare(sql);
                    try {
                        return run(current);
                    }
                    finally {
                        // Finalization cannot undo an autocommitted write or replace its original error.
                        // Retain failed cleanup for close(), but prohibit every new operation meanwhile.
                        statement = undefined;
                        try {
                            current.finalize();
                            pending.delete(current);
                        }
                        catch {
                            closing = true;
                        }
                    }
                };
                return {
                    get: (...args) => use(current => current.get(...args) ?? undefined),
                    all: (...args) => use(current => current.all(...args)),
                    run: (...args) => use(current => current.run(...args)),
                };
            },
        };
    }
    const { DatabaseSync } = require('node:sqlite');
    if (options.create === false) {
        // Node opens with SQLITE_OPEN_URI. The URI mode prevents an unlink between
        // an ownership check and SQLite open from silently recreating the journal.
        const uri = pathToFileURL(path);
        uri.searchParams.set('mode', options.readOnly ? 'ro' : 'rw');
        return options.readOnly ? new DatabaseSync(uri.href, { readOnly: true }) : new DatabaseSync(uri.href);
    }
    return options.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
}