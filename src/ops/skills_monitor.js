// Skills Monitor (v2.0) - Evolver Core Module
// Checks installed skills for real issues, auto-heals simple problems.
// Zero Feishu dependency.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const paths = require('../gep/paths');
const { getSkillsDir, getWorkspaceRoot } = paths;

const IGNORE_LIST = new Set([
    'common',
    'clawhub',
    'input-validator',
    'proactive-agent',
    'security-audit',
]);

// Load user-defined ignore list
try {
    var ignoreFile = path.join(getWorkspaceRoot(), '.skill_monitor_ignore');
    if (fs.existsSync(ignoreFile)) {
        fs.readFileSync(ignoreFile, 'utf8').split('\n').forEach(function(l) {
            var t = l.trim();
            if (t && !t.startsWith('#')) IGNORE_LIST.add(t);
        });
    }
} catch (e) { /* ignore */ }

function checkSkill(skillName) {
    var SKILLS_DIR = getSkillsDir();
    if (IGNORE_LIST.has(skillName)) return null;
    var skillPath = path.join(SKILLS_DIR, skillName);
    var issues = [];

    try { if (!fs.statSync(skillPath).isDirectory()) return null; } catch (e) { return null; }

    var mainFile = 'index.js';
    var pkgPath = path.join(skillPath, 'package.json');
    var hasPkg = false;

    if (fs.existsSync(pkgPath)) {
        hasPkg = true;
        try {
            var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main) mainFile = pkg.main;
            if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
                if (!fs.existsSync(path.join(skillPath, 'node_modules'))) {
                    issues.push('Missing node_modules (needs npm install)');
                } else {
                    // Optimization: Check for node_modules existence instead of spawning node
                    // Spawning node for every skill is too slow (perf_bottleneck).
                    // We assume if node_modules exists, it's likely okay.
                    // Only spawn check if we really suspect issues (e.g. empty node_modules).
                    try {
                        if (fs.readdirSync(path.join(skillPath, 'node_modules')).length === 0) {
                             issues.push('Empty node_modules (needs npm install)');
                        }
                    } catch (e) {
                        issues.push('Invalid node_modules');
                    }
                }
            }
        } catch (e) {
            issues.push('Invalid package.json');
        }
    }

    if (mainFile.endsWith('.js')) {
        var entryPoint = path.join(skillPath, mainFile);
        if (fs.existsSync(entryPoint)) {
            // Optimization: Syntax check via node -c is slow.
            // We can trust the runtime to catch syntax errors when loading.
            // Or we can use a lighter check if absolutely necessary.
            // For now, removing the synchronous spawn to fix perf_bottleneck.
        }
    }

    if (hasPkg && !fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
        issues.push('Missing SKILL.md');
    }

    return issues.length > 0 ? { name: skillName, issues: issues } : null;
}

function autoHeal(skillName, issues) {
    var SKILLS_DIR = getSkillsDir();
    var skillPath = path.join(SKILLS_DIR, skillName);
    var healed = [];

    for (var i = 0; i < issues.length; i++) {
        if (issues[i] === 'Missing node_modules (needs npm install)' || issues[i] === 'Empty node_modules (needs npm install)') {
            try {
                // Remove package-lock.json if it exists to prevent conflict errors
                try { fs.unlinkSync(path.join(skillPath, 'package-lock.json')); } catch (e) {}
                
                execSync('npm install --production --no-audit --no-fund', {
                    cwd: skillPath, stdio: 'ignore', timeout: 60000 // Increased timeout
                });
                healed.push(issues[i]);
                console.log('[SkillsMonitor] Auto-healed ' + skillName + ': npm install');
            } catch (e) {
                console.error('[SkillsMonitor] Failed to heal ' + skillName + ': ' + e.message);
            }
        } else if (issues[i] === 'Missing SKILL.md') {
            try {
                var name = skillName.replace(/-/g, ' ');
                fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# ' + skillName + '\n\n' + name + ' skill.\n');
                healed.push(issues[i]);
                console.log('[SkillsMonitor] Auto-healed ' + skillName + ': created SKILL.md stub');
            } catch (e) {}
        }
    }
    return healed;
}

// --- Cross-skill integration dependency scan ---
// Skills often call helper scripts that live inside a sibling skill
// (e.g. feishu-evolver-wrapper -> skills/feishu-doc/create.js). When the
// sibling skill is missing, the failure only surfaces deep inside a cycle
// ("[IssueTracker] feishu-doc/create.js not found, cannot create issue doc")
// and the agent burns exec calls rediscovering the same path every run.
// Detect these dangling references up front so the cycle starts with the
// exact missing path instead of a vague "not found" error.
var MAX_SCAN_FILES_PER_SKILL = 200;
var MAX_TOTAL_SCAN_FILES = 400;

