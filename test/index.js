// Aggregator entry point for `node --test test/`.
//
// Node v24 resolves a directory argument to <dir>/index.js instead of scanning
// the directory for test files, so `node --test test/` fails with
// "Cannot find module .../test" unless this file exists. Requiring the suite
// files here keeps that command working.
//
// The *.test.js files stay independently runnable (e.g. `node --test
// test/selector.test.js`), and bare `node --test` still discovers them.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const suiteFiles = fs
  .readdirSync(here)
  .filter(f => f.endsWith('.test.js'))
  .sort();

for (const file of suiteFiles) {
  require(path.join(here, file));
}
