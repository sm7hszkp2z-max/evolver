---
name: protocol-drift-monitor
description: Detect, score, record, expose, and cautiously reconcile drift in GEP protocol assets. Use when Gene, Capsule, EvolutionEvent, Mutation, or PersonalityState records may violate mandatory fields, types, or schema versions.
---

# Protocol drift monitor

Use `ProtocolDriftMonitor.record(payload)` on records from the GEP asset stores, then read the sliding-window ratio with `getDriftScore()`.

- `SchemaRegistrySnapshot` computes MD5 snapshots and watches the three stores.
- `DriftScoreRecorder` writes JSONL rows and retains 14 days by default.
- `collectDriftMetrics(monitor)` returns Prometheus text and an alert gauge (> 0.08).
- `reconcileProtocolDrift()` is dry-run unless passed `{ dryRun: false }`. It only fills missing `schema_version` values through `src/gep/assetStore.js`; it never replaces existing versions or deletes records.

Run `node scripts/selftest.js` from this skill directory before use.
