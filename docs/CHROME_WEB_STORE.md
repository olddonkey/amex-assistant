# Publishing to the Chrome Web Store

The extension is built from the single userscript source
(`src/amex-assistant.user.js`) — same code that ships to Greasy Fork, just
wrapped as an MV3 content script. Nothing in `src/` needs to change to build it.

## Build

```bash
npm run build:icons   # regenerate extension/icons/*.png (rarely needed)
npm run build         # -> dist/extension/ (unpacked) + dist/amex-assistant-<version>.zip
```

The version and description come from the userscript `@version` / `@description`
header, so the manifest never drifts. `dist/` is git-ignored.

### Isolated vs. main world

By default the content script runs in Chrome's **isolated world** (recommended:
it can't be tampered with by the page, and reads better to reviewers). The
script needs no page globals, so this is expected to work unchanged.

If some Amex endpoint turns out to require the page's own JS context, rebuild
with the main world — this exactly replicates Tampermonkey `@grant none`:

```bash
EXT_WORLD=MAIN npm run build
```

## Test locally before submitting

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `dist/extension/`.
4. Go to `https://global.americanexpress.com`, log in, and run the full flow:
   launcher appears → open panel → read cards → enroll an offer → verify the
   re-read result → open Benefits. Confirm no console errors.
5. Only after this passes, upload the `.zip`.

## One-time setup

- A Google account registered as a Chrome Web Store developer
  (**one-time $5 fee**, 2FA required).
- A verified contact email on the developer account.

## Store listing (draft)

Keep the copy about **what it does for the user**. Do not describe undocumented
or internal APIs anywhere in the public listing.

- **Name:** `Amex Assistant`
  _Matches the Greasy Fork name for recognizability. This leads with the brand
  word, which carries higher trademark/impersonation risk at review — the
  "Not affiliated…" disclaimer below and in the description is doing the heavy
  lifting. Safer fallbacks if rejected: `Amex Assistant (Unofficial)` or
  `Offers Assistant for Amex (Unofficial)`._
- **Summary (≤132 chars):** Pick an Amex Offer and add it to multiple cards from
  one panel; verify which cards got it. Local-only, no telemetry.
- **Category:** Productivity
- **Language:** English (primary)
- **Description:**

  > Manage American Express Offers and Benefits across all your cards from one
  > panel.
  >
  > • Pick an offer once and add it to every eligible card in a single click.
  > • After enrolling, the panel re-reads each card and shows which cards
  >   actually received the offer.
  > • Review your statement-credit benefits — remaining amount, amount used this
  >   year, and expiry — with per-card detail.
  >
  > Privacy: everything runs locally in your browser during your logged-in
  > session on americanexpress.com. No data is collected, no telemetry, no
  > third-party servers.
  >
  > Not affiliated with, endorsed by, or sponsored by American Express.
  > "American Express" and "Amex" are trademarks of their respective owner.

- **Privacy policy URL:**
  `https://github.com/olddonkey/amex-assistant/blob/main/PRIVACY.md`
- **Homepage URL:** `https://github.com/olddonkey/amex-assistant`

## Privacy practices tab

- **Single purpose:** "Manage American Express Offers and Benefits on
  americanexpress.com — add an offer to multiple cards at once and review
  benefits progress."
- **Permission justification** — host access to `global.americanexpress.com`:
  "Required to read the user's cards, offers, and benefits and to submit
  add-to-card requests on the American Express site. No other permissions are
  requested." (There is no `permissions` array — content-script match only.)
- **Data usage declarations:** certify **no** collection/use for every category.
  The extension sends nothing off-device except first-party requests back to
  americanexpress.com. Do **not** check any "collects data" box.

## Reviewer notes (paste into the submission's private notes)

> Reviewers cannot log into a personal American Express account, so the UI only
> appears after the tester's own login. To evaluate functionality without an
> account, see this short demo: <ADD DEMO VIDEO URL>. The extension runs only on
> global.americanexpress.com, requests only host access to that site, makes only
> first-party requests to americanexpress.com, and collects no data. Source:
> https://github.com/olddonkey/amex-assistant

