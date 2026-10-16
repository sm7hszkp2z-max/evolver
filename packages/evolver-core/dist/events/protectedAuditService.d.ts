import { type Server, type Socket } from 'node:net';
import { type ObservationIntentStore } from '../ops/contextObservationSettlement.js';
import { type ProtectedAuditPublication } from './protectedAuditReady.js';
/** Same-token retries are idempotent only for the exact reserved path/key.
 * The durable row, not a lost transport response, decides whether dispatch is
 * new, pending, or already committed. A token cannot be rebound to new input. */
export declare function reserveObservationIntent(path: string, key: string, token: string, store: ObservationIntentStore, now?: number): 'new' | 'pending' | 'committed';
export interface ProtectedAuditServiceConfig {
    readonly version: 1;
    readonly serviceUid: number;
    readonly clientGid: number;
    readonly socketPath: string;
    readonly storageRoot: string;
    readonly rootEventsPath: string;
    readonly assetCallLogPath: string;
    /** Administrator-authorized parent for additional home namespaces. */
    readonly allowedRootPrefix?: string;
}
/** The config is installed by the machine administrator and cannot be supplied from a user-owned path. */
export declare function readProtectedAuditServiceConfig(path: string): ProtectedAuditServiceConfig;
/** Internal framed dispatcher. Startup alone attests the OS principal/config;
 * this is not a public entry point and is never exported by the package barrel. */
export declare function serveSocket(config: ProtectedAuditServiceConfig, socket: Socket, publication: ProtectedAuditPublication): void;
/** Internal lifecycle binding shared by actual startup and the framed component
 * regression. Transport close alone does not settle disconnected storage work. */
export declare function bindProtectedAuditServiceShutdown(server: Server, publication: ProtectedAuditPublication, releaseStartup: () => void): void;
export declare function startProtectedAuditService(configPath: string): Promise<Server>;