'use strict';

/**
 * dependency-scanner — offline Node dependency supply-chain risk scanner.
 *
 * Fully offline and deterministic: every finding is derived from local files
 * (package.json, lockfile, node_modules). No network access, no secrets,
 * no external dependencies.
 *
 * Usage:
 *   node skills/dependency-scanner/index.js [path] [--json] [--strict]
 */

const fs = require('fs');
const path = require('path');

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const NON_REGISTRY_PREFIXES = ['git:', 'git+', 'http:', 'https:', 'file:', 'link:', 'workspace:', 'portal:', 'github:', 'bitbucket:', 'gitlab:'];

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpVersion(a, b) {
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Classify a dependency version specifier.
 * kind: empty | floating | non_registry | exact | caret_or_tilde | range | unbounded_range | unknown
 */
function classifySpec(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return { kind: 'empty', severity: 'high' };
  const lower = s.toLowerCase();
  if (lower === '*' || lower === 'latest' || lower === 'x' || lower === 'x.x' || lower === 'x.x.x') {
    return { kind: 'floating', severity: 'high' };
  }
  if (NON_REGISTRY_PREFIXES.some(function (p) { return lower.startsWith(p); }) || lower.startsWith('git@')) {
    return { kind: 'non_registry', severity: 'high' };
  }
  if (lower.indexOf('||') !== -1 || /[<>=~^]+\s*\*/.test(lower)) {
    return { kind: 'range', severity: 'medium' };
  }
  if (/^\d/.test(lower) && !/[<>=~^]/.test(lower)) {
    return { kind: 'exact', severity: 'info' };
  }
  if (lower.charAt(0) === '^' || lower.charAt(0) === '~') {
    return { kind: 'caret_or_tilde', severity: 'medium' };
  }
  if (/^(>=|<=|>|<)/.test(lower)) {
    return { kind: 'unbounded_range', severity: 'medium' };
  }
  return { kind: 'unknown', severity: 'medium' };
}

/**
 * Analyze a package.json object and return manifest-level findings.
 * @param {object} pkg parsed package.json
 * @returns {Array<object>} findings
 */
function analyzePackageJson(pkg) {
  const findings = [];
  if (!isPlainObject(pkg)) {
    findings.push({
      id: 'invalid_package_json',
      category: 'manifest',
      severity: 'high',
      message: 'package.json is missing or is not a valid JSON object'
    });
    return findings;
  }

  const groups = [
    { field: 'dependencies', deps: pkg.dependencies, dev: false },
    { field: 'devDependencies', deps: pkg.devDependencies, dev: true },
    { field: 'optionalDependencies', deps: pkg.optionalDependencies, dev: false },
    { field: 'peerDependencies', deps: pkg.peerDependencies, dev: false }
  ];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!isPlainObject(group.deps)) continue;
    const names = Object.keys(group.deps).sort();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const spec = group.deps[name];
      const cls = classifySpec(spec);
      const isDev = group.dev;
      const label = group.field + '.' + name;

      if (cls.kind === 'non_registry') {
        findings.push({
          id: 'non_registry_dependency',
          category: 'version_pinning',
          severity: isDev ? 'medium' : 'high',
          message: 'Dependency "' + label + '" points at a non-registry source ("' + String(spec) + '") — install pulls code from outside the npm registry',
          package: name,
          spec: String(spec),
          group: group.field,
          kind: cls.kind
        });
        continue;
      }

      if (cls.kind === 'empty' || cls.kind === 'floating') {
        findings.push({
          id: 'unpinned_dependency',
          category: 'version_pinning',
          severity: isDev ? 'low' : 'high',
          message: 'Dependency "' + label + '" has an unpinned version spec ("' + String(spec == null ? '' : spec) + '") — the resolved version can change silently',
          package: name,
          spec: String(spec == null ? '' : spec),
          group: group.field,
          kind: cls.kind
        });
        continue;
      }

      if (cls.kind === 'caret_or_tilde' || cls.kind === 'range' || cls.kind === 'unbounded_range' || cls.kind === 'unknown') {
        findings.push({
          id: 'loose_dependency',
          category: 'version_pinning',
          severity: isDev ? 'low' : 'medium',
          message: 'Dependency "' + label + '" uses a loose version range ("' + String(spec) + '") — upgrades can pull breaking changes',
          package: name,
          spec: String(spec),
          group: group.field,
          kind: cls.kind
        });
      }
    }
  }
  return findings;
}

