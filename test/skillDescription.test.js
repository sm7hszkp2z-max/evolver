'use strict';
const test = require('node:test');
const assert = require('node:assert');
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

function makeSkill(root, name, pkg, skillMd) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), pkg);
  if (skillMd !== undefined) fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  return dir;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-desc-'));
}

test('package.json description wins', () => {
  const root = tmpRoot();
  makeSkill(
    root,
    'a',
    JSON.stringify({ name: 'a', version: '1.0.0', description: 'from package' }),
    '---\nname: a\ndescription: from skill md\n---\n'
  );
  assert.strictEqual(resolveSkillDescription(root, 'a'), 'from package');
});

test('SKILL.md frontmatter is used when package.json has no description', () => {
  // Regression (cycle #0103): this exact combination used to render
  // "No description" in the GEP prompt, because the SKILL.md fallback only ran
  // when require(package.json) threw.
  const root = tmpRoot();
  makeSkill(
    root,
    'b',
    JSON.stringify({ name: 'b', version: '1.0.0' }),
    '---\nname: b\ndescription: frontmatter description\n---\n\n# b\n'
  );
  assert.strictEqual(resolveSkillDescription(root, 'b'), 'frontmatter description');
});

test('first meaningful prose line is the last resort before the placeholder', () => {
  const root = tmpRoot();
  makeSkill(root, 'c', JSON.stringify({ name: 'c', version: '1.0.0' }), '# c\n\nSome prose line.\n');
  assert.strictEqual(resolveSkillDescription(root, 'c'), 'Some prose line.');
});

test('placeholder only when the skill carries no description at all', () => {
  const root = tmpRoot();
  makeSkill(root, 'd', JSON.stringify({ name: 'd', version: '1.0.0' }), '# d\n');
  assert.strictEqual(resolveSkillDescription(root, 'd'), PLACEHOLDER);
});

test('folded YAML description is supported', () => {
  const root = tmpRoot();
  makeSkill(
    root,
    'e',
    JSON.stringify({ name: 'e', version: '1.0.0' }),
    '---\nname: e\ndescription: >\n  folded description\n  over two lines\n---\n'
  );
  assert.strictEqual(resolveSkillDescription(root, 'e'), 'folded description over two lines');
});

test('descriptions are truncated to 100 characters', () => {
  const root = tmpRoot();
  makeSkill(root, 'f', JSON.stringify({ name: 'f', version: '1.0.0', description: 'x'.repeat(150) }));
  const desc = resolveSkillDescription(root, 'f');
  assert.strictEqual(desc.length, 103);
  assert.ok(desc.endsWith('...'));
});

test('buildSkillList renders one entry per skill and no placeholder', () => {
  const root = tmpRoot();
  makeSkill(root, 'g', JSON.stringify({ name: 'g', version: '1.0.0', description: 'gg' }));
  makeSkill(root, 'h', JSON.stringify({ name: 'h', version: '1.0.0' }), '---\nname: h\ndescription: hh\n---\n');
  const list = buildSkillList(root);
  assert.ok(list.includes('- **g**: gg'));
  assert.ok(list.includes('- **h**: hh'));
  assert.ok(!list.includes(PLACEHOLDER));
});

test('the metadata fingerprint reacts to a skill metadata edit', () => {
  const root = tmpRoot();
  makeSkill(root, 'i', JSON.stringify({ name: 'i', version: '1.0.0' }), '---\nname: i\ndescription: ii\n---\n');
  const before = computeSkillsFingerprint(root);
  fs.writeFileSync(path.join(root, 'i', 'SKILL.md'), '---\nname: i\ndescription: changed\n---\n');
  const after = computeSkillsFingerprint(root);
  assert.notStrictEqual(before, after);
});

test('every skill registered in this repo is discoverable', () => {
  const skillsDir = path.join(__dirname, '..', 'skills');
  const names = listSkillNames(skillsDir);
  assert.ok(names.length > 0, 'the repo must ship at least one skill');
  for (const name of names) {
    const desc = resolveSkillDescription(skillsDir, name);
    assert.notStrictEqual(desc, PLACEHOLDER, 'skill ' + name + ' has no discoverable description');
    assert.ok(desc.trim().length > 0, 'skill ' + name + ' has an empty description');
  }
});
