# FIX-A 设置保存栏

## 根因（不是 sticky）

`position: static` 之后仍会看到大片淡色/白色区域，根因在 `.settings-savebar` 自身：

```css
display: flex;
flex-wrap: wrap;
justify-content: space-between;
```

900px 窗口下容器只有 ~585px，状态文案 + 三个按钮放不进一行 → 按钮换行。flex 多行容器的 `align-content` 默认是 `stretch`，会把两行拉开填满容器可用高度，于是保存区被撑成一块很高的矩形。之前它有 `background: var(--surface)`，看起来就是"巨大白色悬浮面板遮住设置内容"。

第一版 sticky 的问题是另一件事（覆盖内容）；这一版换了 static，但同一个视觉现象仍由 flex 多行拉伸复现。

## 修改

`src/styles.css` → `.settings-savebar` 改为 grid：

```css
display: grid;
grid-template-columns: minmax(0, 1fr) auto;
gap: 12px 16px;
align-items: center;
position: static;
border-top: 1px solid var(--border);
background: transparent;
```

- 窄容器（≤720px）→ 单列，按钮左对齐，不再换行拉伸。
- 无 sticky / fixed / backdrop-filter / 负 margin / 固定高度 / 全局 overflow 隐藏。
- 保存、放弃修改、未保存提示、恢复默认主题确认都没有改。

## 证据

- `screenshots/01-保存栏-900-修复前.png`：900px 滚到底，状态与按钮之间约 240px 空白（复现）。
- `screenshots/02-保存栏-900-修复后.png`：同一位置，保存区高度收缩到内容高度。
- `screenshots/03-保存栏-1400.png`：1400px 滚到底，按钮与状态同排。

## 仍未验证

Mac WKWebView 900/1400 的实际像素：**NOT RUN**。需要实机确认三件事：滚动中段不遮挡模块、滚到底保存区正常出现、400px 高窗口能滚到按钮。
