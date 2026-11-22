---
name: dependency-scanner
description: Offline Node dependency supply-chain scanner — detects unpinned/loose version specs, missing lockfiles, install-time scripts (preinstall/install/postinstall), duplicate installed versions, missing license metadata and lockfile drift. Use when auditing a Node/JS project's dependency hygiene before release, when reviewing package.json/lockfile changes, or when asked "are our dependencies pinned / reproducible / safe to install".
---

# dependency-scanner

Scans a Node project for dependency supply-chain risk using only local files.
No network access, no external dependencies, deterministic output.

## When to use

- Before shipping a Node project: check that installs are reproducible and pinned.
- After editing `package.json` or a lockfile: confirm nothing drifted.
- Auditing third-party dependency trees for install-time code execution.

## Usage

```bash
# human-readable report for the current directory
node skills/dependency-scanner/index.js

# scan a specific project root, JSON output
node skills/dependency-scanner/index.js /path/to/project --json

# CI mode: exit 1 when at least one HIGH finding exists
node skills/dependency-scanner/index.js /path/to/project --strict
```

Programmatic use:

```js
const ds = require('./skills/dependency-scanner');
const result = ds.scanProject(process.cwd(), { includeDev: true });
console.log(ds.renderReport(result));
```

## API

| Export | Description |
| --- | --- |
| `scanProject(rootDir, options)` | Full scan. Returns structured result: `root`, `lockfile`, `nodeModules`, `summary` (total + bySeverity + byCategory), `findings[]`. |
| `analyzePackageJson(pkg)` | Manifest-only analysis of a parsed package.json. Returns findings[]. |
| `detectInstallScripts(nodeModulesDir)` | Lists installed packages that define `preinstall`/`install`/`postinstall`. |
| `renderReport(result)` | Formats a scan result as a text report (severity-sorted). |
| `readLock(lockPath)` | Parses package-lock.json / yarn.lock / pnpm-lock.yaml into `{parsed, versions}`. |
| `classifySpec(spec)` | Classifies a version specifier (exact / caret / floating / non_registry / ...). |
| `satisfiesSimple(version, spec)` | Minimal semver check for exact, `^` and `~` ranges. |
| `main(argv)` | CLI entry point. Exit 0 unless `--strict` and a HIGH finding exists. |

## Checks and severities

| Check | Finding id | Severity |
| --- | --- | --- |
| Runtime dep with `*`, `latest`, empty or `x` spec | `unpinned_dependency` | high |
| Dev dep with floating spec | `unpinned_dependency` | low |
| Dep pointing at `git:`/`http:`/`file:`/`link:`/`workspace:` | `non_registry_dependency` | high (dev: medium) |
| Runtime dep with `^`/`~`/range | `loose_dependency` | medium (dev: low) |
| No `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` | `missing_lockfile` | high |
| Installed package defines `preinstall`/`install`/`postinstall` | `install_script` | high |
| Same package installed in more than one version | `duplicate_version` | medium |
| Installed dependency has no `license` field | `missing_license` | low |
| Lockfile version does not satisfy the declared range | `lock_drift` | medium |
| Declared dependency absent from the lockfile | `lock_missing_entry` | low |

## Notes and limits

- Offline by design: no advisory database is consulted, so this reports
  **hygiene and execution-surface risk**, not known CVEs.
- Version-range checking is intentionally minimal (exact, `^`, `~`); exotic
  ranges are reported as "not judged" rather than as drift.
- Scoped packages (`@scope/name`) and nested `node_modules` copies are handled.
- `node_modules` is skipped entirely when absent — findings then cover the
  manifest and lockfile only.

## Self-test

```bash
node skills/dependency-scanner/scripts/selftest.js
```

The self-test builds a throwaway fixture in a temp directory (fake manifest,
fake lockfile, fake package with a `postinstall` script), asserts the expected
findings, cleans up and exits 0. It never touches the repository's own
`node_modules` and never uses the network.
