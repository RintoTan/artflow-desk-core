# DEV-06D-2-AUTO-QA-01 · 剩余交互与布局自动化验收报告

**性质：** 测试与验收。**未修改任何生产代码**、未改数据库、未改 `seeded` 数据、未推送。
**基线：** `master` @ `505e53bad73108e2d7988f3c739a7baf0912ca5f`
**日期：** 2026-11-18
**环境：** 无头 Google Chrome（Blink，`--headless=new`）+ Vite dev server；组件层 jsdom（Vitest 4.1.12）

---

## 0. 结论

| 项 | 结果 |
|---|---|
| U6-D 容器 900px 几何 | **PASS**（29 项几何断言全过，测量值与参考值差 4px，原因已定位） |
| U6-E 横向滚动与左右列独立性 | **PASS**（滚动由 CDP 直接赋值，不依赖触控板） |
| U7-B 焦点重取 | **PASS**（含旧请求不覆盖、无重复行、无定时轮询） |
| U7-C 主动刷新 | **PASS**（重取、更新、不重复、不重置尺度与终态开关）／**1 项行为差异**：刷新会把横向位置重置到今天 |
| U7-D 刷新失败保留旧数据 | **PASS** |
| U7-E 首次失败与重试 | **PASS** |

浏览器门禁 **29 / 29 通过**；组件测试 **59 / 59 通过**（新增 11 条）；`tsc` 0 错误；生产构建通过。

**不是** WKWebView / WebView2 实机结论；U6-A/B/C 的人工验收结果本轮未重复执行。

---

## 1. 执行前 Git 基线

```text
branch: master
HEAD:   505e53bad73108e2d7988f3c739a7baf0912ca5f
status --short:
  M docs/assets/dev06d-2-rev/05-月-900.png
  M docs/assets/dev06d-2-rev/12-滚动条板-1400.png
  M docs/assets/dev06d-2-rev/sheet/时间线原型联系表.png
  M docs/assets/dev06d-2-rev/sheet/滚动条设计状态联系表.png
  M docs/prototypes/dashboard-timeline-review.html
  M 交付给 ChatGPT 的文件/DEV-06D-2-PRE-REVISION/（5 个 md + zip + html + 2 png，共 9 项）
  ?? 交付给 ChatGPT 的文件/AFD-CORE-STABILIZATION-01/screenshots.zip
diff --stat: 13 files changed, 896 insertions(+), 510 deletions(-)
screenshots.zip sha256: 7e98dc6850027626a3f1c8dd0969a94a47a537069dfb83b384c318527b28f262
```

以上 13 项 `M` 与 1 项 `??` 在本轮**全程未动**（结束时再核对一次，见 §9）。

---

## 2. U6-D 容器 900px 几何

自变量：视口 1160，主内容容器强制 900（只改 `.main-inner` 宽度与内边距，不动时间线自身样式）。

| 指标 | 参考值 | 实测 | 判定 |
|---|---:|---:|---|
| 主内容容器 | 900 | **900** | PASS |
| 时间线框 | 858 | **854** | PASS（差 4px，见下） |
| 左侧信息列 | 235 | **235** | PASS |
| 右侧轨道可视宽 | 622 | **618** | PASS（差 4px，同一原因） |
| 行高 | 56 | **56** | PASS |
| 表头高 | — | 45 | — |
| 画布宽（月尺度，396 天×6px） | — | 2370 | — |

**4px 差异已定位到具体来源，不是布局错误**：

```text
854 = 900 − 2 × 22（面板 padding）+ 2（面板上下边框，横向各 1px）
618 = 854 − 235（信息列） − 1（信息列右分隔线）
```

实测 `panelPad = 22px`；参考值 858 对应 20px 内边距。即：实现用的面板内边距比原型多 2px/侧，直接吃掉 4px 轨道宽。行高、信息列宽度与参考值完全一致。

其余几何断言（全部 PASS）：

