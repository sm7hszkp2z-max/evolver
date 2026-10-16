import { hub as hubNs } from '@evomap/evolver-core';
import type { HelloResult, HeartbeatOptions, HeartbeatResult } from '../lifecycle/manager.js';
import { type PrivateAccountAssetHub, type PrivateCompatibilityFetch } from './accountAssetCompatibility.js';
export type PrivateHubWithLifecycle = hubNs.HubCapability & {
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<HelloResult>;
    heartbeat(opts?: HeartbeatOptions): Promise<HeartbeatResult>;
};
export type PrivateProxyHub = PrivateHubWithLifecycle & PrivateAccountAssetHub;
/**
 * Optional private-adapter contract. The ID is a nonsecret sha256 fingerprint
 * of the active endpoint and authenticated principal, never a credential.
 * The adapter owns its effective route and principal, so the bound method must
 * compare that same identity atomically with the actual network send. It must
 * refuse a changed/unknown destination without claiming a recorded receipt.
 * A proxy-side status check alone cannot prevent a mid-request switch.
 */
export interface PrivateBoundReuseFeedback {
    feedbackDestinationId(): string | undefined;
    recordReuseResultBound(report: hubNs.ReuseResultReport, expectedDestinationId: string): Promise<hubNs.ReuseResultReceipt>;
}
interface PrivateSsoExchange {
    identity: () => {
        subject: string;
        claims?: Record<string, unknown>;
    };
    exchange: (identity: {
        subject: string;
        claims?: Record<string, unknown>;
    }) => Promise<{
        token: string;
        expiresInMs?: number;
    }>;
    now?: () => number;
}
export interface ConnectPrivateHubOptions {
    hubUrl: string;
    sso: PrivateSsoExchange;
    senderId: () => string | undefined;
    env?: Record<string, string | undefined>;
    now?: () => number;
    /** One-shot invitation token (evoinv_…) — preferred over the SSO bearer for token_required hubs. */
    invitationToken?: string;
    /** Ready credential from the standard Private Hub onboarding store. */
    nodeSecret?: string;
    fetchFn?: PrivateCompatibilityFetch;
}
type DynamicImporter = (specifier: string) => Promise<unknown>;
export interface PrivateProxyHubRuntime {
    hub: PrivateProxyHub;
    auth: hubNs.AuthProvider;
    boundReuseFeedback?: PrivateBoundReuseFeedback;
    /** Enrollment-aware lifecycle entrypoint. Ready node_secret credentials must not re-run hello. */
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<HelloResult>;
}
export interface ConnectPrivateProxyHubOptions {
    hubUrl: string;
    senderId: () => string | undefined;
    env: Record<string, string | undefined>;
    now?: () => number;
    importer?: DynamicImporter;
    fetchFn?: PrivateCompatibilityFetch;
    /** Durable credential minted by a previous invitation/SSO enrollment. */
    storedNodeSecret?: string;
    /** Persist a newly minted credential before the process can restart. */
    onNodeSecretAdopted?: (nodeSecret: string) => void;
    /** Fingerprint of the last successfully redeemed one-shot invitation. */
    storedInvitationFingerprint?: string;
    /** Persist the non-secret fingerprint after an invitation is redeemed. */
    onInvitationRedeemed?: (fingerprint: string) => void;
}
export declare function resolvePrivateEnterpriseToken(env: Record<string, string | undefined>): string | undefined;
/** One-shot invitation token (evoinv_…), matching the hub's official onboarding script (A2A_INVITATION_TOKEN).
 *  Preferred over the enterprise token for the default token_required enrollment mode. */
export declare function resolvePrivateInvitationToken(env: Record<string, string | undefined>): string | undefined;
export declare function resolvePrivateNodeSecret(env: Record<string, string | undefined>): string | undefined;
export declare function resolvePrivateEnterpriseSubject(env: Record<string, string | undefined>): string;
export declare function connectPrivateProxyHub(opts: ConnectPrivateProxyHubOptions): Promise<PrivateProxyHubRuntime>;
export {};