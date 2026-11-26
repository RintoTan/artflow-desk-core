# ArtFlow Desk Core v0.1.2 最终审计

审计基线：`master = 4a31eb3`，`tag v0.1.2` 指向同一提交，工作区干净。
审计时间：2026-11-26。本文只写有证据的结论，未跑过的一律标「未验证」。

---

## 一、发布状态

| 项 | 值 | 证据 |
| --- | --- | --- |
| master | `4a31eb3` | `git rev-parse --short HEAD` |
| Tag | `v0.1.2` → `4a31eb3` | `git rev-parse --short 'v0.1.2^{commit}'` |
| Release | https://github.com/RintoTan/artflow-desk-core/releases/tag/v0.1.2 | `gh release view` |
| 工作区 | 干净 | `git status --porcelain` 无输出 |

### 发布资产（远端字节数与本地文件逐一相等）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `ArtFlow-Desk-Core-0.1.2-macos-arm64.zip` | 6,840,176 | `87b8bd58423b831b05fcc75de9999510dc97189848d2e98cd4a7858ab7c7e5d6` |
| `ArtFlowDesk-Core-Windows-v0.1.2-Production-Setup.exe` | 4,295,476 | `82fbd0e0fccb7df9ccc43252fe839f30f467ed610cb756c1b3d3892c2bbcffca` |
| `ArtFlowDesk-Core-Windows-v0.1.2-Production-Portable.exe` | 17,362,944 | `a590e081d92a42c143096ccbbb8c369ac11fc6617c97fcd2ab6544fc5597f716` |
| `SHA256SUMS.txt` | 347 | 三件产物 `shasum -a 256 -c` 通过 |

macOS 包内 `Contents/MacOS` 只有 `artflow-minidesk`（22,457,920 B 级别），无 `minidesk-probe` / `attachments-probe` / `qa_seed`；`Info.plist` 为 `dev.artflow.minidesk` / `0.1.2` / 最低 macOS 13.0；签名 `adhoc, linker-signed`，`TeamIdentifier=not set`。

---

## 二、功能完成清单（01–05）

| 工作包 | 内容 | 状态 |
| --- | --- | --- |
| 01 新建入口 + 委托类型 | 入口放大；七种预设 + 自由输入；标题按「客户 · 类型」生成且可手改；编辑可改类型 | 完成 |
| 02 订单缩略图 | 批量封面查询；成品 → 参考图 → 占位；卡片/看板显示，表格不显示 | 完成 |
| 03 客户参考图 | v14 独立表；上传/拖拽、缩略图、看原图、删除确认；随备份走；客户清除前入队 | 完成 |
| 04 订单排序 | 四种展示排序 + 置顶分组；非手动禁用重排；看板回到平铺（默认全部流程） | 完成 |
| 05 版本信息 | 左下角常驻入口 + VersionDialog；渠道/发布标记/版本三者分列 | 完成 |

发布后补修三处（已随本次重建进入 0.1.2）：客户搜索框补 `list-search`；客户页财务概览改两列网格；看板默认由「默认模板」改为「全部流程」。

---

## 三、数据与迁移

| 审计项 | 结论 | 依据 |
| --- | --- | --- |
| 当前 schema | v14 | `APP_SCHEMA_VERSION`；运行库 `user_version` |
| v13 → v14 迁移链 | 通过 | 构造库单测 + 真实 QA 数据根实机迁移 |
| 真实数据根升级 | 通过 | 代际 `gen-3431bc…` → `gen-3b050e…`，`user_version` 13→14，行数 151/53/18/167/3 前后一致，`client_attachments` 建表成功 |
| 客户参考图备份 → 恢复闭环 | 通过（自动化） | 导入 2 张（PNG+JPEG）→ 备份 → 恢复到新根 → 逐字节比对 + 缩略图成套 |
| 恢复后图片在界面显示 | **未验证** | 需要在实机打开恢复后的库查看 |
| 订单编号高水位 | 通过（自动化） | 恢复时 `highwater.merge`，有既有用例覆盖 |
| 清理任务与永久删除一致 | 通过（自动化） | 客户清除前 `enqueue_all_for_client`，行随 CASCADE 消失而文件有队列兜底 |
| QA / Production 隔离 | 配置层隔离 | identifier 与数据根分离；**未做跨根串数据的实机核对** |