/** List candidate package directories inside a node_modules folder. */
function listPackageDirs(nodeModulesDir) {
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch (e) {
    return dirs;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.name.charAt(0) === '.') continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = path.join(nodeModulesDir, e.name);
    if (e.name.charAt(0) === '@') {
      let scoped = [];
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch (err) {
        continue;
      }
      for (let j = 0; j < scoped.length; j++) {
        if (!scoped[j].isDirectory() && !scoped[j].isSymbolicLink()) continue;
        dirs.push(path.join(full, scoped[j].name));
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

function licenseOf(meta) {
  if (!meta) return null;
  if (typeof meta.license === 'string' && meta.license.trim()) return meta.license.trim();
  if (meta.license && typeof meta.license === 'object' && typeof meta.license.type === 'string') return meta.license.type;
  if (Array.isArray(meta.licenses)) {
    const types = meta.licenses
      .map(function (l) { return l && typeof l.type === 'string' ? l.type : (typeof l === 'string' ? l : null); })
      .filter(Boolean);
    if (types.length) return types.join(', ');
  }
  return null;
}

/** Collect every installed package (including nested copies) under node_modules. */
function collectInstalledPackages(nodeModulesDir) {
  const out = [];
  const visited = Object.create(null);
  const walk = function (nmDir, depth) {
    if (depth > 6) return;
    const dirs = listPackageDirs(nmDir);
    for (let i = 0; i < dirs.length; i++) {
      const pkgDir = dirs[i];
      let key = pkgDir;
      try { key = fs.realpathSync(pkgDir); } catch (e) { /* keep path */ }
      if (visited[key]) continue;
      visited[key] = true;
      const meta = readJsonSafe(path.join(pkgDir, 'package.json'));
      if (meta) {
        out.push({
          name: typeof meta.name === 'string' && meta.name ? meta.name : path.basename(pkgDir),
          version: typeof meta.version === 'string' ? meta.version : null,
          license: licenseOf(meta),
          scripts: isPlainObject(meta.scripts) ? meta.scripts : {},
          dir: pkgDir
        });
      }
      const nested = path.join(pkgDir, 'node_modules');
      if (fs.existsSync(nested)) walk(nested, depth + 1);
    }
  };
  walk(nodeModulesDir, 0);
  return out;
}

/**
 * Detect packages that execute code at install time.
 * @param {string} nodeModulesDir
 * @returns {Array<object>} list of {name, version, hook, script, dir}
 */
function detectInstallScripts(nodeModulesDir) {
  const out = [];
  if (!nodeModulesDir || !fs.existsSync(nodeModulesDir)) return out;
  const packages = collectInstalledPackages(nodeModulesDir);
  for (let i = 0; i < packages.length; i++) {
    const p = packages[i];
    for (let j = 0; j < INSTALL_SCRIPTS.length; j++) {
      const hook = INSTALL_SCRIPTS[j];
      const script = p.scripts[hook];
      if (typeof script === 'string' && script.trim()) {
        out.push({
          name: p.name,
          version: p.version,
          hook: hook,
          script: script.trim(),
          dir: p.dir
        });
      }
    }
  }
  return out;
}

/** Minimal semver-range check — exact, ^, ~ only. Unknown ranges are accepted. */
function satisfiesSimple(version, spec) {
  const v = parseVersion(version);
  const s = String(spec == null ? '' : spec).trim();
  if (!v) return true;
  if (!s || s === '*' || s.toLowerCase() === 'latest') return true;
  if (NON_REGISTRY_PREFIXES.some(function (p) { return s.toLowerCase().indexOf(p) === 0; })) return true;
  if (s.indexOf('||') !== -1) return true;
  if (/^(>=|<=|>|<)/.test(s)) return true;
  const sv = parseVersion(s.replace(/^[~^]/, ''));
  if (!sv) return true;
  const cmp = cmpVersion(v, sv);
  if (s.charAt(0) === '^') {
    if (sv.major > 0) return v.major === sv.major && cmp >= 0;
    if (sv.minor > 0) return v.major === 0 && v.minor === sv.minor && cmp >= 0;
    return v.major === 0 && v.minor === 0 && v.patch === sv.patch;
  }
  if (s.charAt(0) === '~') {
    return v.major === sv.major && v.minor === sv.minor && cmp >= 0;
  }
  return cmp === 0;
}

/** Read a lockfile and return {parsed, versions:{name:version}}. */
function readLock(lockPath) {
  const base = path.basename(lockPath);
  const versions = {};
  let parsed = false;

  if (base === 'package-lock.json') {
    const data = readJsonSafe(lockPath);
    if (!data) return { parsed: false, versions: versions };
    parsed = true;
    if (isPlainObject(data.packages)) {
      const keys = Object.keys(data.packages).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const marker = 'node_modules/';
        const idx = key.lastIndexOf(marker);
        if (idx === -1) continue;
        const name = key.slice(idx + marker.length);
        const entry = data.packages[key];
        if (isPlainObject(entry) && typeof entry.version === 'string') versions[name] = entry.version;
      }
    }
    if (isPlainObject(data.dependencies)) {
      const keys = Object.keys(data.dependencies).sort();
      for (let i = 0; i < keys.length; i++) {
        const entry = data.dependencies[keys[i]];
        if (isPlainObject(entry) && typeof entry.version === 'string' && !versions[keys[i]]) {
          versions[keys[i]] = entry.version;
        }
      }
    }
    return { parsed: parsed, versions: versions };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    return { parsed: false, versions: versions };
  }

  if (base === 'yarn.lock') {
    parsed = true;
    const blocks = raw.split(/\n\s*\n/);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const lines = block.split('\n');
      let names = [];
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line || line.charAt(0) === '#') continue;
        if (line.charAt(0) === '"' || line.indexOf('@') !== -1) {
          if (line.indexOf('version') === -1 && line.charAt(0) !== ' ') {
            const specs = line.replace(/:$/, '').split(',');
            for (let k = 0; k < specs.length; k++) {
              const cleaned = specs[k].trim().replace(/^"|"$/g, '');
              const at = cleaned.lastIndexOf('@');
              if (at > 0) names.push(cleaned.slice(0, at));
            }
          }
        }
        const vm = /^version\s+"([^"]+)"/.exec(line);
        if (vm && names.length) {
          for (let k = 0; k < names.length; k++) versions[names[k]] = vm[1];
        }
      }
    }
    return { parsed: parsed, versions: versions };
  }

  if (base === 'pnpm-lock.yaml') {
    parsed = true;
    const re = /^\s{2}\/([^:\s]+(?:\/[^:\s@]+)?)@([^:\s]+):\s*$/gm;
    let m;
    while ((m = re.exec(raw)) !== null) {
      versions[m[1]] = m[2];
    }
    return { parsed: parsed, versions: versions };
  }

  return { parsed: false, versions: versions };
}

