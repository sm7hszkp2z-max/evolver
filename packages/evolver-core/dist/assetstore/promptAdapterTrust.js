import { types } from 'node:util';
import { LocalJsonlProvider } from './localJsonl.js';
import { ForeignJsonlSource } from './foreignJsonlSource.js';
import { UnionReadStore } from './unionReadStore.js';
const METHOD_NAMES = [
    'beginPromptGeneSnapshotV1', 'beginGeneScanV1', 'beginPromptRelatedCapsulesV1',
    'beginPromptAssetGetV1', 'beginPromptLogicalGeneLookupV1',
    'queryGeneSnapshot', 'queryRelatedCapsules', 'get', 'findByLogicalId',
];
const originalMethods = (prototype) => new Map(METHOD_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)?.value]));
const localMethods = originalMethods(LocalJsonlProvider.prototype);
const foreignMethods = originalMethods(ForeignJsonlSource.prototype);
const localBrandCheck = LocalJsonlProvider.isBuiltInPromptReader;
const foreignBrandCheck = ForeignJsonlSource.isBuiltInPromptReader;
const unionSourceTree = UnionReadStore.prototype.promptSourceTree;
const unionCapabilitiesUnmodified = UnionReadStore.prototype.promptCapabilitiesUnmodified;
const isProxy = types.isProxy;
/** Product entrypoints may support non-prompt custom stores, but must reject a
 * Proxy before feature detection, sidecar co-location or any provider property. */
export function assertPromptProviderNotProxy(value) {
    if (isProxy(value))
        throw new Error('unsupported_unsupervised_prompt_provider_v1');
}
const methodsMatch = (value, expected) => {
    const current = value;
    const prototype = Object.getPrototypeOf(value);
    return [...expected].every(([name, method]) => typeof method === 'function'
        && Object.getOwnPropertyDescriptor(value, name) === undefined
        && Object.getOwnPropertyDescriptor(prototype, name)?.value === method
        && current[name] === method);
};
export function isBuiltInPromptProvider(value) {
    // Prompt V1 reads retain one owner per provider through terminal cleanup.
    // A shared child under different nested parents would acquire that owner
    // twice; only immediate duplicate positions are deduplicated by Union.
    const seen = new Set();
    const check = (candidate) => {
        // Reflection itself can dispatch Proxy traps before a WeakSet/WeakMap brand
        // rejects the wrapper. The runtime check does not inspect JS properties.
        if (!candidate || typeof candidate !== 'object' || isProxy(candidate) || seen.has(candidate))
            return false;
        seen.add(candidate);
        try {
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype === LocalJsonlProvider.prototype) {
                const store = candidate;
                const baseDir = Object.getOwnPropertyDescriptor(store, 'baseDir');
                return localBrandCheck(store)
                    && typeof baseDir?.value === 'string' && !baseDir.writable && !baseDir.configurable
                    && methodsMatch(store, localMethods);
            }
            if (prototype === ForeignJsonlSource.prototype) {
                const store = candidate;
                const baseDir = Object.getOwnPropertyDescriptor(store, 'baseDir');
                return foreignBrandCheck(store)
                    && typeof baseDir?.value === 'string' && !baseDir.writable && !baseDir.configurable
                    && methodsMatch(store, foreignMethods);
            }
            if (prototype === UnionReadStore.prototype) {
                const store = candidate;
                if (Object.getOwnPropertyDescriptor(store, 'promptSourceTree') !== undefined
                    || Object.getOwnPropertyDescriptor(store, 'promptCapabilitiesUnmodified') !== undefined
                    || Object.getOwnPropertyDescriptor(prototype, 'promptSourceTree')?.value !== unionSourceTree
                    || Object.getOwnPropertyDescriptor(prototype, 'promptCapabilitiesUnmodified')?.value !== unionCapabilitiesUnmodified
                    || !unionCapabilitiesUnmodified.call(store))
                    return false;
                const sources = unionSourceTree.call(store);
                return sources.length > 0 && sources.length <= 8 && sources.every(check);
            }
            return false;
        }
        catch {
            return false;
        }
    };
    return check(value);
}