# Git 身份修复报告（GIT-IDENTITY-01）

执行时间：2026-11-20 05:47:46 CST
仓库：`https://github.com/RintoTan/artflow-desk-core`（Private）
分支：`master`

## 1. 修复前状态

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `master` / `6260deb` |
| 提交总数 | **220** |
| 分支 | 本地 `master` + `origin/master`，无其他分支 |
| 标签 | 0 |
| 工作区 | 17 项未提交改动（保留原样） |
| 远程 | `origin` = `https://github.com/RintoTan/artflow-desk-core.git` |

## 2. 修复前身份统计（全量 `git log --all`，非抽查）

| Author / Committer | 提交数 | GitHub 账户关联 | 分类 |
| --- | --- | --- | --- |
| `Rinto Tan <s***n@yeah.net>` | 186 | **RintoTan** | B（已正确） |
| `RintoTan <rinto@local>` | 26 | **UNLINKED**（无任何账户） | A（需修正） |
| `RINTO <rinto@users.noreply.github.com>` | 8 | **rinto**（错误账户） | A（需修正） |

- Author 与 Committer 完全一致的提交：220 / 220（无混搭）
- 合并提交：0；签名提交 / 签名标签：0
- 关联判定依据：GitHub Commits API 返回的 `author.login` 字段，而非显示名称

## 3. 修正范围

| 项 | 数量 |
| --- | --- |
| 错误关联到 `rinto` 账户的提交 | **8** |
| 邮箱未关联任何账户（`rinto@local`）的本人提交 | **26** |
| **合计修正** | **34** |
| 未改动（已正确关联 RintoTan） | 186 |

只改了 A 类 34 条的 Author 与 Committer（各 34 次）。186 条 B 类提交原样保留——它们的作者名显示为 `Rinto Tan`，但 GitHub 侧一直正确关联到 RintoTan 账户。

## 4. 目标身份与验证方式

- Git Name：`RintoTan`
- Git Email：GitHub 账户 RintoTan 上**已验证且已在用的**邮箱（报告中脱敏为 `s***n@yeah.net`）

验证方式：不是猜邮箱，也不是看提交显示名，而是取 GitHub Commits API 的 `author.login`——修复前 186 条已由该邮箱关联到 `RintoTan`，说明该邮箱确实属于该账户且已验证。因此沿用它，不引入新地址、也不改用 noreply（那会让 186 条已正确的提交一起变）。

## 5. 备份

```
/Users/rinto/Documents/ArtFlowDesk-Backups/Git-Identity-Rewrite-20261120-054529/
├── repo-copy/                              完整仓库副本（含 .git）
├── ArtFlowDesk-Before-Identity-Rewrite.bundle
├── refs.txt                                全部 refs 与 SHA
├── remote.txt                              远程地址
├── worktree-status.txt                     17 项未提交改动清单
├── identity-audit.tsv                      220 条完整身份审计
├── uncommitted.diff                        未提交改动内容
└── untracked/                              未跟踪文件副本
```

Bundle 校验：`git bundle verify` → **The bundle records a complete history.**（sha1，含 HEAD 6260deb）

## 6. 重写方法

1. 从 bundle 克隆到临时目录（`/tmp/rw.XXXXXX/r`）；
2. 写 mailmap，两条规则：

   ```
   RintoTan <s***n@yeah.net> RintoTan <rinto@local>
   RintoTan <s***n@yeah.net> RINTO <rinto@users.noreply.github.com>
   ```

3. `python3 -m git_filter_repo --mailmap … --force`（git-filter-repo，未使用 filter-branch）；
4. 在临时副本完成全部校验后，才 `git fetch` 回正式仓库并用 `git branch -f` 更换分支指针
   （没有用 `reset --hard`，17 项未提交改动原地保留，校验前后 `git status` 完全一致）。

## 7. 重写校验（临时副本）

| 校验项 | 结果 |
| --- | --- |
| 提交数量 | 220 → **220** |
| **Tree SHA 序列**（`git log --reverse --format=%T`） | `diff` **0 行**（逐提交一致） |
| 提交说明序列 | `diff` **0 行** |
| 提交时间 | 抽查一致（作者/提交时间未变） |
| 父子关系 | 线性历史逐条对应，无压缩、无重建 |
| 分支 / 标签 | `master` 保留，标签 0 → 0 |

旧 SHA → 新 SHA：34 条目标提交 SHA 变化（元数据属于 commit 对象，必然变化）；
其余 186 条 SHA 也因后代重写而变化，但**每条旧提交都能一一对应到新提交**，且 Tree 完全相同。
HEAD：`6260deb` → `28c204f`。

## 8. 本地配置

```
user.name  = RintoTan
user.email = s***n@yeah.net   （仅 --local，未动 global）
git var GIT_AUTHOR_IDENT   → RintoTan <…>
git var GIT_COMMITTER_IDENT → RintoTan <…>
```

## 9. 推送

```
git push --force-with-lease=refs/heads/master:6260debb… origin refs/heads/master:refs/heads/master
→ + 6260deb...28c204f master -> master (forced update)
```

未使用 `--force`、未使用 `--mirror`、未改动其他 refs、未删除远程分支或标签。

## 10. GitHub 侧复核（推送后重新拉取全部 220 条）

| email | GitHub 账户 | 条数 |
| --- | --- | --- |
| s***n@yeah.net | **RintoTan** | **220 / 220** |

- 已无 `rinto` 账户关联的提交；
- 已无 UNLINKED 提交；
- 仓库仍为 `private=true`，默认分支 `master`。

> 贡献者统计页面可能滞后数分钟到数小时，属正常缓存；判断依据应看提交详情页的 Author 关联。

## 11. 未解决 / 风险

| 项 | 说明 |
| --- | --- |
| 186 条提交的显示名 | 仍是 `Rinto Tan`（带空格）。按"B 类不变"原则未改；如要统一为 `RintoTan`，需再做一次全量重写 |
| 已克隆的旧副本 | 任何在重写前克隆过本仓库的本地副本，其历史与新远程不一致，需重新克隆 |
| GitHub 缓存 | 贡献者图与部分列表页可能短期显示旧数据 |
| 备份体积 | `repo-copy/` 含 node_modules 与 target，约 12 GB；确认无误后可自行删除 |

## 12. 如何恢复原始仓库

```bash
# 方案 A：从 bundle 恢复（推荐）
git clone "/Users/rinto/Documents/ArtFlowDesk-Backups/Git-Identity-Rewrite-20261120-054529/ArtFlowDesk-Before-Identity-Rewrite.bundle" restored
cd restored && git remote add origin https://github.com/RintoTan/artflow-desk-core.git

# 方案 B：直接使用目录副本
cp -R "/Users/rinto/Documents/ArtFlowDesk-Backups/Git-Identity-Rewrite-20261120-054529/repo-copy" ~/ArtFlowDesk-restored

# 若需把远程也退回旧历史（谨慎）：
git push --force-with-lease=refs/heads/master:28c204f origin 6260debb:refs/heads/master
```