## Assets checklist

- [x] Icon 128×128 (+16/48) — `extension/icons/`, bundled by the build.
- [x] **Screenshots — 1280×800, 24-bit PNG, no alpha.** Drop panel captures in
      `docs/store/raw/` and run `npm run build:store` — it composes each onto a
      branded 1280×800 frame in `docs/store/` (`01-offers` … `04-launcher`).
      Upload those to the listing's Screenshots slot.
- [x] Small promo tile 440×280 (optional) — `docs/store/promo-440x280.png`,
      generated by `npm run build:store`.
- [x] Marquee tile 1400×560 (optional) — `docs/store/marquee-1400x560.png`,
      generated by `npm run build:store`.
- [ ] Demo video URL for the reviewer notes (recommended — see above).

## Submit

1. Upload `dist/amex-assistant-<version>.zip` at
   <https://chrome.google.com/webstore/devconsole>.
2. Fill in the listing, privacy tab, and reviewer notes above.
3. Add screenshots.
4. Submit. First review is typically 1–5 business days; a name containing a
   brand word may add manual-review time.

## Updating later

Bump `@version` in `src/amex-assistant.user.js`, `npm run build`, upload the new
`.zip`. The store handles distribution and auto-updates — the userscript's
`@updateURL`/`@downloadURL` are irrelevant to the extension and are stripped from
the build.

## GitHub Actions

Two workflows automate the build:

- **`.github/workflows/ci.yml`** — on every push to `main` and every PR: lint,
  test, `npm run build`, and upload the resulting `.zip` as a run artifact. No
  secrets needed.
- **`.github/workflows/release.yml`** — on a `v*` tag: verifies the tag matches
  `@version`, builds, attaches the `.zip` to a GitHub Release, and (if the CWS
  secrets are set) uploads it to the Chrome Web Store **as a draft**.

Cutting a release:

```bash
# bump @version in src/amex-assistant.user.js to e.g. 0.22.0, commit, then:
git tag v0.22.0
git push origin v0.22.0
```

The tag must equal `@version` or the workflow fails on purpose (drift guard).

### Chrome Web Store draft-upload (optional)

The release workflow's last step uploads the new package to the store as a
**draft** — it never publishes. You still review and click **Publish** in the
dashboard. Until the secrets below are set, the step no-ops with a green check.

**One-time prerequisites:**

1. **Create the listing once by hand.** The API can only push new versions of an
   *existing* item, not create one. Do the first upload through the dashboard
   (see "Submit" above) to obtain the **Extension ID**.
2. **Get Chrome Web Store API credentials** (OAuth 2.0):
   - In the [Google Cloud Console](https://console.cloud.google.com/): create a
     project and enable the **Chrome Web Store API**.
   - Configure the OAuth consent screen (External; add your own Google account
     as a test user).
   - Create an **OAuth client ID** of type **Desktop app** → gives you a
     **client ID** and **client secret**.
   - Generate a **refresh token** for the scope
     `https://www.googleapis.com/auth/chromewebstore`. See the
     [chrome-webstore-upload keys guide](https://github.com/fregante/chrome-webstore-upload/blob/main/How%20to%20generate%20Google%20API%20keys.md).
3. **Add four repo secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `CWS_EXTENSION_ID` | the item's Extension ID |
   | `CWS_CLIENT_ID` | OAuth client ID |
   | `CWS_CLIENT_SECRET` | OAuth client secret |
   | `CWS_REFRESH_TOKEN` | OAuth refresh token |

After that, every `v*` tag builds, creates a GitHub Release, and drops a fresh
draft into the Web Store dashboard for you to review and publish.

> Supply-chain note: the step runs `chrome-webstore-upload-cli@3` via `npx`. To
> lock it down, pin an exact version (e.g. `chrome-webstore-upload-cli@3.3.1`).
