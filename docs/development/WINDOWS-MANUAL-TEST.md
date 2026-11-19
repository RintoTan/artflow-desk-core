# ArtFlow Desk Core｜Windows 实机测试手册

> **当前状态：自动化冒烟已在 GitHub Actions 的 `windows-latest` 上执行；Windows 真机（物理机/虚拟机）手动项全部 NOT RUN。**
> 自动化只能证明「进程能起、窗口能建、关闭后进程能退、二次启动不受残留影响」，
> 不能证明安装、卸载、DPI、中文路径、SmartScreen、真实显卡驱动下的渲染。
> 两类结果必须分开记录，不要把 CI 的 PASS 当成实机 PASS。

---

## 1. 本次产物

| 项 | 值 |
| --- | --- |
| 应用版本 | 0.1.0（本次未改动） |
| 构建来源 | GitHub Actions `windows-latest`，`x86_64-pc-windows-msvc` |
| 正式版 Portable | `ArtFlowDesk-Core-Windows-v0.1.0-Production-Portable.exe` |
| 正式版 Setup | `ArtFlowDesk-Core-Windows-v0.1.0-Production-Setup.exe` |
| QA 版 Portable | `ArtFlowDesk-Core-Windows-v0.1.0-QA-Portable.exe` |
| QA 版 Setup | `ArtFlowDesk-Core-Windows-v0.1.0-QA-Setup.exe` |
| 校验和 | 同目录 `SHA256SUMS.txt` |
| 签名状态 | 未签名（首次运行会出现 SmartScreen 提示，属预期） |
| 目标平台 | Windows 10 1809 及以上 / Windows 11，**x64** |

安装包内的主程序文件名都是 `artflow-minidesk.exe`；**Portable 与 Setup 的区别是「要不要安装」，
Production 与 QA 的区别是「数据目录与窗口标题」**。四者不要混用。

## 2. 下载与完整性校验

1. 从 GitHub Release 下载四个文件与 `SHA256SUMS.txt`。
2. 打开 PowerShell，进入下载目录：

   ```powershell
   Get-FileHash .\*.exe -Algorithm SHA256 | Format-Table -AutoSize
   ```

3. 与 `SHA256SUMS.txt` 逐行比对。**不一致就不要运行**，重新下载。

## 3. 系统要求与 WebView2

- Windows 10（1809 及以上）或 Windows 11，64 位。
- 约 300 MB 可用空间（应用本体 + 数据）。
- 需要 Microsoft Edge WebView2 Runtime。Windows 11 与已更新的 Windows 10 默认自带。
- 检查方式：`设置 → 应用 → 已安装的应用` 中搜索 `WebView2`；或直接运行，若弹出「需要 WebView2」按提示安装。

## 4. 自动化冒烟测试（CI 结果，非实机）

由 `scripts/windows/smoke-test.ps1` 在 Windows Runner 上执行，每个版本跑 2 轮「启动 → 等窗口 → 关闭 → 等退出」。

| ID | 检查项 | 结果来源 |
| --- | --- | --- |
| A01 | EXE 能启动，1.5 秒内未异常退出 | CI |
| A02 | 60 秒内出现主窗口（`MainWindowHandle != 0`） | CI |
| A03 | 关闭窗口后 25 秒内进程退出（退出码 0） | CI |
| A04 | 主进程退出后 15 秒内子进程收敛（WebView2 渲染进程异步退出） | CI |
| A05 | 二次启动仍能建窗口并再次正常退出（验证数据目录锁已释放） | CI |
| A06 | 运行后创建了对应数据目录 | CI |
| A07 | QA 运行不创建正式目录；正式运行不创建 QA 目录 | CI |
| A08 | QA `clean` 与 `seeded` 场景各自独立代际目录 | CI |
| A09 | 窗口内容渲染正确（不是白屏） | **NOT RUN（Runner 无法可靠判定内容）** |

具体结果见当次 Actions 运行的 `ArtFlowDesk-Windows-Production` / `-QA` artifact 内 `smoke-*.log`。

---

## 5. 手动测试清单（全部 NOT RUN，需在 Windows 真机执行）

结果列填写：`PASS` / `FAIL` / `PARTIAL`；失败时附上 `%APPDATA%\<identifier>\logs\app.log` 末尾 20 行。

### A. 生命周期（本次重点）

