import type { AssetRecord, LocalProjectContextV1 } from './provider.js';
export declare function validateLocalProjectContext(value: unknown): LocalProjectContextV1;
export declare function isBoundLocalContext(context: LocalProjectContextV1, assets: readonly (AssetRecord | undefined)[]): boolean;
export declare function assertLocalContextBundle(context: LocalProjectContextV1, assets: readonly AssetRecord[]): void;
/** Caller holds the asset-store lock; these are local metadata, never wire assets. */
export declare function readLocalProjectContexts(baseDir: string): LocalProjectContextV1[];
export declare function mergeLocalProjectContexts(baseDir: string, incoming: readonly LocalProjectContextV1[]): string;
export declare function writeLocalProjectContexts(baseDir: string, body: string): void;