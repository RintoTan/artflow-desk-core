# DEV-06D-1-DROP-01 修复报告

**范围：** Finder 拖拽的合法投放区收敛到「参考图片」面板；拖到别处零写入。

**状态：** U2 **仍未标记 PASS** —— 真实 Finder 拖放 = NOT RUN，需 Mac 复验。

---

## 一、事件机制与坐标结论（有出处，不靠猜）

以仓库里安装的 `@tauri-apps/api` 类型定义为准（`node_modules/@tauri-apps/api/webview.d.ts`）：

> Positions are in physical pixels, relative to the webview's top-left corner.

事件有四种：`enter`（带 paths）、`over`（只带 position）、`drop`（带 paths + position）、`leave`。

结论：

1. **单位是物理像素**，不是 CSS 像素；retina（DPR=2）下必须除以 `window.devicePixelRatio`，否则坐标翻倍。
2. **原点就是 webview 左上角**，与 `window`/`document` 的 CSS 视口原点一致，因此只需要做一次 DPR 缩放，不需要加窗口位置、标题栏高度或滚动偏移。
3. 换算后的点与 `element.getBoundingClientRect()`（CSS 像素，含滚动偏移）可以直接比较。
4. 上一版"同时试 DPR 和 1 两种刻度、谁命中算谁"的做法**已删除**：它会在 DPR=2 时把右下方向的落点误判到面板内。现在只有一条换算路径。

## 二、上一版为什么在真实机器上不工作（已定位）

不是坐标问题，是**面板矩形根本没量到**：上一次重构把 `<section ref={sectionRef} className="panel attach-panel">` 覆盖回 `<section className="panel">`，`ref` 与 `attach-panel` 类一起丢失。于是：

- `sectionRef.current === null` → `rectOf()` 返回 `null`；
- 高亮函数 `hits()` 恒为 false（拖到面板上没有任何高亮）；
- `drop` 分支按"命中矩形才导入"判断 → 永远不导入；
- 整个过程不报错，用户看到的就是"拖进去没反应"。

这正是 POLISH-02-FIX 的 U2 在 Mac 上仍失败的原因。本轮恢复 `ref` 与类名，并新增一条组件级测试锁住这个回归（"落在面板内 → 只导入一次"）。

## 三、代码修复

`src/lib/attachmentDrop.ts` 新增纯函数：

| 函数 | 职责 |
|---|---|
| `physicalToCss(position, dpr)` | 物理像素 → CSS 像素；坐标非有限数返回 `null` |
| `isInsideRect(point, rect, pad)` | 点是否在矩形内（默认不外加 padding） |
| `decideDrop({position, dpr, rect, paths, dragOrderId, activeOrderId, now, lastDropAt})` | 返回 `{import:true, paths}` 或 `{import:false, reason}` |

`decideDrop` 的拒绝原因（任一命中即不导入）：

1. `no-paths` —— 没有文件路径；
2. `duplicate` —— 距上次成功 drop < 800ms；
3. `order-changed` —— 拖拽开始时的订单 ≠ 当前订单；
4. `missing-position` —— 坐标缺失或非法；
5. `outside` —— 换算后的落点不在参考图片面板矩形内（矩形为 `null` 也算 outside）。

`src/components/AttachmentPanel.tsx`：

- 只把 `sectionRef`（参考图片面板）作为合法区域，**不再用 `.orders-detail` 兜底**；
- `enter` / `over` 只更新高亮；`leave` 清除高亮与拖拽订单标记；
- `drop` 一律经过 `decideDrop`；`import` 为 true 才调用既有 `attachmentApi.import`；
- 第一次 `enter`/`over` 时记住当时的 `orderId`（后续 over 不覆盖），拖拽中换单会在 drop 时被识别为 `order-changed`；
- 卸载时 `unlisten` + 清空 `dragOrderId` + 关高亮；
- 反馈：`order-changed` → 错误提示"拖拽期间切换了订单，这次没有导入"；`no-paths` → 错误提示；`missing-position` → 非侵入 notice"无法判断落点，没有导入"；`outside` → **安静不导入**（不打扰，也不写入）；
- 点击「选择图片 / 添加图片」与空状态点击仍走原来的 `openDialog` → `importPaths`，未改。

未改：附件导入命令、扩展名白名单、100MB 上限、存储路径、附件表结构、权限。

