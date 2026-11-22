'use strict';

/**
 * Offline self-test for the dependency-scanner skill.
 * Builds a throwaway fixture in a temp dir, asserts the expected findings,
 * cleans up, prints one success line and exits 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const scanner = require('../index.js');

function assert(cond, message) {
  if (!cond) {
    throw new Error('SELFTEST FAILED: ' + message);
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function hasFinding(findings, id, severity, pkgName) {
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (f.id !== id) continue;
    if (severity && f.severity !== severity) continue;
    if (pkgName && f.package !== pkgName) continue;
    return f;
  }
  return null;
}

function buildFixture(dir) {
  writeJson(path.join(dir, 'package.json'), {
    name: 'fixture-app',
    version: '1.0.0',
    dependencies: {
      'left-pad': '*',
      express: '^4.18.0',
      'nested-git': 'git+https://example.invalid/repo.git'
    },
    devDependencies: {
      jest: '^29.0.0',
      mocha: '*'
    }
  });

  writeJson(path.join(dir, 'package-lock.json'), {
    name: 'fixture-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture-app', version: '1.0.0' },
      'node_modules/express': { version: '4.17.0' },
      'node_modules/left-pad': { version: '1.3.0' },
      'node_modules/nested-git': { version: '0.0.0' },
      'node_modules/jest': { version: '29.0.0' },
      'node_modules/mocha': { version: '10.0.0' }
    }
  });

  // express: pinned + licensed, but no license on purpose? keep license, used for drift case
  writeJson(path.join(dir, 'node_modules', 'express', 'package.json'), {
    name: 'express',
    version: '4.17.0',
    license: 'MIT'
  });

  // left-pad: no license field -> missing_license (low)
  writeJson(path.join(dir, 'node_modules', 'left-pad', 'package.json'), {
    name: 'left-pad',
    version: '1.3.0'
  });

  // a package with a postinstall script -> install_script (high)
  writeJson(path.join(dir, 'node_modules', 'nested-git', 'package.json'), {
    name: 'nested-git',
    version: '0.0.0',
    license: 'MIT',
    scripts: {
      postinstall: 'node ./setup.js'
    }
  });

  // duplicate versions of the same package -> duplicate_version (medium)
  writeJson(path.join(dir, 'node_modules', 'jest', 'package.json'), {
    name: 'jest',
    version: '29.0.0',
    license: 'MIT'
  });
  writeJson(path.join(dir, 'node_modules', 'express', 'node_modules', 'jest', 'package.json'), {
    name: 'jest',
    version: '27.0.0',
    license: 'MIT'
  });
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-scanner-selftest-'));
  try {
    const fixture = path.join(tmp, 'project');
    fs.mkdirSync(fixture, { recursive: true });
    buildFixture(fixture);

    const result = scanner.scanProject(fixture, { includeDev: true });
    const findings = result.findings;

    assert(result.manifestFound === true, 'manifest should be detected');
    assert(result.lockfile.present === true, 'lockfile should be detected');
    assert(result.lockfile.name === 'package-lock.json', 'lockfile name mismatch');
    assert(result.nodeModules.present === true, 'node_modules should be detected');
    assert(result.nodeModules.packageCount >= 4, 'expected at least 4 installed packages, got ' + result.nodeModules.packageCount);

    assert(hasFinding(findings, 'unpinned_dependency', 'high', 'left-pad'), 'expected high unpinned_dependency for left-pad');
    assert(hasFinding(findings, 'unpinned_dependency', 'low', 'mocha'), 'expected low unpinned_dependency for devDependency mocha');
    assert(hasFinding(findings, 'loose_dependency', 'low', 'jest'), 'expected low loose_dependency for devDependency jest');
    assert(hasFinding(findings, 'loose_dependency', 'medium', 'express'), 'expected medium loose_dependency for express');
    assert(hasFinding(findings, 'non_registry_dependency', 'high', 'nested-git'), 'expected high non_registry_dependency for nested-git');
    assert(hasFinding(findings, 'install_script', 'high', 'nested-git'), 'expected high install_script for nested-git');
    assert(hasFinding(findings, 'duplicate_version', 'medium', 'jest'), 'expected medium duplicate_version for jest');
    assert(hasFinding(findings, 'missing_license', 'low', 'left-pad'), 'expected low missing_license for left-pad');
    assert(hasFinding(findings, 'lock_drift', 'medium', 'express'), 'expected medium lock_drift for express (lock 4.17.0 vs ^4.18.0)');

    const drift = hasFinding(findings, 'lock_drift', 'medium', 'express');
    assert(drift && drift.locked === '4.17.0', 'lock_drift should record the locked version');

    const scripts = scanner.detectInstallScripts(path.join(fixture, 'node_modules'));
    assert(scripts.length === 1, 'expected exactly 1 install script, got ' + scripts.length);
    assert(scripts[0].hook === 'postinstall', 'expected postinstall hook');

    const report = scanner.renderReport(result);
    assert(typeof report === 'string' && report.indexOf('dependency-scanner report') !== -1, 'report header missing');
    assert(report.indexOf('[HIGH]') !== -1, 'report should list a HIGH finding');

    // second fixture: no lockfile -> missing_lockfile (high)
    const noLock = path.join(tmp, 'no-lock');
    fs.mkdirSync(noLock, { recursive: true });
    writeJson(path.join(noLock, 'package.json'), {
      name: 'no-lock-app',
      version: '1.0.0',
      dependencies: { 'flat-dep': '1.0.0' }
    });
    const result2 = scanner.scanProject(noLock, { includeDev: true });
    assert(hasFinding(result2.findings, 'missing_lockfile', 'high'), 'expected high missing_lockfile');
    assert(result2.lockfile.present === false, 'lockfile should be absent');

    // manifest-only helper
    const manifestFindings = scanner.analyzePackageJson({ dependencies: { a: '*' } });
    assert(hasFinding(manifestFindings, 'unpinned_dependency', 'high', 'a'), 'analyzePackageJson should flag floating dep');

    // CLI entry point must not throw (stdout captured so the selftest prints one line only)
    const originalWrite = process.stdout.write;
    let captured = '';
    process.stdout.write = function (chunk) { captured += String(chunk); return true; };
    let cli;
    try {
      cli = scanner.main([fixture, '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert(captured.indexOf('"findings"') !== -1, 'main() --json should emit JSON');
    assert(cli.exitCode === 0, 'main() without --strict must exit 0');
    assert(cli.result.summary.total === findings.length, 'main() result should match scan result');

    process.stdout.write('[dependency-scanner selftest] OK — all assertions passed (' + findings.length + ' findings on fixture, ' + result2.findings.length + ' on no-lock fixture)\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  run();
  process.exit(0);
} catch (err) {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
}
