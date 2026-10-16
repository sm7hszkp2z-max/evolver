import { LocalJsonlProvider } from './localJsonl.js';
import { ForeignJsonlSource } from './foreignJsonlSource.js';
import { UnionReadStore } from './unionReadStore.js';
/** Product entrypoints may support non-prompt custom stores, but must reject a
 * Proxy before feature detection, sidecar co-location or any provider property. */
export declare function assertPromptProviderNotProxy(value: unknown): void;
/** Admission for prompt-time product reads. The V1 shape alone cannot prove
 * that an arbitrary same-process callback stops after timeout. These concrete
 * readers own their local I/O and terminal cleanup; a Union is admitted only
 * when every current child has the same property. This does not sandbox code
 * that is already allowed to mutate our process or class prototypes. */
export type BuiltInPromptProvider = LocalJsonlProvider | ForeignJsonlSource | UnionReadStore;
export declare function isBuiltInPromptProvider(value: unknown): value is BuiltInPromptProvider;