| ID | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| T01 | 双击 QA Portable，等待窗口出现 | 5 秒内出现「ArtFlow Desk Core — QA 测试环境」窗口 | NOT RUN |
| T02 | 点窗口右上角 × | 窗口关闭，任务管理器中该进程在 2 秒内消失 | NOT RUN |
| T03 | 再次双击同一个 EXE | 能重新打开窗口，不出现「已在运行」提示 | NOT RUN |
| T04 | 连续执行「打开 → 关闭」10 次 | 每次都能打开，任务管理器无累积进程 | NOT RUN |
| T05 | 打开后保持 30 分钟不动，再关闭 | 仍能正常关闭且进程退出 | NOT RUN |
| T06 | 打开状态下，直接点任务栏关闭 / Alt+F4 | 与点 × 一致：关窗并退出进程 | NOT RUN |
| T07 | 打开状态下，任务管理器结束该进程，再启动 | 能正常启动（锁由系统释放，不需要手工删文件） | NOT RUN |
| T08 | 打开状态下再双击一次 EXE | 应给出「已有实例在运行」的提示，而不是静默无反应 | NOT RUN |
| T09 | 重启 Windows 后直接启动 | 能正常打开，不需要清理任何残留 | NOT RUN |
| T10 | 打开后切换用户/锁屏再回来 | 窗口仍在，可正常操作与关闭 | NOT RUN |
| T11 | 在订单编辑中留有未保存改动时点 × | 弹出关闭确认；选「取消」窗口保留；选「保存并关闭」后进程退出 | NOT RUN |
| T12 | 同上，选「放弃修改」 | 窗口关闭且进程退出 | NOT RUN |

### B. 安装、卸载与系统提示

| ID | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| T13 | 运行 Production Setup | NSIS 安装向导正常，默认安装到用户目录 | NOT RUN |
| T14 | 运行 QA Setup | 向导标题/程序名含 QA，与正式版可同时安装 | NOT RUN |
| T15 | 从开始菜单启动正式版 | 窗口标题为「ArtFlow Desk Core」 | NOT RUN |
| T16 | 首次运行出现 SmartScreen | 点「更多信息 → 仍要运行」可继续 | NOT RUN |
| T17 | 设置 → 应用 中卸载 QA 版 | 卸载成功，程序文件移除 | NOT RUN |
| T18 | 卸载后检查 `%APPDATA%\dev.artflow.minidesk.qa` | 数据仍在（卸载不删用户数据） | NOT RUN |
| T19 | 重新安装 QA 版并启动 | 之前的数据仍在，无需重新配置 | NOT RUN |

### C. 数据目录与隔离

| ID | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| T20 | 正式版首次启动后查看 `%APPDATA%\dev.artflow.minidesk` | 存在 `generations/`、`state/`、`logs/` | NOT RUN |
| T21 | QA Clean 启动后查看 `%APPDATA%\dev.artflow.minidesk.qa\clean` | 存在 `.qa-root` 标记，订单为 0 | NOT RUN |
| T22 | QA Seeded 启动 | 另一目录 `\seeded`，与 clean 数据互不影响 | NOT RUN |
| T23 | 正式版与 QA 版同时运行 | 两个窗口都在，互不抢占数据目录 | NOT RUN |
| T24 | 两个版本交替启动关闭 | 不出现「数据目录被占用」错误 | NOT RUN |
| T25 | 打开 `%APPDATA%\<identifier>\logs\app.log`（正式与 QA 各一份，位于标识目录而非场景目录） | 记录 startup / window / exit，无客户隐私内容 | NOT RUN |

### D. 功能回归（Windows 实机）

| ID | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| T26 | 新建客户与订单，填写计划开始/交付日期 | 保存成功，列表出现该订单 | NOT RUN |
| T27 | 订单三视图切换（卡片/看板/表格） | 布局正常，无横向溢出 | NOT RUN |
| T28 | 推进阶段、返工、跳级 | 状态与历史记录正确 | NOT RUN |
| T29 | 日历月/周视图，拖动订单改期 | 日期更新并写入改期历史 | NOT RUN |
| T30 | 导入参考图（多选 + 拖拽） | 缩略图生成，预览正常 | NOT RUN |
| T31 | 中文路径下导入附件（如 `C:\用户\测试\图片\`） | 导入成功，重启后仍能预览 | NOT RUN |
| T32 | 创建备份 ZIP | 生成成功，`SHA256SUMS` 校验通过 | NOT RUN |
| T33 | 从备份恢复 | 预览校验 → 恢复完成 → 重启后数据为新备份内容 | NOT RUN |
| T34 | 统计页导出 CSV | 文件可被 Excel 打开，中文不乱码 | NOT RUN |
| T35 | 125% / 150% / 200% 缩放 | 界面不重叠、不裁切 | NOT RUN |
| T36 | 切换浅色/深色主题 | 立即生效，重启后保持 | NOT RUN |
| T37 | 快捷键 Ctrl+N / Ctrl+F 等 | 与 macOS ⌘ 版本行为一致 | NOT RUN |

### E. 异常与诊断

| ID | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| T38 | 断网后启动 Portable（WebView2 已装） | 正常打开（不依赖网络） | NOT RUN |
| T39 | 手动把数据目录设为只读后启动 | 弹出明确错误对话框，进程退出，不残留 | NOT RUN |
| T40 | 打开 `logs\app.log` 并人为触发一次关闭 | 能看到 `exit requested ... block=false` 与 `process exiting` | NOT RUN |

---

## 6. 结果回收

- 把每项结果填进上表，失败的附日志尾部。
- 若出现「窗口关了但任务管理器还有进程」，请记录：进程名、PID、`logs\app.log` 全文、是否有 `block=true` 行。
- 所有结论以实机结果为准；CI 的 PASS 不等于实机 PASS。