## 四、测试

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npm run build` | ✓ built in 114ms |
| `npx vitest run` | **385 passed / 43 files** |
| `npm run layout:check`（900/1400/530，Blink） | **27/27 通过** |

### 4.1 落点判定（`src/lib/attachmentDrop.test.ts`，12 项）

| 任务要求 | 对应用例 | 结果 |
|---|---|---|
| 参考图片区内 drop → 导入一次 | `面板内松手（物理坐标）→ 导入` | PASS |
| 订单列表 drop → 零写入 | `订单列表 / 侧边栏 / 详情其它区域` | PASS |
| 侧边栏 drop → 零写入 | 同上 | PASS |
| 详情其它区域 drop → 零写入 | 同上 + `没有量到面板矩形` | PASS |
| 坐标无效/缺失 → 零写入 | `坐标缺失或非法` | PASS |
| 拖入途中切换订单 → 不误导入 | `拖拽期间换单` | PASS |
| 重复事件 → 不重复 | `重复 drop` | PASS |
| 非法扩展名 → 拒绝 | 既有 3 项扩展名用例 | PASS |
| 边缘判定不虚扩 | `紧贴边缘外侧 1px 即拒绝` | PASS |
| DPR 换算 | `Retina 下坐标要除以 DPR` | PASS |

### 4.2 组件级零写入（`src/components/AttachmentPanel.drop.test.tsx`，6 项）

用假的 `onDragDropEvent` 驱动真实组件，断言 `attachmentApi.import` 的调用次数：

1. 面板内 drop → `import` 调用 **1 次**，参数 `{orderId:"o1", sourcePaths:["/tmp/a.png"]}`；
2. 列表/侧栏/详情其它区域 → **0 次**，且不产生错误提示；
3. 坐标缺失 → **0 次** + 一条 notice；
4. 拖拽期间 `orderId` 变成 o2 → **0 次** + 错误提示，未写到 o2；
5. 连续两次 drop → 仍然 **1 次**；
6. 点击空状态 → 走文件选择并导入（原功能未回归）。

## 五、Mac 实机证据

**NOT RUN。** 本轮执行环境无法用 Finder 真实拖放，Blink 与 jsdom 都不能产生 Tauri 的 `drag-drop` 事件，不构成实机证据。

最短复验（QA identifier、`seeded` 场景）：

| 步骤 | 期望 |
|---|---|
| 1. Finder 拖 1 张 PNG 到「参考图片」空状态 | 面板出现强调色描边；松手后提示"已导入 1 张图片"，缩略图出现 |
| 2. 再拖 1 张 PNG 到订单列表卡片上 | **不导入**、无新增附件、无报错弹窗 |
| 3. 再拖 1 张 PNG 到左侧导航（客户/设置） | **不导入**、无新增附件 |
| 4. 拖到资料表单中间松手 | **不导入**（安静） |
| 5. 拖 `.gif` 到参考图片面板 | 提示"不支持 .gif，只接受 PNG / JPEG / WebP"，无新增 |
| 6. 拖入时先按住、用键盘/鼠标切到另一张订单再松手 | 提示"拖拽期间切换了订单"，两张订单都没有新增 |

复验时可用「数据环境 → 附件数量」或重新进入订单核对，避免依赖提示文案。

## 六、未验证的风险

1. 真实 Finder 拖放（含 `enter`/`over` 的坐标是否与 `devicePixelRatio` 完全一致）**未取证**；若 Mac 上 DPR 与 `devicePixelRatio` 不一致（外接屏缩放切换），换算仍可能偏差，需要实机确认。
2. `enter` 事件里 `paths` 与 `position` 同时存在，本轮只用它记订单与高亮；若某些 Tauri 版本不派发 `over`，高亮可能只在 `enter` 瞬间出现。
3. 面板在视口外（需要滚动才能看到）时，矩形仍在视口坐标系内，理论上正常；未在实机滚动态验证。
4. `outside` 选择"安静不导入"：用户拖到列表上不会得到任何提示。若产品希望有提示，需要新增一条非侵入 toast，本轮未做。

## 七、提交

- `1a44be4` 代码：参考图片面板为唯一投放区 + 恢复 `sectionRef` + 单一路径 DPR 换算 + 6 项组件测试
- 报告与交付包单独提交
