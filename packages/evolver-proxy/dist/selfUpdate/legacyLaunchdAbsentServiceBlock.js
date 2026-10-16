// Releases through 2.0.42 read `launchctl print` exit 113 ("Could not find specified service") as
// an unavailable manager, so `lifecycle bootstrap` rejects its own preflight on every macOS host
// that never had the service and reports `blocked`. Those binaries stay installed on user machines
// and keep answering this way, so the foreground proxy has to recognise that one answer itself.
//
// The recognition is deliberately brittle-by-design: it matches the exact text those releases emit
// and still requires this process to observe, through launchd, that the service is not loaded.
// Any other wording, exit status, or probe result stays fail-closed.
import { spawnSync } from 'node:child_process';
const LAUNCHCTL_PATH = '/bin/launchctl';
const PROXY_LAUNCHD_LABEL = 'com.evomap.evolver-proxy';
const LAUNCHCTL_SERVICE_NOT_FOUND_STATUS = 113;
const LAUNCHD_SERVICE_PROBE_TIMEOUT_MS = 5_000;
const LEGACY_BOOTSTRAP_FAILURE_EXIT_CODE = 1;
export const LEGACY_ABSENT_SERVICE_PREFLIGHT_DETAIL = 'bootstrap preflight existing service check failed closed with manager state unavailable';
function probeLaunchdProxyService(uid) {
    const result = spawnSync(LAUNCHCTL_PATH, ['print', `gui/${uid}/${PROXY_LAUNCHD_LABEL}`], { stdio: 'ignore', timeout: LAUNCHD_SERVICE_PROBE_TIMEOUT_MS, windowsHide: true });
    return result.error ? null : result.status;
}
function matchesLegacyAbsentServicePreflight(block) {
    return block.platform === 'darwin'
        && block.exitCode === LEGACY_BOOTSTRAP_FAILURE_EXIT_CODE
        && !block.stdoutTruncated
        && block.cliDetail === LEGACY_ABSENT_SERVICE_PREFLIGHT_DETAIL;
}
function launchdProxyServiceProvenNotLoaded(probe) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined)
        return false;
    try {
        return probe(uid) === LAUNCHCTL_SERVICE_NOT_FOUND_STATUS;
    }
    catch {
        return false;
    }
}
export function isLegacyAbsentServicePreflightBlock(block, probe = probeLaunchdProxyService) {
    return matchesLegacyAbsentServicePreflight(block) && launchdProxyServiceProvenNotLoaded(probe);
}