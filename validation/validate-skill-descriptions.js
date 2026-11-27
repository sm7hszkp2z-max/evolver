'use strict';
// Validation for cycle #0103 (skill description resolution).
//
// Proves, against the REAL repo skills, that the "Skills available" block the
// GEP prompt injects no longer hides a skill behind the "No description"
// placeholder. Before the fix dependency-scanner, exec-redundancy-auditor and
// protocol-drift-monitor all rendered as "No description" even though their
// SKILL.md frontmatter carried a proper description.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PLACEHOLDER,
  resolveSkillDescription,
  listSkillNames,
  buildSkillList,
  computeSkillsFingerprint,
} = require('../src/gep/skillDescription');

const skillsDir = path.join(__dirname, '..', 'skills');
let failures = 0;

function fail(msg) {
  failures++;
  console.error('[FAIL] ' + msg);
}

const names = listSkillNames(skillsDir);
if (!names.length) {
  fail('no skills found in ' + skillsDir);
}

for (const name of names) {
  const desc = resolveSkillDescription(skillsDir, name);
  if (desc === PLACEHOLDER) {
    fail('skill "' + name + '" resolves to the placeholder description');
  } else {
    console.log('[ok] ' + name + ' -> ' + desc);
  }
}

const list = buildSkillList(skillsDir);
if (list.includes(PLACEHOLDER)) {
  fail('the rendered skills list still contains "' + PLACEHOLDER + '"');
}
if (!list.includes('- **exec-redundancy-auditor**:')) {
  fail('the rendered skills list is missing the exec-redundancy-auditor entry');
}
if (!/^(- \*\*)/m.test(list)) {
  fail('the rendered skills list has no markdown entries');
}

// The cache fingerprint must react to a metadata edit (the old cache was keyed
// on the mtime of skills/ and never noticed one).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fingerprint-'));
const probeDir = path.join(tmp, 'probe');
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(path.join(probeDir, 'SKILL.md'), '---\nname: probe\ndescription: probe\n---\n');
const fpBefore = computeSkillsFingerprint(tmp);
fs.writeFileSync(path.join(probeDir, 'SKILL.md'), '---\nname: probe\ndescription: changed\n---\n');
const fpAfter = computeSkillsFingerprint(tmp);
fs.rmSync(tmp, { recursive: true, force: true });
if (fpBefore === fpAfter) {
  fail('the skills fingerprint does not react to a metadata change');
}

if (failures) {
  console.error('[FAIL] skill description validation failed with ' + failures + ' problem(s)');
  process.exit(1);
}
console.log('[PASS] every registered skill is discoverable in the GEP prompt');
