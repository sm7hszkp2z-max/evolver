export declare const LEGACY_ABSENT_SERVICE_PREFLIGHT_DETAIL = "bootstrap preflight existing service check failed closed with manager state unavailable";
/** Exit status of `launchctl print gui/<uid>/<proxy label>`, or null when it did not exit normally. */
export type LaunchdServiceProbe = (uid: number) => number | null;
export interface LegacyBootstrapBlock {
    platform: NodeJS.Platform;
    exitCode: number | null;
    cliDetail: string | undefined;
    stdoutTruncated: boolean;
}
export declare function isLegacyAbsentServicePreflightBlock(block: LegacyBootstrapBlock, probe?: LaunchdServiceProbe): boolean;