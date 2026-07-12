Segmented control for DATASET switching only (可加/已加). Hard rule: max ONE per screen; view options (grouping/sorting) use TextDropdown instead.
```jsx
<SegmentedPill options={[{value:'addable',label:'可加',count:143},{value:'added',label:'已加',count:37}]} value={tab} onChange={setTab} />
```
