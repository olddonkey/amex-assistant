Panel header, canonical button order: 展开⤢/收窄 · EN · ⟳ · ×. Tab underline is bright blue (action color).
```jsx
<PanelHeader subtitle="166 个 offer · 8 张卡 · 刚刚更新" tabs={['Offers','Benefits']} activeTab="Offers" />
```
v1.2 落地修订: the density toggle is the SAME round icon button in both
densities (family of EN/⟳/×) — glyphs mirror (expand = heads at corners
pointing out; collapse = heads near center pulling in), direction named in
the tooltip. The labeled 收窄 pill from the 9a mock is deprecated. The
toggle hides entirely below 940px viewport width (no dead controls).