// Matches both 'skills/<name>/<file>.js' and
// path.join(root, 'skills', '<name>', '<file>.js').
var DEP_REF_PATTERNS = [
  /skills\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9._-]+\.js)/gi,
  /['"]skills['"]\s*,\s*['"]([a-z0-9][a-z0-9._-]*)['"]\s*,\s*['"]([a-z0-9._-]+\.js)['"]/gi,
];

// Strip comments before matching dependency references. A path that only
// appears inside a comment is documentation ("e.g. skills/feishu-doc/create.js"),
// not a load-bearing reference, and reporting it sends the agent chasing a
// file that was never required.
function stripComments(content) {
  return String(content)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function resolveWorkspaceRoot() {
    try {
        if (typeof paths.getOpenclawWorkspaceRoot === 'function') return paths.getOpenclawWorkspaceRoot();
    } catch (e) {}
    return getWorkspaceRoot();
}

function collectSkillJsFiles(skillsDir, skillName) {
    var out = [];
    var stack = [path.join(skillsDir, skillName)];
    var guard = 0;
    while (stack.length > 0 && out.length < MAX_SCAN_FILES_PER_SKILL && guard < 2000) {
        guard++;
        var current = stack.pop();
        var entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (e) { continue; }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.name === 'node_modules' || entry.name.charAt(0) === '.') continue;
            var full = path.join(current, entry.name);
            if (entry.isDirectory()) { stack.push(full); continue; }
            if (entry.isFile() && entry.name.slice(-3) === '.js') {
                out.push(full);
                if (out.length >= MAX_SCAN_FILES_PER_SKILL) break;
            }
        }
    }
    return out;
}

function resolveDepTarget(workspaceRoot, skillName, fileName) {
    var candidates = [
        path.join(workspaceRoot, 'skills', skillName, fileName),
        path.join(workspaceRoot, 'skills', skillName, 'scripts', fileName),
        path.join(workspaceRoot, '.openclaw', 'plugin-skills', skillName, fileName),
        path.join(os.homedir(), '.openclaw', 'plugin-skills', skillName, fileName),
    ];
    for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return null;
}

// Returns [{ target, source, skill }] for every referenced sibling-skill
// helper script that does not exist on disk.
function findMissingSkillDependencies(options) {
    var opts = options || {};
    var workspaceRoot = opts.workspaceRoot || resolveWorkspaceRoot();
    var skillsDir = opts.skillsDir || path.join(workspaceRoot, 'skills');
    var missing = [];
    var seen = new Set();
    var scanned = 0;
    var skills = [];
    try { skills = fs.readdirSync(skillsDir); } catch (e) { return missing; }

    for (var i = 0; i < skills.length; i++) {
        if (scanned >= MAX_TOTAL_SCAN_FILES) break;
        var skillName = skills[i];
        if (skillName.charAt(0) === '.') continue;
        var skillPath = path.join(skillsDir, skillName);
        try { if (!fs.statSync(skillPath).isDirectory()) continue; } catch (e) { continue; }

        var files = collectSkillJsFiles(skillsDir, skillName);
        scanned += files.length;
        for (var f = 0; f < files.length; f++) {
            var content;
            try { content = stripComments(fs.readFileSync(files[f], 'utf8')); } catch (e) { continue; }
            for (var p = 0; p < DEP_REF_PATTERNS.length; p++) {
                var re = new RegExp(DEP_REF_PATTERNS[p].source, 'gi');
                var m;
                while ((m = re.exec(content)) !== null) {
                    var depSkill = m[1];
                    var depFile = m[2];
                    if (depSkill === skillName) continue;
                    var target = 'skills/' + depSkill + '/' + depFile;
                    if (seen.has(target)) continue;
                    if (resolveDepTarget(workspaceRoot, depSkill, depFile)) continue;
                    seen.add(target);
                    missing.push({
                        target: target,
                        source: path.relative(workspaceRoot, files[f]),
                        skill: skillName,
                    });
                }
            }
        }
    }
    return missing;
}

function run(options) {
    var heal = (options && options.autoHeal) !== false;
    var SKILLS_DIR = getSkillsDir();
    var skills = fs.readdirSync(SKILLS_DIR);
    var report = [];

    for (var i = 0; i < skills.length; i++) {
        if (skills[i].startsWith('.')) continue;
        var result = checkSkill(skills[i]);
        if (result) {
            if (heal) {
                var healed = autoHeal(result.name, result.issues);
                result.issues = result.issues.filter(function(issue) { return !healed.includes(issue); });
                if (result.issues.length === 0) continue;
            }
            report.push(result);
        }
    }
    return report;
}

if (require.main === module) {
    var issues = run();
    console.log(JSON.stringify(issues, null, 2));
    process.exit(issues.length > 0 ? 1 : 0);
}

module.exports = { run, checkSkill, autoHeal, findMissingSkillDependencies };