| 检查 | 实测 |
|---|---|
| 五条图例文字完整可见 | 按排期 48px / 三日内 48px / 今天到期 58px / 已逾期 48px / 已结束 48px，字号 10.5px，均有宽高 |
| 刻度与网格线同一坐标系 | 13 格 / 13 刻度，逐条 left 差 **0.00px** |
| 订单条落在画布内 | 条 left = 682 / 754 / 814，均在画布 [555, 2925] 内 |
| 信息列与轨道逐行 y 对齐 | 5 行 top 均为 665 / 721 / 777 / 833 / 889，差 0 |
| 容器内无横向溢出 | `pageScrollWidth 1160 = clientWidth 1160` |
| 轨道无纵向滚动 | `scrollHeight == clientHeight`，`overflow-x: auto` |
| 轨道可横向滚动 | `scrollWidth 2370 > clientWidth 618` |

---

## 3. U6-E 横向滚动与左右列独立性

由 CDP 直接给 `.timeline-scroll.scrollLeft` 赋值（`193 → 320`，Δ = 127），不依赖触控板或滚轮。

| 检查 | 实测 | 判定 |
|---|---|---|
| 轨道真的滚动了 | `scrollLeft 193 → 320`（请求 320，精确命中） | PASS |
| 左侧信息列位置不变 | 三条行 x 均 `255 → 255` | PASS |
| 信息列宽度不变 | `235 → 235` | PASS |
| 表头刻度与订单条同向同步移动 | 第一个刻度 `298 → 171`（Δ −127）；第一条 `682 → 555`（Δ −127）；两者差 0 | PASS |
| 滚动后刻度与网格线仍逐条重合 | 13 格，逐条差 0 | PASS |
| 今天竖线与「今天」旗同步 | 竖线 `769 → 642`（Δ −127）；旗 `754.5 → 627.5`（Δ −127） | PASS |
| 滚动后页面仍无横向溢出 | `1160 = 1160` | PASS |
| 滚动后各行仍对齐 | 行 top 仍为 665/721/777/833/889，行高全为 56 | PASS |
| 回滚到 0 后坐标线性复原 | 刻度误差 **0.00px**，条误差 **0.00px** | PASS |

滚动前后截图见联系表（`02-容器900-滚动后.png`）：表头从「10月」处起、条整体左移、左列文字纹丝不动。

---

## 4. U7-B 窗口失焦与重新获得焦点

浏览器侧用真实调用计数（夹具 `invoke` 记录每次 `list_orders`）：

| 检查 | 实测 | 判定 |
|---|---|---|
| 进入工作台读一次 | `list_orders = 1` | PASS |
| 触发 `window` focus 后重取 | `1 → 2` | PASS |
| 连续两次 focus 各触发一次 | `2 → 4`（不是 3，说明两次都真的发了请求，没有合并假象） | PASS |
| 连续 focus 后订单行不重复 | 行 5 / 去重 5，与滚动前一致 | PASS |

组件层（jsdom）补测两项，浏览器侧不便于观察：

| 检查 | 方法 | 判定 |
|---|---|---|
| 旧请求不覆盖新请求 | 让第 1 次请求挂起，触发第 2 次；先回新数据、再回旧数据 → 页面只显示新数据，旧数据不出现 | PASS |
| 无定时轮询 | 假时钟推进 10 分钟，`list_orders` 调用数仍为 1 | PASS |

> `focus` 事件本身在 Blink 无头环境里不会因窗口切换自然产生，本轮用 `window.dispatchEvent(new Event("focus"))` 触发，验证的是组件对事件的处理，不是操作系统的窗口激活链路。真实窗口切换（点别的 App 再点回来）属 Mac 实机，**NOT RUN**。

---

## 5. U7-C 用户主动刷新

**现有入口**：时间线操作行右侧的「刷新」按钮（`class="timeline-refresh"`）——DEV-06D-2 实施时已存在，不是本轮新增。

| 检查 | 实测 | 判定 |
|---|---|---|
| 刷新会重新请求订单 | `list_orders 4 → 5` | PASS |
| 刷新后内容更新 | 组件测试：标题替换为「刷新后的订单」，新增一单被渲染，计数文案变 `时间线 2 单` | PASS |
| 不重复插入 | 行数 5 → 5；组件层 id 去重后长度相等 | PASS |
| 不重置时间尺度 | `周 → 周`（`aria-pressed` 不变）；窗口文案 `2026-10-26 ~ 2027-01-17` 前后完全一致 | PASS |
| 不重置终态开关 | `false → false` | PASS |
| 刷新不改画布几何 | 画布宽 `2184 → 2184`（周尺度 84×26） | PASS |

