import { createHash } from 'node:crypto';
import { CredentialStore } from './credentialStore.js';
import { resolveMachineId, machineFingerprint } from './machineId.js';
export const TOKEN_TTL_MS = 24 * 60 * 60_000; // fallback only; the hub supplies expiresInMs (~1h)
export const ROTATE_BEFORE_MS = 5 * 60_000; // refresh 5min before expiry (hub access tokens are short-lived ~1h)
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
/** A local refusal before the business request enters HubFetch.fetchFn. No credential data is exposed. */
export class OAuthCredentialBindingError extends Error {
    constructor() {
        super('oauth_credential_binding_changed');
        this.name = 'OAuthCredentialBindingError';
    }
}
/** Authentication failed before the bound Hub business request began. */
export class OAuthAuthenticationPreflightError extends Error {
    constructor(cause) {
        super(cause instanceof Error ? cause.message : 'oauth_authentication_preflight_failed', { cause });
        this.name = 'OAuthAuthenticationPreflightError';
    }
}
function tokenBinding(cred) {
    if (!cred || cred.kind !== 'oauth_device_token' || !('token' in cred)
        || typeof cred.token !== 'string' || !cred.token || /\s/u.test(cred.token)
        || [...cred.token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        return undefined;
    return `sha256:${createHash('sha256').update('evomap-public-oauth-access-token-v1\0').update(cred.token).digest('hex')}`;
}
/** Inspect the trusted credential file without exposing its access token or treating the machine id as an account. */
export function readPublicOAuthCredentialBinding(credPath) {
    return tokenBinding(new CredentialStore(credPath).load());
}
function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('device_flow_timeout');
}
async function awaitWithAbort(promise, signal) {
    const pending = Promise.resolve(promise);
    if (signal.aborted) {
        void pending.catch(() => { });
        throw abortReason(signal);
    }
    return await new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            cleanup();
            reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function linkedTimeoutSignal(parent, timeoutMs, timeoutReason) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parent?.reason);
    if (parent?.aborted)
        abortFromParent();
    else
        parent?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
    timeout.unref?.();
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timeout);
            parent?.removeEventListener('abort', abortFromParent);
        },
    };
}
/**
 * device token 认证(M6-5, 默认路径 evolver login). device code flow(学 gh auth login):
 * 显示 user code → 用户在浏览器授权 → 轮询拿 token. 绑机器指纹(CEO: OS machineId+软兜底).
 * hub access token 短寿(~1h)+ refresh_token 续期; 过期前 ROTATE_BEFORE_MS 自动 rotate.
 */
