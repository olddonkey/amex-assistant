Plain white stat card (number + label). Row of 3 under the search box. Never tint the background (no rainbow stat cards).
```jsx
<div style={{display:'flex',gap:8}}>
  <StatCard value="$2027.48" label="已返现" tone="success" />
  <StatCard value="23" label="待消费" />
  <StatCard value="2" label="7 天内过期" tone="danger" />
</div>
```
