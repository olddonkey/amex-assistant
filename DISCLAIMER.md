# Disclaimer

This project is an independent, personal-use tool. It is **not** affiliated
with, endorsed by, or connected to American Express in any way.

## Use at your own risk

- Automating actions on your own American Express account may fall into a gray
  area of the American Express Terms of Service. You use this tool entirely at
  your own risk. The authors accept no liability (see `LICENSE`).
- The tool talks **only** to `americanexpress.com` using your already-logged-in
  browser session. It sends **no** data to any third party, collects **no**
  credentials, reads **no** cookies, and has **no** backend. The userscript
  declares `@grant none`, so it is technically incapable of contacting any
  external server. You can verify this from the header alone.

## No guarantee of "same offer on multiple cards"

American Express enforces a per-person de-duplication rule on many offers. When
you add the same offer to several cards, the server may accept it on only one
card and silently ignore the rest — the enroll request can still report success
while the offer never actually lands. This tool therefore **re-reads the
"added to card" list after enrolling and reports the true result** per card
(verified / failed / reported-success-but-not-verified). It does not, and
cannot, guarantee that an offer will be added to more than one card.

## Undocumented API

The internal endpoints this tool uses were identified by observing the public
American Express web app in the browser. They are undocumented and may change at
any time, which can break the tool until its constants are updated. See
`docs/FINDINGS.md`.