export class PublicOAuthProvider {
    opts;
    kind = 'oauth_device_token';
    store;
    now;
    sleep;
    maxWaitMs;
    refreshTimeoutMs;
    constructor(opts) {
        this.opts = opts;
        this.store = new CredentialStore(opts.credPath);
        this.now = opts.now ?? (() => Date.now());
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
        this.refreshTimeoutMs = Math.max(1, opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
    }
    fingerprint() { return machineFingerprint(resolveMachineId(this.opts.machine).id); }
    /**
     * Full device-flow login: reuse a still-valid cached token, else request a
     * device code (shown once via onUserCode) and poll until the user approves in
     * the browser, returning + persisting the credential. Drives the poll loop
     * itself (respecting the server interval); a terminal error from the transport
     * (access_denied / expired_token) propagates.
     */
    async login(parentSignal) {
        const cached = this.store.load();
        if (cached && 'token' in cached && (cached.expiresAt ?? 0) - ROTATE_BEFORE_MS > this.now())
            return cached;
        const fp = this.fingerprint();
        const deadline = this.now() + this.maxWaitMs;
        const deadlineSignal = linkedTimeoutSignal(parentSignal, Math.max(0, this.maxWaitMs), new Error('device_flow_timeout'));
        try {
            const dc = await awaitWithAbort(this.opts.transport.requestDeviceCode(fp, deadlineSignal.signal), deadlineSignal.signal);
            (this.opts.onUserCode ?? ((d) => { process.stdout.write(`授权码 ${d.userCode} → ${d.verificationUri}\n`); }))(dc);
            let intervalMs = dc.intervalMs;
            for (;;) {
                if (this.now() >= deadline)
                    throw new Error('device_flow_timeout');
                const res = await awaitWithAbort(this.opts.transport.pollToken(dc.deviceCode, deadlineSignal.signal), deadlineSignal.signal);
                if (!('pending' in res))
                    return this.persist(res, fp);
                if (this.now() >= deadline)
                    throw new Error('device_flow_timeout');
                await awaitWithAbort(this.sleep(intervalMs), deadlineSignal.signal);
                intervalMs += 1000; // gentle back-off; the hub's slow_down also surfaces as pending
            }
        }
        finally {
            deadlineSignal.dispose();
        }
    }
    async authenticate(req) {
        if (this.opts.expectedTokenBinding !== undefined
            && (typeof this.opts.expectedTokenBinding !== 'string'
                || !/^sha256:[a-f0-9]{64}$/.test(this.opts.expectedTokenBinding))) {
            throw new OAuthCredentialBindingError();
        }
        let cred;
        try {
            cred = this.store.load();
        }
        catch (error) {
            if (this.opts.expectedTokenBinding)
                throw new OAuthCredentialBindingError();
            throw error;
        }
        if (!cred || !('token' in cred)) {
            if (this.opts.expectedTokenBinding)
                throw new OAuthCredentialBindingError();
            throw new Error('oauth 未登录, 先 login()');
        }
        if (this.opts.expectedTokenBinding && tokenBinding(cred) !== this.opts.expectedTokenBinding) {
            throw new OAuthCredentialBindingError();
        }
        if ((cred.expiresAt ?? 0) - ROTATE_BEFORE_MS <= this.now()) {
            try {
                cred = await this.rotate(req?.signal);
            }
            catch (error) {
                if (this.opts.expectedTokenBinding) {
                    // A failed refresh does not prove credential replacement. Re-read the
                    // trusted store so a concurrent replacement still receives the strict
                    // binding refusal, while transient pre-request failures remain retryable.
                    let current;
                    try {
                        current = this.store.load();
                    }
                    catch {
                        throw new OAuthCredentialBindingError();
                    }
                    if (tokenBinding(current) !== this.opts.expectedTokenBinding)
                        throw new OAuthCredentialBindingError();
                    throw new OAuthAuthenticationPreflightError(error);
                }
                throw error;
            }
        }
        if (this.opts.expectedTokenBinding && tokenBinding(cred) !== this.opts.expectedTokenBinding) {
            throw new OAuthCredentialBindingError();
        }
        return { headers: { authorization: `Bearer ${cred.token}`, 'x-evomap-device': cred.device ?? '' } };
    }
    async rotate(parentSignal) {
        const cred = this.store.load();
        const fp = this.fingerprint();
        // Prefer a seamless refresh_token rotation; fall back to a fresh device-flow
        // login only when there is no usable refresh token (or no refresh transport).
        if (cred && 'refreshToken' in cred && cred.refreshToken && this.opts.transport.refresh) {
            const refreshSignal = linkedTimeoutSignal(parentSignal, this.refreshTimeoutMs, new Error('oauth_refresh_timeout'));
            try {
                const res = await awaitWithAbort(this.opts.transport.refresh(cred.refreshToken, refreshSignal.signal), refreshSignal.signal);
                return this.persist(res, fp, cred.refreshToken);
            }
            finally {
                refreshSignal.dispose();
            }
        }
        return this.login(parentSignal);
    }
    async revoke() { }
    // fallbackRefresh: carry the prior refresh token forward when the hub's refresh
    // response does not rotate it (so a later rotate() still has one to use).
    persist(res, fingerprint, fallbackRefresh) {
        const refreshToken = res.refreshToken ?? fallbackRefresh;
        const cred = {
            id: `oauth-${fingerprint.slice(0, 12)}`, kind: 'oauth_device_token', device: fingerprint,
            token: res.token, expiresAt: this.now() + (res.expiresInMs ?? TOKEN_TTL_MS),
            ...(refreshToken ? { refreshToken } : {}),
        };
        this.store.save(cred);
        return cred;
    }
}