---

## 四、测试（本轮实跑 vs 历史基线）

| 项目 | 本轮结果 | 说明 |
| --- | --- | --- |
| 前端 `npx vitest run` | **97 文件 / 955 passed** | 本轮实跑 |
| `npx tsc --noEmit` | 通过 | 本轮实跑 |
| `npm run build` | 通过 | 本轮实跑 |
| macOS `tauri build --bundles app` | 成功，22.11 MiB | 本轮实跑 |
| Rust `cargo test --features devtools` | **723 passed**（历史基线） | **本轮未重跑**，不计作本轮复验 |
| Windows CI | Production / QA 双任务 success | Runner 上两轮启停退出码 0，11 项检查 0 失败 |

---

## 五、本轮修掉的缺陷（含仅 Windows 暴露的）

1. `activate.rs`：`CreateFileW` 的 `htemplatefile` 传 `*const null`，而 `HANDLE` 是 `*mut c_void` → E0308，仅 Windows 编译暴露。
2. 参考图路径断言写死正斜杠 → Windows 反斜杠导致假红，改为归一化。
3. 两条 reset 故障注入用例依赖 unix 只读目录 → Windows 上 `ignore` 并注明原因。
4. 冒烟脚本按 PID 追溯子进程，主进程退出后 PID 复用把 `csrss/winlogon/fontdrvhost/dwm` 误判为残留 → 改为只认 `ArtFlowDesk*` 与 `msedgewebview2*`。
5. 客户搜索输入漏 `className="list-search"`，走浏览器原生外观。
6. 客户页 `dl.stat-row` 的 `flex + wrap` 把六个指标挤成不等宽三列，长注解与数字混排 → 改两列网格。
7. 看板默认选中 `isDefault` 模板（该模板 0 单），开局一屏空白 → 默认「全部流程」。

---

## 六、未完成 / 未验证（明确列出）

| 项 | 状态 |
| --- | --- |
| 截图交付 | **未完成**。采集脚本存在窗口串扰（前一实例未退干净会抓到旧窗口），错误图片已全部撤下，`docs/assets/screenshots/0.1.2/` 为空 |
| macOS 正式包实机启动 | **未验证**（启动会迁移生产数据根，留给产品负责人执行） |
| macOS 干净机器首次打开 | **未验证**（本机 Gatekeeper 评估被关闭，`spctl accepted` 不具代表性） |
| Windows 真机安装与人工验收 | **未验证**（仅 CI Runner 冒烟） |
| 恢复备份后界面内看图 | **未验证** |
| 880×500 / 深色 下最终观感 | **未验证**（无新一轮实机截图） |
| 关键操作实机回归（建单、推进、回收站、主题、自启动等） | **未执行** |

---

## 七、已知限制

1. macOS adhoc 签名、未公证；首次打开需右键「打开」。
2. Windows 无代码签名。
3. 看板只按「一个流程模板 + 阶段筛选」展示，不提供多模板并排分组。
4. 列表缩略图不支持在列表内直接放大原图（由订单详情的附件查看器承担）。
5. 存储用量统计未实现（设计已冻结，无命令与界面）。
6. 结构校验失败时无救援模式（P2，此前裁定不做）。
7. README 展示图仍为 0.1.2 之前的界面。

---

## 八、冻结功能（本版明确不做）

1. 时间线同月堆叠 4 行 + 超出合并 `+N`
2. 登录后默认页面设置
3. 自动定时备份
4. 备份包加密
5. 旧代际清理入口

设置页「接单平台与手续费」UI 重做未做（纯版式，功能已全部接通）。

---

## 九、审计判断

- **可以结项**：代码、测试、双平台产物、Tag/Release/master 一致性均有证据。
- **但发布不等于验收**：macOS 正式包从未启动过，Windows 从未在实体机器安装过，截图未交付。这三项必须在后续基线中继续挂着，不能被「已发布」覆盖。
