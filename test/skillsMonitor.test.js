const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findMissingSkillDependencies } = require('../src/ops/skills_monitor');
// Build fixture paths dynamically so the production scanner does not mistake
// deliberately missing fixture dependencies for dependencies of this test file.
const skillsName = 'skills';
const dep = (skill, file) => [skillsName, skill, file].join('/');

test('integration preflight resolves nested skill references through a repo symlink', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-deps-'));
  try {
    const ws = path.join(tmp, 'workspace');
    const repo = path.join(tmp, 'repo');
    const local = path.join(repo, skillsName, 'auditor');
    fs.mkdirSync(path.join(ws, skillsName, 'sibling'), { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    fs.symlinkSync(repo, path.join(ws, skillsName, 'evolver'), 'dir');
    fs.writeFileSync(path.join(local, 'index.js'), 'console.log("Usage: node ' + dep('auditor', 'index.js') + '");');
    fs.writeFileSync(path.join(repo, 'index.js'), "require('./" + dep('auditor', 'index.js') + "'); require('" + dep('sibling', 'helper.js') + "');");
    fs.writeFileSync(path.join(ws, skillsName, 'sibling', 'helper.js'), 'module.exports = {};');
    assert.deepEqual(findMissingSkillDependencies({ workspaceRoot: ws }), []);

    // A genuinely absent nested dependency must still be detected.
    fs.appendFileSync(path.join(local, 'index.js'), "\nrequire('" + dep('absent', 'helper.js') + "');");
    const missing = findMissingSkillDependencies({ workspaceRoot: ws });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].target, dep('absent', 'helper.js'));
    assert.equal(missing[0].source, [skillsName, 'evolver', dep('auditor', 'index.js')].join('/'));

    // A directory named like the dependency is not an executable file.
    fs.mkdirSync(path.join(repo, skillsName, 'absent', 'helper.js'), { recursive: true });
    assert.equal(findMissingSkillDependencies({ workspaceRoot: ws })[0].target, dep('absent', 'helper.js'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
