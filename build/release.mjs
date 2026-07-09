#!/usr/bin/env node
/**
 * @fileoverview Cuts a release with the git tag and the userscript's
 * `@version` kept in lockstep, so the two can never drift apart.
 *
 *   npm run release                    tag the current @version (no bump)
 *   npm run release patch              0.23.0 -> 0.23.1 (also: minor, major)
 *   npm run release 0.24.0             explicit target version
 *   npm run release patch -- --dry-run print the plan, change nothing
 *
 * Flow: verify a clean main in sync with origin -> bump `@version` when a
 * spec is given -> lint + tests -> commit `Bump version to X.Y.Z` -> tag
 * `vX.Y.Z` -> push main and the tag. The Release workflow then builds,
 * attaches the zip to a GitHub Release, and uploads the store draft.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'amex-assistant.user.js');

/**
 * Runs a command from the repo root and returns trimmed stdout.
 * @param {string} cmd Executable.
 * @param {!Array<string>} args Arguments.
 * @param {!Object=} opts execFileSync overrides.
 * @return {string} Trimmed stdout ('' when stdio is inherited).
 */
function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {cwd: ROOT, encoding: 'utf8', ...opts});
  return typeof out === 'string' ? out.trim() : '';
}

/**
 * Prints an error and exits.
 * @param {string} msg What went wrong.
 */
function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = args.includes('--dry-run');
const spec = args.find((a) => a !== '--dry-run') || '';

const source = readFileSync(SRC, 'utf8');
const versionLine = /^(\/\/ @version\s+)(\d+\.\d+\.\d+)$/m;
const match = source.match(versionLine);
if (!match) fail('cannot find @version in src/amex-assistant.user.js');
const current = match[2];

/** @return {string} The target version `spec` names, relative to `current`. */
function resolveTarget() {
  if (!spec) return current;
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  fail(`unknown version spec "${spec}" (use major, minor, patch, or x.y.z)`);
  return ''; // unreachable
}

/**
 * @param {string} a Semver x.y.z.
 * @param {string} b Semver x.y.z.
 * @return {boolean} Whether `a` sorts before `b`.
 */
function lessThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

const target = resolveTarget();
const tag = `v${target}`;
if (lessThan(target, current)) {
  fail(`target ${target} is below the current @version ${current}`);
}

// Preflight: releases only cut from a clean, up-to-date main.
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('run from the main branch');
}
// Untracked files are tolerated: the bump commit only stages tracked ones.
if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
  fail('working tree has uncommitted changes');
}
run('git', ['fetch', 'origin', 'main', '--tags']);
if (run('git', ['rev-parse', 'main']) !==
    run('git', ['rev-parse', 'origin/main'])) {
  fail('main is not in sync with origin/main — pull or push first');
}
if (run('git', ['tag', '-l', tag])) fail(`tag ${tag} already exists`);

console.log(`release: ${current} -> ${target} (tag ${tag})` +
    (dryRun ? ' [dry-run, nothing changed]' : ''));
if (dryRun) process.exit(0);

if (target !== current) {
  writeFileSync(SRC, source.replace(versionLine, `$1${target}`));
}
run('npm', ['run', 'lint'], {stdio: 'inherit'});
run('npm', ['test'], {stdio: 'inherit'});
if (target !== current) {
  run('git', ['commit', '-am', `Bump version to ${target}`],
    {stdio: 'inherit'});
}
run('git', ['tag', tag]);
run('git', ['push', 'origin', 'main', tag], {stdio: 'inherit'});
console.log(`release: pushed ${tag} — the Release workflow takes it from here.`);
