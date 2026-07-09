# Raw store captures

Drop the panel screenshots here, then run `npm run build:store` to compose the
1280×800 Chrome Web Store images into `docs/store/`.

Expected files (English UI, panel only, no page background behind it):

| File | Which view |
|------|------------|
| `offers.png`   | The Offers list (search + offer rows + "Add to selected cards") |
| `results.png`  | The "Done — verified" results view |
| `benefits.png` | The Benefits tab (per-card credit progress) |
| `launcher.png` | The floating launcher pill on an Amex page |

Capture at a normal window zoom so text stays crisp; the composer scales each to
fit. These raw files are inputs — the uploadable images are the generated
`docs/store/NN-*.png`.
