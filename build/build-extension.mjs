#!/usr/bin/env node
/**
 * @fileoverview Builds the Chrome Web Store (MV3) package from the single
 * userscript source.
 *
 * There is one source of truth — `src/amex-assistant.user.js`. This script:
 *   1. strips the `// ==UserScript== … // ==/UserScript==` metadata block,
 *   2. reads `@version` from that block so the manifest never drifts,
 *   3. writes an unpacked extension to `dist/extension/`, and
 *   4. zips it to `dist/amex-assistant-<version>.zip` for upload.
 *
 * The script itself needs no changes: it has `@grant none`, touches no GM_* or
 * chrome.* API, only fetches same-origin Amex endpoints, and builds its UI in a
 * Shadow DOM — so it runs unmodified as an isolated-world content script.
 *
 * Escape hatch: if some Amex endpoint turns out to need the page's own JS
 * context, run `EXT_WORLD=MAIN node build/build-extension.mjs` to inject into
 * the main world (Chrome 111+), exactly replicating Tampermonkey `@grant none`.
 */

import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'amex-assistant.user.js');
const ICONS_SRC = join(ROOT, 'extension', 'icons');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'extension');

/** @return {{header: string, body: string}} */
function splitUserscript(text) {
  const end = text.indexOf('// ==/UserScript==');
  if (end === -1) throw new Error('no ==/UserScript== marker found');
  const headerEnd = text.indexOf('\n', end) + 1;
  return {
    header: text.slice(0, headerEnd),
    body: text.slice(headerEnd).replace(/^\s+/, ''),
  };
}

/** @return {string} Value of a `@field` in the userscript metadata block. */
function meta(header, field) {
  const m = header.match(new RegExp(`^// @${field}\\s+(.+)$`, 'm'));
  if (!m) throw new Error(`missing @${field} in userscript header`);
  return m[1].trim();
}

function main() {
  const text = readFileSync(SRC, 'utf8');
  const {header, body} = splitUserscript(text);

  const version = meta(header, 'version');
  const description = meta(header, 'description');
  if (description.length > 132) {
    throw new Error(`description is ${description.length} chars (max 132)`);
  }

  const manifest = {
    manifest_version: 3,
    name: 'Amex Assistant',
    version,
    description,
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    content_scripts: [{
      matches: ['https://global.americanexpress.com/*'],
      js: ['amex-assistant.js'],
      run_at: 'document_idle',
      ...(process.env.EXT_WORLD === 'MAIN' ? {world: 'MAIN'} : {}),
    }],
    homepage_url: meta(header, 'homepageURL'),
  };

  // Clean rebuild.
  rmSync(DIST, {recursive: true, force: true});
  mkdirSync(OUT, {recursive: true});

  writeFileSync(join(OUT, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(OUT, 'amex-assistant.js'), body);
  cpSync(ICONS_SRC, join(OUT, 'icons'), {recursive: true});

  // Zip with manifest.json at the archive root (CWS requirement).
  const zipName = `amex-assistant-${version}.zip`;
  execFileSync('zip', ['-r', '-X', join(DIST, zipName), '.'],
      {cwd: OUT, stdio: 'ignore'});

  const worldNote = process.env.EXT_WORLD === 'MAIN' ?
    ' (world: MAIN)' : ' (world: isolated)';
  console.log(`built v${version}${worldNote}`);
  console.log(`  unpacked: dist/extension/`);
  console.log(`  upload:   dist/${zipName}`);
}

main();
