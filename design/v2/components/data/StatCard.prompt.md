Plain white stat card (number + label). Row of 3 under the search box. Never tint the background (no rainbow stat cards).
```jsx
<div style={{display:'flex',gap:8}}>
  <StatCard value="$2027.48" label="已返现" tone="success" />
  <StatCard value="23" label="待消费" />
  <StatCard value="2" label="7 天内过期" tone="danger" />
</div>
```
v1.2 落地修订: in WIDE mode the tiles sit in the same control row as the
search box, so they are single-line (value + label inline), stretched to the
row's height, radius 9px (control tier) — otherwise the Benefits top block is
taller than the Offers one and content jumps on tab switch. The stacked
two-line form remains the sidebar layout.
