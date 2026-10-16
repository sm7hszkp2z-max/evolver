// The CLI needs only a fixed worker entry and the command used to re-exec its
// single-file binary. Descriptor operations remain internal to evolver-core.
export { configurePosixSnapshotWorkerCommand, runPosixSnapshotWorker } from './boundedSnapshotPosix.js';