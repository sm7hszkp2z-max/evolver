'use strict';
// Skill description resolution for the GEP prompt "Skills available" block.
//
// Why this module exists (cycle #0103):
// The executor (Hand) learns which skills exist ONLY from the
// "Skills available (if any)" block that src/evolve.js injects into the GEP
// prompt. The old resolver read skills/<name>/package.json and only fell back
// to the SKILL.md YAML frontmatter when require(package.json) THREW. A skill
// with a valid package.json that simply has no "description" key therefore
// rendered as "No description" -- even though its SKILL.md carried a proper
// frontmatter description.
//
// The GEP skill-creation contract only requires package.json to carry
// "name and version", so every skill created by a compliant Hand lands in
// exactly that blind spot. 3 of the 5 registered skills were invisible that
// way, including exec-redundancy-auditor -- the skill that turns the
// repeated_tool_usage:exec signal into numbers.
//
// Resolution order (first hit wins):
//   1. package.json  -> description
//   2. SKILL.md      -> YAML frontmatter description (single line or folded)
//   3. SKILL.md      -> first meaningful prose line
//   4. placeholder   -> "No description"

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_DESCRIPTION_CHARS = 100;
const PLACEHOLDER = 'No description';

function truncateDescription(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return s.length > MAX_DESCRIPTION_CHARS ? s.slice(0, MAX_DESCRIPTION_CHARS) + '...' : s;
}

function stripWrappingQuotes(value) {
  const s = String(value || '').trim();
  if (s.length >= 2) {
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function extractFrontmatter(skillMd) {
  const text = String(skillMd || '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[1] : null;
}

function readFrontmatterDescription(frontmatter) {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[1].trim();
    // Folded / literal YAML block scalar: description: > or description: |
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        const blockLine = lines[j];
        if (!blockLine.trim()) {
          parts.push('');
          continue;
        }
        if (!/^[ \t]/.test(blockLine)) break;
        parts.push(blockLine.trim());
      }
      value = parts.join(' ').trim();
    }
    value = stripWrappingQuotes(value);
    if (value) return value;
  }
  return null;
}

function readFirstMeaningfulLine(skillMd) {
  const lines = String(skillMd || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('---')) continue;
    if (trimmed.startsWith('```')) continue;
    return trimmed;
  }
  return null;
}

function readPackageDescription(skillsDir, name) {
  try {
    const pkgPath = path.join(skillsDir, name, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.description === 'string' && pkg.description.trim()) {
      return pkg.description.trim();
    }
    return null;
  } catch (e) {
    return null;
  }
}

function readSkillMdDescription(skillsDir, name) {
  try {
    const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return null;
    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    const frontmatter = readFrontmatterDescription(extractFrontmatter(skillMd));
    if (frontmatter) return frontmatter;
    // Loose match outside a frontmatter block (legacy SKILL.md shape).
    const loose = /^description:[ \t]*(.*)$/m.exec(skillMd);
    if (loose && loose[1] && loose[1].trim()) return stripWrappingQuotes(loose[1]);
    return readFirstMeaningfulLine(skillMd);
  } catch (e) {
    return null;
  }
}

function resolveSkillDescription(skillsDir, name) {
  const fromPackage = readPackageDescription(skillsDir, name);
  if (fromPackage) return truncateDescription(fromPackage);
  const fromSkillMd = readSkillMdDescription(skillsDir, name);
  if (fromSkillMd) return truncateDescription(fromSkillMd);
  return PLACEHOLDER;
}

function listSkillNames(skillsDir) {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .sort();
  } catch (e) {
    return [];
  }
}

function buildSkillList(skillsDir) {
  const names = listSkillNames(skillsDir);
  if (!names.length) return '[skills directory not found]';
  return names
    .map(name => '- **' + name + '**: ' + resolveSkillDescription(skillsDir, name))
    .join('\n');
}

// Content fingerprint of the registered skill metadata.
//
// The old cache was keyed on the mtime of skills/ itself, which never changes
// when a skill's own SKILL.md/package.json is edited. An edited skill therefore
// kept its stale description for the whole cache TTL. Fingerprinting the
// metadata files makes the cache honest: any metadata edit invalidates it.
function computeSkillsFingerprint(skillsDir) {
  const parts = [];
  for (const name of listSkillNames(skillsDir)) {
    const dir = path.join(skillsDir, name);
    const entries = [];
    for (const file of ['SKILL.md', 'package.json']) {
      const p = path.join(dir, file);
      try {
        const st = fs.statSync(p);
        entries.push(file + ':' + st.mtimeMs + ':' + st.size);
      } catch (e) {}
    }
    try {
      const st = fs.statSync(dir);
      entries.push('dir:' + st.mtimeMs);
    } catch (e) {}
    parts.push(name + '|' + entries.join(','));
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

module.exports = {
  MAX_DESCRIPTION_CHARS,
  PLACEHOLDER,
  truncateDescription,
  extractFrontmatter,
  readFrontmatterDescription,
  readFirstMeaningfulLine,
  resolveSkillDescription,
  listSkillNames,
  buildSkillList,
  computeSkillsFingerprint,
};
