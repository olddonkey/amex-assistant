# Amex Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Greasy Fork](https://img.shields.io/greasyfork/v/585884.svg)](https://greasyfork.org/en/scripts/585884-amex-assistant)
[![Installs](https://img.shields.io/greasyfork/dt/585884.svg)](https://greasyfork.org/en/scripts/585884-amex-assistant)

A **personal-use** Tampermonkey userscript for American Express. Log in, open a
small injected panel, **pick an offer, and add it to several cards at once** —
add it to every eligible card, or expand an offer to choose specific cards.
After enrolling it re-reads each card and reports which cards **actually** got
the offer.

Design goals: **local-only, no backend, no telemetry, no IP collection**, and
fully auditable source (`@grant none`, so it is technically unable to contact
any third party).

> ⚠️ These endpoints are undocumented; American Express may change them at any
> time. See [`DISCLAIMER.md`](DISCLAIMER.md).

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/)
   or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script — either:
   - **[Greasy Fork](https://greasyfork.org/en/scripts/585884-amex-assistant)**
     (one-click install, recommended), or
   - **[direct from GitHub](https://raw.githubusercontent.com/olddonkey/amex-assistant/main/src/amex-assistant.user.js)**
     (raw `.user.js`; installed copies auto-update from this URL).
3. Go to `https://global.americanexpress.com/`, log in, and click the
   **Amex 助手** button that appears on the page.

## Use

1. Click **Amex 助手** — the panel reads every card and its offers.
2. Tick an offer to queue it for **all** its eligible cards, or expand it to
   choose specific cards. Already-added cards are disabled.
3. Click **加到所选卡** — this submits the selected Add to Card attempts. All
   cards for the *same* offer are submitted together (once one card takes an
   offer, Amex can make it ineligible on the others, so submitting together is
   what lets more than one card win); different offers are paced a bit apart.
   When done, the panel re-reads the added-to-card lists and reports
   `confirmed / failed / suspected dedupe / unconfirmed` results.

`suspected dedupe` = Amex returned success, but the offer was **not** found on
that card after re-reading the added-to-card list. This is commonly caused by
American Express allowing the same offer on only one card. It is expected, not a
tool bug (see `DISCLAIMER.md`).

## Development

No build step — the userscript is the artifact. Tests and lint run on Node
(no American Express account needed; the network layer is exercised against a
fetch mock in `test/`).

```sh
npm install
npm test        # node --test against fixtures + mock fetch
npm run lint    # ESLint (Google-style conventions via @stylistic)
```

## Before trusting a real run

The internal API is undocumented, so confirm it against your own live session
once (this is the one step that needs your login): follow the DevTools checklist
in [`docs/FINDINGS.md`](docs/FINDINGS.md) §4, then do a first real enroll by
selecting a single offer on one card and confirm it shows as `verified`.

## Docs

- [`docs/FINDINGS.md`](docs/FINDINGS.md) — the internal Amex offers API this tool uses.
- [`docs/PLAN.md`](docs/PLAN.md) — design, milestones, reference skeleton.
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — agent handoff plan.

## Disclaimer

Not affiliated with American Express. Automating your own account may be a gray
area of the Amex Terms of Service; use at your own risk. This tool does not, and
cannot, guarantee that an offer will be added to more than one card. MIT
licensed; written from scratch. See [`DISCLAIMER.md`](DISCLAIMER.md) and
[`LICENSE`](LICENSE).
