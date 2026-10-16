/** Offline, administrator-owned import. The old namespace remains untouched for rollback. */
export interface ProtectedAuditMigrationPlan {
    version: 1;
    clientUid: number;
    serviceUid: number;
    serviceGid: number;
    storageRoot: string;
    rootEventsPath: string;
    assetCallLogPath: string;
}
/** Root takes the highest client-owned source ancestors before the first import read. */
export declare function fenceProtectedAuditSources(plan: ProtectedAuditMigrationPlan, planPath: string): void;
/** Repeatable after a crash; used only after protected admission or explicit administrator rollback. */
export declare function unfenceProtectedAuditSources(plan: ProtectedAuditMigrationPlan, planPath: string): void;
/** A running service may append after import, so an upgrade verifies the
 * original source and import identity without comparing obsolete destination
 * hashes. Every current private object must still belong to the service. */
export declare function verifyProtectedAuditUpgrade(plan: ProtectedAuditMigrationPlan): void;
export declare function migrateProtectedAuditState(plan: ProtectedAuditMigrationPlan, fault?: {
    beforePublish?(): void;
    afterPublish?(): void;
}): {
    imported: boolean;
    rootRecords: number;
    callBytes: number;
};
/** Last pre-activation check: no source drift and no private generation drift. */
export declare function verifyProtectedAuditImport(plan: ProtectedAuditMigrationPlan): void;
export declare function runProtectedAuditMigration(planPath: string, action?: 'import' | 'verify' | 'fence' | 'unfence' | 'upgrade-verify'): void;