#!/usr/bin/env node
'use strict';

// Command line front end for the long-file-writer skill.
//
//   node scripts/write-long-file.js --out <file> [--in <src> | --stdin]
//                                       [--max-lines N] [--max-chars N]
//                                       [--resume | --atomic] [--dry-run]

// The command writes the file in segments (write part 1, append the rest),
// reads it back from disk and verifies every seam. It prints a JSON report.

var fs = require('fs');
var skill = require('../index.js');

var USAGE = [
  'usage: node write-long-file.js --out <file> [--in <src> | --stdin]',
  '                           [--max-lines N] [--max-chars N] [--resume | --atomic]',
  '                           [--dry-run]',
  '',
  'Writes a long file in verifiable segments: split at natural boundaries,',
  'write part 1, append the rest, read the file back and verify every seam.',
  '',
  '  --dry-run   print the plan only, do not touch the filesystem',
  '  --resume    continue from the last successfully written boundary',
  '  --atomic    build and verify a temporary file before replacing --out',
  '',
  'safety: ' + skill.RECOVERY_RULE,
  ''
].join('\n');

function parseArgs(argv) {
  var opts = {
    out: null,
    input: null,
    stdin: false,
    maxLines: skill.DEFAULTS.maxLines,
    maxChars: skill.DEFAULTS.maxChars,
    resume: false,
    atomic: false,
    dryRun: false,
    help: false
  };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--out' || arg === '-o') opts.out = argv[++i];
    else if (arg === '--in' || arg === '-i') opts.input = argv[++i];
    else if (arg === '--stdin') opts.stdin = true;
    else if (arg === '--max-lines') opts.maxLines = parseInt(argv[++i], 10);
    else if (arg === '--max-chars') opts.maxChars = parseInt(argv[++i], 10);
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--atomic') opts.atomic = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!opts.out) opts.out = arg;
  }
  return opts;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

function run(argv) {
  var opts = parseArgs(argv || []);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.out) {
    console.error(USAGE);
    return 2;
  }
  if (opts.resume && opts.atomic) {
    console.error('long-file-writer: --resume and --atomic cannot be combined.');
    return 2;
  }

  var content = '';
  if (opts.stdin) {
    content = readStdin();
  } else if (opts.input) {
    content = fs.readFileSync(opts.input, 'utf8');
  } else {
    console.error('long-file-writer: no input. Use --in <file> or --stdin.');
    return 2;
  }

  var writeOpts = {
    maxLines: opts.maxLines,
    maxChars: opts.maxChars,
    resume: opts.resume,
    atomic: opts.atomic
  };

  if (opts.dryRun) {
    console.log(JSON.stringify(skill.planWrite(opts.out, content, writeOpts), null, 2));
    return 0;
  }

  var report = skill.writeLongFile(opts.out, content, writeOpts);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

module.exports = { run: run, parseArgs: parseArgs, USAGE: USAGE };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
