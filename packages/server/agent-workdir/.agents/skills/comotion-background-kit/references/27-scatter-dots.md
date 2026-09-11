# 27 · scatter-dots

**氣氛**：大小不一的圓點隨機散布在右半，像粒子或星點。輕、有隨機感，不規律所以不呆板。

**適合**：`anchor`、`breathing`。
**不適合**：`dense`。

**建議 opacity**：0.55

**做法**：十二個半徑與透明度都不同的圓，全部落在右半，左半保持乾淨。

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="<background>"/>
<circle cx="687" cy="114" r="9" fill="<accent>" opacity="0.57"/><circle cx="763" cy="114" r="7" fill="<primary>" opacity="0.6"/><circle cx="768" cy="529" r="12" fill="<primary>" opacity="0.35"/><circle cx="1001" cy="336" r="9" fill="<accent>" opacity="0.7"/><circle cx="736" cy="53" r="15" fill="<primary>" opacity="0.46"/><circle cx="799" cy="258" r="8" fill="<primary>" opacity="0.68"/><circle cx="806" cy="183" r="11" fill="<accent>" opacity="0.52"/><circle cx="1252" cy="594" r="8" fill="<primary>" opacity="0.38"/><circle cx="1182" cy="693" r="4" fill="<primary>" opacity="0.59"/><circle cx="1201" cy="470" r="7" fill="<accent>" opacity="0.62"/><circle cx="1118" cy="168" r="12" fill="<primary>" opacity="0.39"/><circle cx="705" cy="262" r="8" fill="<primary>" opacity="0.46"/><circle cx="1068" cy="592" r="16" fill="<accent>" opacity="0.69"/><circle cx="1276" cy="561" r="8" fill="<primary>" opacity="0.37"/><circle cx="1054" cy="400" r="12" fill="<primary>" opacity="0.34"/><circle cx="796" cy="648" r="11" fill="<accent>" opacity="0.58"/><circle cx="737" cy="303" r="15" fill="<primary>" opacity="0.56"/><circle cx="1275" cy="170" r="9" fill="<primary>" opacity="0.62"/>
</svg>
```

**建議風格**：01、04、15、23。