function directDependencies(pkg, includeDev) {
  const out = [];
  if (!isPlainObject(pkg)) return out;
  const groups = [
    { field: 'dependencies', deps: pkg.dependencies, dev: false },
    { field: 'devDependencies', deps: pkg.devDependencies, dev: true }
  ];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.dev && !includeDev) continue;
    if (!isPlainObject(g.deps)) continue;
    const names = Object.keys(g.deps).sort();
    for (let j = 0; j < names.length; j++) {
      out.push({ name: names[j], spec: String(g.deps[names[j]]), group: g.field, dev: g.dev });
    }
  }
  return out;
}

/**
 * Scan a Node project for dependency supply-chain risks.
 * @param {string} rootDir project root
 * @param {object} [options] { includeDev: boolean }
 * @returns {object} structured result
 */
function scanProject(rootDir, options) {
  const opts = isPlainObject(options) ? options : {};
  const includeDev = opts.includeDev !== false;
  const root = path.resolve(rootDir || process.cwd());
  const findings = [];

  const pkgPath = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJsonSafe(pkgPath) : null;
  if (!pkg) {
    findings.push({
      id: 'missing_package_json',
      category: 'manifest',
      severity: 'high',
      message: 'No readable package.json found at ' + pkgPath
    });
  }

  const manifestFindings = analyzePackageJson(pkg);
  for (let i = 0; i < manifestFindings.length; i++) findings.push(manifestFindings[i]);

  const lockName = LOCKFILES.filter(function (n) { return fs.existsSync(path.join(root, n)); })[0] || null;
  if (!lockName) {
    findings.push({
      id: 'missing_lockfile',
      category: 'lockfile',
      severity: 'high',
      message: 'No lockfile found (' + LOCKFILES.join(' / ') + ') — installs are not reproducible'
    });
  }

  const nmDir = path.join(root, 'node_modules');
  const nmPresent = fs.existsSync(nmDir) && fs.statSync(nmDir).isDirectory();
  const installed = nmPresent ? collectInstalledPackages(nmDir) : [];

  const installScripts = detectInstallScripts(nmDir);
  for (let i = 0; i < installScripts.length; i++) {
    const s = installScripts[i];
    findings.push({
      id: 'install_script',
      category: 'install_script',
      severity: 'high',
      message: 'Package "' + s.name + '@' + (s.version || '?') + '" defines a "' + s.hook + '" install script — code runs at install time',
      package: s.name,
      version: s.version,
      hook: s.hook,
      script: s.script
    });
  }

  const versionsByName = {};
  for (let i = 0; i < installed.length; i++) {
    const p = installed[i];
    if (!p.version) continue;
    if (!versionsByName[p.name]) versionsByName[p.name] = [];
    if (versionsByName[p.name].indexOf(p.version) === -1) versionsByName[p.name].push(p.version);
  }
  const dupNames = Object.keys(versionsByName).sort();
  for (let i = 0; i < dupNames.length; i++) {
    const name = dupNames[i];
    if (versionsByName[name].length < 2) continue;
    findings.push({
      id: 'duplicate_version',
      category: 'duplication',
      severity: 'medium',
      message: 'Package "' + name + '" is installed in multiple versions: ' + versionsByName[name].sort().join(', '),
      package: name,
      versions: versionsByName[name].slice().sort()
    });
  }

  const direct = directDependencies(pkg, includeDev);
  const installedByName = {};
  for (let i = 0; i < installed.length; i++) {
    if (!installedByName[installed[i].name]) installedByName[installed[i].name] = installed[i];
  }
  for (let i = 0; i < direct.length; i++) {
    const d = direct[i];
    const inst = installedByName[d.name];
    if (inst && !inst.license) {
      findings.push({
        id: 'missing_license',
        category: 'metadata',
        severity: 'low',
        message: 'Dependency "' + d.name + '" has no license field in its package.json',
        package: d.name,
        version: inst.version
      });
    }
  }

  let lock = { parsed: false, versions: {} };
  if (lockName) {
    lock = readLock(path.join(root, lockName));
    if (lock.parsed) {
      for (let i = 0; i < direct.length; i++) {
        const d = direct[i];
        const locked = lock.versions[d.name];
        if (!locked) {
          findings.push({
            id: 'lock_missing_entry',
            category: 'lockfile',
            severity: 'low',
            message: 'Dependency "' + d.name + '" is declared in package.json but absent from ' + lockName,
            package: d.name,
            spec: d.spec
          });
          continue;
        }
        if (!satisfiesSimple(locked, d.spec)) {
          findings.push({
            id: 'lock_drift',
            category: 'lockfile',
            severity: 'medium',
            message: 'Lockfile drift: ' + lockName + ' pins "' + d.name + '" at ' + locked + ' which does not satisfy the declared range "' + d.spec + '"',
            package: d.name,
            spec: d.spec,
            locked: locked
          });
        }
      }
    }
  }

  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byCategory = {};
  for (let i = 0; i < findings.length; i++) {
    const sev = findings[i].severity;
    if (bySeverity[sev] === undefined) bySeverity[sev] = 0;
    bySeverity[sev] += 1;
    const cat = findings[i].category;
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  return {
    root: root,
    manifestFound: !!pkg,
    lockfile: lockName ? { present: true, name: lockName, parsed: lock.parsed } : { present: false, name: null, parsed: false },
    nodeModules: {
      present: nmPresent,
      packageCount: installed.length,
      installScriptCount: installScripts.length
    },
    directDependencyCount: direct.length,
    summary: {
      total: findings.length,
      bySeverity: bySeverity,
      byCategory: byCategory
    },
    findings: findings
  };
}

/** Render a human-readable text report for a scan result. */
function renderReport(result) {
  const lines = [];
  const r = isPlainObject(result) ? result : { findings: [], summary: { total: 0, bySeverity: {} } };
  const sev = (r.summary && r.summary.bySeverity) || {};
  lines.push('dependency-scanner report');
  lines.push('root: ' + (r.root || '?'));
  lines.push('lockfile: ' + (r.lockfile && r.lockfile.present ? r.lockfile.name : 'none'));
  lines.push('installed packages: ' + (r.nodeModules ? r.nodeModules.packageCount : 0));
  lines.push('findings: ' + (r.summary ? r.summary.total : 0) +
    ' (high=' + (sev.high || 0) + ', medium=' + (sev.medium || 0) + ', low=' + (sev.low || 0) + ')');
  lines.push('');
  const findings = Array.isArray(r.findings) ? r.findings : [];
  if (!findings.length) {
    lines.push('No dependency supply-chain findings.');
    return lines.join('\n');
  }
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = findings.slice().sort(function (a, b) {
    const sa = order[a.severity] === undefined ? 3 : order[a.severity];
    const sb = order[b.severity] === undefined ? 3 : order[b.severity];
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id));
  });
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    lines.push('[' + String(f.severity || 'low').toUpperCase() + '] ' + String(f.id) + ': ' + String(f.message));
    if (f.script) lines.push('        script: ' + f.script);
  }
  return lines.join('\n');
}

/**
 * CLI entry point.
 * @param {string[]} [argv] argument list (defaults to process.argv.slice(2))
 * @returns {{result: object, exitCode: number}}
 */
function main(argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const strict = args.indexOf('--strict') !== -1;
  const asJson = args.indexOf('--json') !== -1;
  const positional = args.filter(function (a) { return String(a).charAt(0) !== '-'; });
  const target = positional.length ? positional[0] : process.cwd();
  const result = scanProject(target, {});
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(result) + '\n');
  }
  const exitCode = strict && result.summary.bySeverity.high > 0 ? 1 : 0;
  if (require.main === module) process.exit(exitCode);
  return { result: result, exitCode: exitCode };
}

module.exports = {
  scanProject: scanProject,
  analyzePackageJson: analyzePackageJson,
  detectInstallScripts: detectInstallScripts,
  renderReport: renderReport,
  readLock: readLock,
  classifySpec: classifySpec,
  satisfiesSimple: satisfiesSimple,
  main: main
};

if (require.main === module) {
  main(process.argv.slice(2));
}
