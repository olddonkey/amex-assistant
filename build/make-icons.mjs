#!/usr/bin/env node
/**
 * @fileoverview Rasterizes the extension icon (Claude Design option "5c" — a
 * two-card stack with a "+" badge) to PNGs at every size the store and browser
 * need. Renders the exact source SVG with headless Chrome — the same engine the
 * browser uses — so the output is pixel-identical to the design.
 *
 * The design ships two artworks: the full mark (used at 128/48), and a
 * simplified mark for tiny sizes (the thin card band and chip line drop out so
 * they don't turn to mud). 16px uses the simplified one, matching the design's
 * own "48 / 16 缩小检验".
 *
 * Source of truth: extension/icons/icon.svg (full) and icon-small.svg.
 * Requires Google Chrome; override the binary with CHROME=/path/to/chrome.
 *
 * Usage: node build/make-icons.mjs
 */

import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension',
    'icons');

// size -> which SVG source to render. 16px uses the simplified artwork.
const PLAN = [
  {size: 128, svg: 'icon.svg'},
  {size: 48, svg: 'icon.svg'},
  {size: 32, svg: 'icon.svg'},
  {size: 16, svg: 'icon-small.svg'},
];

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find(existsSync);
  if (!hit) {
    throw new Error(
        'Chrome not found. Set CHROME=/path/to/chrome. Tried:\n  ' +
        CHROME_CANDIDATES.join('\n  '));
  }
  return hit;
}

function render(chrome, svgSource, size, outPath, tmp) {
  // The SVG has a 0 0 128 128 viewBox; scale it to `size` and screenshot a
  // window of exactly that size on a transparent background.
  const inner = readFileSync(join(ICONS, svgSource), 'utf8')
      .replace(/width="128"/, `width="${size}"`)
      .replace(/height="128"/, `height="${size}"`);
  const html = `<!doctype html><meta charset=utf-8>` +
      `<style>html,body{margin:0;padding:0}svg{display:block}</style>${inner}`;
  const htmlPath = join(tmp, `render-${size}.html`);
  writeFileSync(htmlPath, html);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${size},${size}`,
    '--default-background-color=00000000',
    `--screenshot=${outPath}`, htmlPath,
  ], {stdio: 'ignore'});
}

function main() {
  const chrome = findChrome();
  const tmp = mkdtempSync(join(tmpdir(), 'amex-icons-'));
  for (const {size, svg} of PLAN) {
    const out = join(ICONS, `icon-${size}.png`);
    render(chrome, svg, size, out, tmp);
    console.log(`wrote icon-${size}.png  (from ${svg})`);
  }
}

main();
