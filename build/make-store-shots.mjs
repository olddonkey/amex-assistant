#!/usr/bin/env node
/**
 * @fileoverview Composes the Chrome Web Store screenshots (1280x800) from raw
 * panel captures. Each raw screenshot (portrait, panel-only) is placed as a
 * floating card on a light blue-gray gradient next to a headline, then rendered
 * with headless Chrome so the output is exactly 1280x800.
 *
 * Drop the raw captures here (English UI, panel only, no page background):
 *   docs/store/raw/offers.png    docs/store/raw/results.png
 *   docs/store/raw/benefits.png  docs/store/raw/launcher.png
 * Output: docs/store/01-offers.png … (upload these to the store listing).
 *
 * Requires Google Chrome; override with CHROME=/path/to/chrome.
 * Usage: node build/make-store-shots.mjs
 */

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync}
  from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'docs', 'store', 'raw');
const OUT = join(ROOT, 'docs', 'store');

const BRAND_ICON =
    '<svg width="100%" height="100%" viewBox="0 0 128 128" ' +
    'style="display:block"><rect width="128" height="128" rx="26" ' +
    'fill="#006FCF"/><rect x="34" y="26" width="66" height="44" rx="7" ' +
    'fill="#7FB5E5"/><rect x="22" y="42" width="66" height="44" rx="7" ' +
    'fill="#fff"/><rect x="22" y="52" width="66" height="9" fill="#B3D4F0"/>' +
    '<rect x="30" y="70" width="26" height="6" rx="3" fill="#C9CCD0"/>' +
    '<circle cx="92" cy="90" r="21" fill="#00175A"/><rect x="84" y="87" ' +
    'width="16" height="6" rx="2" fill="#fff"/><rect x="89" y="82" width="6" ' +
    'height="16" rx="2" fill="#fff"/></svg>';

const SHOTS = [
  {
    raw: 'offers.png', out: '01-offers.png',
    headline: 'Add an offer to every\neligible card at once',
    sub: 'Search across all your Amex cards, pick the offers you ' +
        'want, and enroll them in a single click.',
  },
  {
    raw: 'results.png', out: '02-results.png',
    headline: 'Then confirm which\ncards actually got it',
    sub: 'After enrolling, it re-reads each card and reports ' +
        'confirmed, failed, or unverified — no guessing.',
  },
  {
    raw: 'benefits.png', out: '03-benefits.png',
    headline: 'Track every statement\ncredit across your cards',
    sub: 'Remaining amount, per-card progress, and expiry dates — ' +
        'all read-only. Nothing is stored.',
  },
  {
    raw: 'launcher.png', out: '04-launcher.png', layout: 'hero',
    headline: 'One panel, right inside americanexpress.com',
    sub: 'Runs in your own logged-in session. Local-only — no ' +
        'telemetry, no backend, no third parties.',
  },
];

function findChrome() {
  const c = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  const hit = c.find(existsSync);
  if (!hit) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  return hit;
}

const COMMON_CSS = `
  *{margin:0;box-sizing:border-box}
  html,body{width:1280px;height:800px;overflow:hidden}
  .frame{width:1280px;height:800px;
    background:linear-gradient(135deg,#f4f7fb 0%,#e4ecf6 100%);
    font-family:'Helvetica Neue',Helvetica,Arial,sans-serif}
  .eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:26px}
  .eyebrow .ic{width:30px;height:30px}
  .eyebrow .wm{font-size:15px;font-weight:800;color:#00175A;letter-spacing:.2px}
  h1{font-size:44px;line-height:1.14;font-weight:800;color:#00175A;
    letter-spacing:-.3px}
  .accent{width:52px;height:5px;background:#006FCF;border-radius:3px}
  p{font-size:19px;line-height:1.55;color:#4A5568}
  .card{border-radius:14px;border:1px solid rgba(0,0,0,.07);
    box-shadow:0 24px 64px rgba(0,23,90,.20)}`;

// Tall panel on the right, headline on the left.
function sideFrame(b64, h, sub) {
  return `<!doctype html><meta charset=utf-8><style>${COMMON_CSS}
  .frame{display:flex;align-items:center}
  .text{flex:1;padding:0 40px 0 96px}
  .accent{margin:26px 0}
  p{max-width:520px}
  .panelwrap{width:540px;height:800px;display:flex;align-items:center;
    justify-content:center}
  .card{max-height:716px;max-width:470px}
  </style><div class="frame"><div class="text">
    <div class="eyebrow"><div class="ic">${BRAND_ICON}</div>
      <div class="wm">Amex Assistant</div></div>
    <h1>${h}</h1><div class="accent"></div><p>${sub}</p>
  </div><div class="panelwrap">
    <img class="card" src="data:image/png;base64,${b64}"></div></div>`;
}

// Centered headline on top, wide landscape capture below.
function heroFrame(b64, h, sub) {
  return `<!doctype html><meta charset=utf-8><style>${COMMON_CSS}
  .frame{display:flex;flex-direction:column;align-items:center;
    justify-content:center;text-align:center;padding:56px 80px}
  .eyebrow{justify-content:center}
  h1{max-width:900px}
  .accent{margin:24px auto 22px}
  p{max-width:640px}
  .card{max-width:920px;max-height:360px;margin-top:44px}
  </style><div class="frame">
    <div class="eyebrow"><div class="ic">${BRAND_ICON}</div>
      <div class="wm">Amex Assistant</div></div>
    <h1>${h}</h1><div class="accent"></div><p>${sub}</p>
    <img class="card" src="data:image/png;base64,${b64}"></div>`;
}

function frame(b64, shot) {
  const h = shot.headline.split('\n').join('<br>');
  return shot.layout === 'hero' ?
    heroFrame(b64, h, shot.sub) : sideFrame(b64, h, shot.sub);
}

function main() {
  const chrome = findChrome();
  mkdirSync(OUT, {recursive: true});
  const tmp = mkdtempSync(join(tmpdir(), 'amex-store-'));
  let done = 0;
  for (const s of SHOTS) {
    const rawPath = join(RAW, s.raw);
    if (!existsSync(rawPath)) {
      console.log(`skip ${s.out} — missing docs/store/raw/${s.raw}`);
      continue;
    }
    const b64 = readFileSync(rawPath).toString('base64');
    const htmlPath = join(tmp, s.out + '.html');
    writeFileSync(htmlPath, frame(b64, s));
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=1280,800',
      `--screenshot=${join(OUT, s.out)}`, htmlPath,
    ], {stdio: 'ignore'});
    console.log(`wrote docs/store/${s.out}`);
    done++;
  }
  if (!done) {
    console.log('\nNo raw screenshots found. Save your captures to ' +
        'docs/store/raw/ (offers.png, results.png, benefits.png, ' +
        'launcher.png) and re-run.');
  }
}

main();