**行为差异（记录，未修）**：

| 项 | 实测 | 说明 |
|---|---|---|
| 刷新会重置横向滚动位置 | `scrollLeft 250 → 333` | 刷新成功后 `setOrders` 触发 `[orders]` 副作用 `setCenterOn(today)`，轨道被重新居中到今天（45% 位置）。规格 §9 只规定"进入工作台 / 重新获得焦点 / 点刷新时重取"，**没有承诺保留横向位置**，因此不算违反规格，但每次刷新/切回窗口都会丢掉用户当前的横向位置。 |
| 重新获得焦点同样重置 | `scrollLeft 250 → 333` | 与刷新共用 `load()`，行为一致。 |

最小修复方向（**本轮未改**，供裁定）：把 `setCenterOn(today)` 限制为"首次拿到数据时执行一次"，而不是依赖 `orders` 引用变化。

---

## 6. U7-D 刷新失败保留旧数据

故障注入方式：组件测试里让 `api.listOrders` 第二次调用 reject（现有测试拦截能力），**没有**改正式数据库、没有改正式代码。

| 检查 | 实测 | 判定 |
|---|---|---|
| 原有订单继续显示 | 「测试订单」仍在 | PASS |
| 未退化成零订单状态 | 仍渲染 `.timeline-frame`，文案 `共 1 单` | PASS |
| 未显示虚构示例数据 | 无「尚无订单」「没有任何订单填入计划日期」 | PASS |
| 错误反馈符合现有设计 | `role="status"` 提示「刷新失败，仍显示上次读取的数据：…」+「重新尝试」按钮 | PASS |
| 再次刷新能恢复 | 点「重新尝试」后显示「恢复后的订单」，`role="status"` 消失 | PASS |
| 不误换成首次失败面板 | 不出现「无法读取时间线」 | PASS |

---

## 7. U7-E 首次加载失败与重试

| 检查 | 实测 | 判定 |
|---|---|---|
| 独立错误状态 | 出现「无法读取时间线」面板 + 原始错误串 | PASS |
| 明确重试入口 | 「重试」按钮可见 | PASS |
| 不显示虚构订单 | 无 `.timeline-row`，无任何空状态文案 | PASS |
| 不误显示空状态 | 「尚无订单」「没有任何订单填入计划日期」「活动订单已全部结束」均不出现 | PASS |
| 点重试后正常加载 | 调用数 `1 → 2`，渲染 `.timeline-frame`，行数 1 | PASS |
| 不产生重复请求 | 重试只发 1 次（总计 2 次） | PASS |
| 工作时区读取失败同样进错误面板 | 让 `api.status()` 失败 → 出现「无法读取时间线」，不渲染轨道 | PASS |

---

## 8. 测试命令与原始输出

```text
$ npx vitest run src/components/ProjectTimeline.refresh.test.tsx src/components/ProjectTimeline.test.tsx src/lib/timeline.test.ts
 ✓ src/lib/timeline.test.ts (26 tests)
 ✓ src/components/ProjectTimeline.refresh.test.tsx (11 tests)
 ✓ src/components/ProjectTimeline.test.tsx (22 tests)
 Test Files  3 passed (3)
      Tests  59 passed (59)

$ npx tsc --noEmit
exit=0

$ npm run build
✓ built in 119ms（仅既有 @tauri-apps/api dynamic-import 警告）

$ AUTOQA_WIDTH=1160 node scripts/timeline-autoqa.mjs http://127.0.0.1:1425/
{"summary":{"total":29,"passed":29,"failed":0}}
```

---

## 9. 新增文件（仅测试与交付物）

