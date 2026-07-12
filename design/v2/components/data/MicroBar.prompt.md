3px progress bar. Rule: render ONLY when 0 < percent < 100 (部分使用) — never show empty or full bars; unused/done states are expressed by text + row tint instead.
```jsx
{pct > 0 && pct < 100 && <MicroBar percent={pct} style={{marginTop:9}} />}
```