| 路径 | 行数/大小 | 作用 |
|---|---|---|
| `scripts/timeline-autoqa.mjs` | 596 行 | U6-D / U6-E / U7-B / U7-C 的浏览器自动化：夹具 IPC、几何测量、CDP 设 scrollLeft、截图、断言与观察项 |
| `src/components/ProjectTimeline.refresh.test.tsx` | 328 行 | U7-B/C/D/E 组件测试 11 条 |
| `docs/assets/dev06d-2-autoqa/01-容器900-滚动前.png` | 1160×1300 | 滚动前 |
| `docs/assets/dev06d-2-autoqa/02-容器900-滚动后.png` | 1160×1300 | 滚动后 |
| `docs/assets/dev06d-2-autoqa/03-容器900-刷新后.png` | 1160×1300 | 刷新后（周尺度） |
| `docs/assets/dev06d-2-autoqa/联系表.png` | 1212×4209 | 三图联系表 |
| `交付给 ChatGPT 的文件/DEV-06D-2-AUTO-QA-01/` | 4 文件 | 本报告、测试矩阵、ZIP、evidence/ |

**生产代码零改动**：`git diff --name-only` 中不含 `src/components/ProjectTimeline.tsx`、`src/lib/timeline.ts`、`src/styles.css`、Rust 任何文件。

---

## 10. 与既有规格不符 / 已知问题现状

| 编号 | 状态 | 本轮证据 |
|---|---|---|
| ISSUE-01 左侧标题显示不完整 | **确认仍存在** | `.timeline-title` 计算高度 **11.33px**，自身内容高 **17px**（5 行中 4 行如此，第 5 行 11.84/17）。原因：`.timeline-info` 固定 56px、`flex-direction: column` + `justify-content: center`、`padding: 8px 12px`，三个子元素自然高度约 46.5px + gap 2 + padding 16 = 64.5px > 56，flex 收缩把标题压到 11.33px，`overflow: hidden` 直接切掉字形下半。截图里表现为标题只剩上半截。 |
| ISSUE-02 周视图日期范围异常 | **未复现** | 周尺度实测：`窗口 2026-10-26 ~ 2027-01-17`（84 天，12 个完整自然周）、`可见 2026-11-07 ~ 2026-12-01`；第二层刻度 `11-02 / 11-09 / 11-16 / 11-23 / 11-30` 全部是周一，`11-16` 标注为今天。区间与周一对齐均符合规格第 4.1 节。**保持 OPEN**，等你描述具体现象或提供截图再定位。 |
| UX-TL-01 订单悬浮显示具体年月日 | **未做** | 本轮不动产品功能，登记待排期。 |
| 刷新重置横向位置 | **新增观察项** | 见 §5，规格未承诺，未修。 |

---

## 11. FAIL / PARTIAL / BLOCKED / NOT RUN 明细

| 项 | 状态 |
|---|---|
| 六项测试门禁（U6-D / U6-E / U7-B / U7-C / U7-D / U7-E） | 全部 PASS（29 浏览器断言 + 11 组件用例） |
| 刷新保留横向位置 | **PARTIAL**（规格未承诺；实测会重置） |
| macOS WKWebView 下重复本轮测量 | **NOT RUN**（无实机自动化通道） |
| Windows WebView2 | **NOT RUN** |
| 真实窗口切换（点别的 App 再切回）触发 focus | **NOT RUN**（无头环境用合成事件替代） |
| `scripts/layout-check.mjs` 全量几何回归 | **NOT RUN**（本轮只跑针对性脚本，避免大型浏览器套件） |
| 200 行以上性能 | **NOT RUN**（属 DEV-06D-2 既有 NOT RUN） |
| 触控板/滚轮横向滚动体感 | **NOT RUN**（本轮用 CDP 赋值，绕开输入设备） |
| 高对比度 / 减少动效 | **NOT RUN** |

---

## 12. Git 提交

```text
commit  <见下>
message test(dashboard): automate remaining timeline acceptance checks
files   2 新增测试/脚本 + 交付文件与截图
```

工作区状态见提交后输出：13 项历史 `M` 与 `screenshots.zip` 原样保留，未推送。

---

## 13. 下一阶段依赖

- ISSUE-01 的修复会改 `.timeline-info` / `.timeline-title` 的高度分配，**会改变**本轮记录的行内几何（行高仍 56，但标题高度会变）；届时 `timeline-autoqa.mjs` 的观测值需要重跑基线。
- 若采纳"刷新保留横向位置"的修复，需要新增一条断言：刷新后 `scrollLeft` 不变（当前是观察项）。
- U6-A/B/C 已被你判定 PASS，本轮未重复；后续任何样式改动都应重跑 `timeline-autoqa.mjs` 作为回归门禁。
