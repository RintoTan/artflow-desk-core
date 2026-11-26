import { useEffect, useState } from "react";

import { api, describeError, type EnvironmentStatus } from "../bridge/commands";
import { buildId, buildKindLabel } from "../lib/buildInfo";

/** 尚未确认的信息一律显式标注，不编造姓名、地址、许可证或年份。 */
const TBD = "待补充";


type Module = {
  title: string;
  icon: string;
  summary: string;
  points: string[];
};

/** 模块简介：版本弹窗与关于页共用同一份文案，不各写一份。 */
export const ABOUT_MODULES: Module[] = [
  {
    title: "工作台",
    icon: "dashboard",
    summary: "打开就能看到今天该做什么。",
    points: [
      "汇总进行中、排队中与制作中的订单数量",
      "提示三日内到期、今天到期与已逾期的交付",
      "展示本月完成次数与跨订单排期时间线",
    ],
  },
  {
    title: "订单信息",
    icon: "orders",
    summary: "委托从新建到交付的全过程都在这里。",
    points: [
      "卡片、看板、表格三种视图，可按流程与阶段筛选",
      "新建、编辑、复制与取消订单，支持队列排序",
      "推进制作阶段、返工、跳级，并保留完整制作历史",
      "参考图片与附件随订单一起管理",
    ],
  },
  {
    title: "客户管理",
    icon: "clients",
    summary: "把甲方资料集中管理，下单时直接选。",
    points: [
      "维护客户名称、联系方式与备注",
      "用标签给客户分类",
      "订单可直接关联客户，详情里能看到该客户的全部委托",
    ],
  },
  {
    title: "流程模板",
    icon: "templates",
    summary: "不同委托类型可以走不同的制作流程。",
    points: [
      "创建与编辑制作阶段模板（如草稿、线稿、上色、细化、完稿）",
      "新订单按模板生成自己的阶段列表",
      "改模板只影响之后创建的订单，不动已有订单的历史",
    ],
  },
  {
    title: "日历排单",
    icon: "calendar",
    summary: "按日期看排期，拖动即可改期。",
    points: [
      "月视图与周视图，可连续向前后浏览",
      "订单按计划开始与计划交付日期落在日期格上",
      "拖动订单条或选日期即可改期，改期会写入排期历史",
    ],
  },
  {
    title: "数据统计",
    icon: "stats",
    summary: "回看完成了多少、钱来自哪里。",
    points: [
      "按月份查看完成情况与收入分布",
      "客户、模板维度的明细与下钻",
      "可按当前筛选导出订单表格（CSV）",
    ],
  },
  {
    title: "通用设置",
    icon: "settings",
    summary: "外观、时区、备份与维护都在通用设置里。",
    points: [
      "主题模式、强调色与应用图标",
      "工作时区（影响日期与时间的解释方式）",
      "数据备份与恢复、附件维护",
    ],
  },
];

type ShortcutRow = { keys: string; action: string; scope: string };
type Guide = { title: string; table?: ShortcutRow[]; body: string[] };

const GUIDES: Guide[] = [
  {
    title: "快速开始",
    body: [
      "先在「通用设置 → 工作时区」确认时区，日期和「今天」都按它计算。",
      "到「流程模板」按自己的习惯调整制作阶段；不调整也能直接用默认流程。",
      "到「订单信息」新建委托，填标题、客户与计划交付日期。",
      "打开订单详情，点「开始制作」，之后每次完成一个阶段就点「推进阶段…」。",
      "日常用「工作台」看今天要做什么，用「日历排单」看未来几周的排期。",
    ],
  },
  {
    title: "快捷键与键盘操作",
    table: [
      { keys: "⌘ N", action: "新建", scope: "订单、客户、流程模板" },
      { keys: "⌘ S", action: "保存当前修改", scope: "订单详情、客户、流程模板、通用设置" },
      { keys: "⌘ F", action: "聚焦搜索框", scope: "订单列表" },
      { keys: "↑ / ↓", action: "移动键盘光标", scope: "订单列表" },
      { keys: "Enter", action: "打开光标所在订单", scope: "订单列表" },
      { keys: "Esc", action: "关闭最上层弹窗", scope: "全局（含看板/表格详情）" },
    ],
    body: [
      "↑ / ↓ 只移动键盘光标，不会改变订单在队列里的顺序。",
      "按 Enter 才会打开当前光标所在的订单。",
      "⌘ S 只在存在未保存修改时执行保存；没有改动时不会写入任何内容。",
      "Esc 按弹窗层级处理，只关最上面那一层；看板与表格视图下会关闭右侧详情，若详情里还有未保存的修改，会提示先保存或撤销。",
      "光标在输入框、文本域或下拉框里时，方向键与 Enter 只作用于输入内容，不会触发订单列表的光标移动。",
      "当前展示的是 macOS 键位；其他平台的差异尚未验证。",
    ],
  },
  {
    title: "订单信息",
    body: [
      "新建：订单页右上角「新建」，标题必填，客户与日期可以稍后补。",
      "编辑：订单详情左侧「资料」区，改完点「保存资料」。",
      "推进：详情顶部「推进阶段…」，一次只推进一级；要跨阶段用「跳级」并确认。",
      "返工：同一个入口里的「返工」，可以退回任意更早阶段，历史会保留。",
      "完成 / 取消：都在顶部按钮区，完成后仍可在制作历史里回看全过程。",
      "制作历史：详情右侧「制作历史」，包含推进、返工、跳级、改期与状态变化。",
    ],
  },
  {
    title: "制作流程",
    body: [
      "流程模板是「模板」，订单里的是「副本」：下单时按模板生成，之后互不影响。",
      "正常推进按顺序走一级；返工可以退回更早阶段重做。",
      "跳级用于「中间阶段不需要做」的情况，会记录被跳过的阶段，但不会把它们算作已完成。",
      "阶段变化都会写进制作历史，历史不会被后来的操作改写。",
    ],
  },
  {
    title: "日历与排期",
    body: [
      "月视图看整月，周视图看细节；两者都能连续向前后滚动。",
      "日期格上的订单按「计划开始」到「计划交付」绘制，颜色只表示排期状态。",
      "拖动订单条到别的日期即可改期，也可以点日期后再选订单。",
      "计划日期是人为排期，与实际完成时间无关；实际时间记录在制作历史里。",
    ],
  },
  {
    title: "附件管理",
    body: [
      "在订单详情的「参考图片」区点「添加图片」，或把图片直接拖进这个区域。",
      "支持多选；部分文件失败时会逐个说明原因，成功的仍然会导入。",
      "原图保存在应用数据目录，缩略图可随时重建；点缩略图可看原图。",
      "设置里的「附件维护」可以查看隔离文件和导入记录：隔离文件是被挪出来待人工比对的，不会自动删除。",
      "参考图片只属于当前订单，不会自动进入任何作品集。",
    ],
  },
  {
    title: "数据备份与恢复",
    body: [
      "「设置 → 数据备份」里点「导出备份…」，自己选保存位置，得到一个 .zip 备份包。",
      "目前是手动导出，没有自动定时备份；可以设置提醒周期，到期在通用设置里提示。",
      "恢复时先选备份包，页面会显示来源时间、版本与内容摘要，确认后才开始。",
      "恢复前会自动把当前数据再备份一份，恢复全程在新数据代际里完成，失败不影响现有数据。",
      "备份包没有加密，里面有客户与订单信息，请妥善保存。",
    ],
  },
  {
    title: "数据环境",
    body: [
      "正式环境保存真实业务数据；测试环境（QA）用于在发布前验证改动，数据与正式环境完全隔离，两边不会互相影响。",
      "「数据代际」标识当前实际使用的那份数据；升级或恢复会生成新的代际，旧代际保留。",
      "「数据库结构版本」表示数据的组织方式，升级由程序自动完成，不需要手工干预。",
      "工作时区决定日期与时间如何解释，换机器后建议先确认一次。",
    ],
  },
];

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value" title={hint ?? value}>
        {value}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="about-fact">
      <span className="about-fact-label">{label}</span>
      <span className="about-fact-value">{value}</span>
    </div>
  );
}

export default function AboutPage() {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e) => setError(describeError(e)));
  }, []);

  return (
    <div className="about-page">
      <section className="panel about-hero">
        <header className="panel-head">
          <div>
            <h2>关于软件</h2>
            <p className="muted">版本、归属、功能说明与使用指引</p>
          </div>
          {status?.qaMode && (
            <span className="badge badge-warn" data-testid="qa-badge">
              QA 测试环境
            </span>
          )}
        </header>

        <p className="about-intro">
          ArtFlow Desk Core 是一款面向独立画师的本地优先桌面委托管理工具，帮助画师管理委托订单、客户资料、
          制作流程、交付排期和历史记录。
        </p>
        <p className="about-intro">
          软件以本地数据存储为基础，提供订单管理、制作进度追踪、附件管理、数据备份与恢复等功能，
          不依赖云同步，也不需要客户注册在线账号。
        </p>
        <p className="muted about-note">
          Web 端 ArtFlow Desk 与桌面端 ArtFlow Desk Core 属于同一产品体系下的两个独立产品：
          工程、数据与发布彼此独立，不共享数据库。本页描述的是桌面端 ArtFlow Desk Core。
        </p>
      </section>

      <section className="panel" aria-labelledby="about-version-title">
        <header className="panel-head compact">
          <h2 id="about-version-title">版本信息</h2>
          <span className="muted">版本号由应用自身提供，构建号在打包时注入，两者都不在界面里另写一份</span>
        </header>
        <div className="about-facts">
          <Fact label="应用版本" value={status ? `v${status.appVersion}` : "读取中…"} />
          <Fact label="构建号" value={buildId()} />
          <Fact
            label="运行构建"
            value={
              status
                ? buildKindLabel(
                    status.qaMode
                      ? `QA 测试构建（${status.qaScenario === "clean" ? "空白场景" : "预置场景"}）`
                      : "正式构建",
                  )
                : "读取中…"
            }
          />
          <Fact
            label="数据库结构版本"
            value={status ? `v${status.schemaVersion}` : "读取中…"}
          />
          <Fact
            label="数据代际"
            value={status ? status.generation : "读取中…"}
          />
        </div>
      </section>

      <section className="panel" aria-labelledby="about-owner-title">
        <header className="panel-head compact">
          <h2 id="about-owner-title">开发与归属</h2>
          <span className="muted">未确认的信息标注为「{TBD}」</span>
        </header>
        <div className="about-facts">
          <Fact label="开发者" value="RINTO" />
          <Fact label="维护者" value="RINTO" />
          <Fact label="所属产品体系" value="ArtFlow Desk" />
          <Fact label="版权归属" value="RINTO" />
          <Fact label="许可证" value="未设置公开许可证" />
          <Fact label="官方网站 / 联系方式" value={TBD} />
        </div>
        <p className="muted about-note">
          桌面端 ArtFlow Desk Core 与 Web 端 ArtFlow Desk 同属 ArtFlow Desk 产品体系，
          但代码、数据与发布相互独立。
        </p>
      </section>

      <section className="panel" aria-labelledby="about-modules-title">
        <header className="panel-head compact">
          <h2 id="about-modules-title">功能模块</h2>
          <span className="muted">只介绍当前版本已经可用的功能</span>
        </header>
        <div className="about-modules">
          {ABOUT_MODULES.map((module) => (
            <article className="about-module" key={module.title}>
              <h3>{module.title}</h3>
              <p className="about-module-summary">{module.summary}</p>
              <ul>
                {module.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="about-guide-title">
        <header className="panel-head compact">
          <h2 id="about-guide-title">使用指引</h2>
          <span className="muted">点开对应主题查看步骤</span>
        </header>
        <div className="about-guides">
          {GUIDES.map((guide, index) => (
            <details className="about-guide" key={guide.title} open={index === 0}>
              <summary>{guide.title}</summary>
              {guide.table && (
                <table className="table about-shortcuts">
                  <thead>
                    <tr>
                      <th>快捷键</th>
                      <th>功能</th>
                      <th>适用范围</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guide.table.map((row) => (
                      <tr key={row.keys}>
                        <td className="mono">{row.keys}</td>
                        <td>{row.action}</td>
                        <td className="muted">{row.scope}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <ul>
                {guide.body.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="about-env-title">
        <header className="panel-head">
          <div>
            <h2 id="about-env-title">数据环境</h2>
            <p className="muted">
              {error
                ? "无法读取数据环境"
                : status
                  ? status.firstRun
                    ? "本次是首次启动，已初始化正式数据库。"
                    : "已连接到既有数据环境。"
                  : "正在读取数据环境…"}
            </p>
          </div>
          {status && (
            <span
              className={`badge ${status.integrity === "ok" ? "badge-ok" : "badge-warn"}`}
            >
              完整性 {status.integrity === "ok" ? "正常" : status.integrity}
            </span>
          )}
        </header>

        {error ? (
          <>
            <p className="mono about-error">{error}</p>
            <p className="muted">
              应用已停止写入。请检查数据目录是否存在、是否被其他进程占用，或从备份恢复。
            </p>
          </>
        ) : !status ? (
          <p className="muted">正在读取数据环境…</p>
        ) : (
          <>
            {status.qaMode && (
              <p className="about-qa-note" role="status">
                QA 测试环境：数据目录与正式台账完全隔离，这里的所有操作都不会影响正式数据。
              </p>
            )}

            <div className="grid">
              <Row
                label="运行模式"
                value={
                  status.qaMode
                    ? `ArtFlow Desk Core — QA 测试环境 · ${
                        status.qaScenario === "clean" ? "空白场景" : "预置场景"
                      }（与正式数据隔离）`
                    : "正式应用"
                }
              />
              <Row label="应用版本" value={status.appVersion} />
              <Row label="数据库结构" value={`v${status.schemaVersion}`} />
              <Row label="数据代际" value={status.generation} hint={status.generation} />
              <Row label="SQLite" value={status.sqliteVersion} />
              <Row label="日志模式" value={status.journalMode} />
              <Row label="写入锁" value={status.lockHeld ? "本进程持有" : "未持有"} />
              <Row label="工作时区" value={status.workingTimezone} />
              <Row label="系统时区" value={status.systemTimezone} />
            </div>

            <div className="path-block">
              <span className="row-label">数据目录</span>
              <code>{status.rootPath}</code>
            </div>

            <h3 className="about-sub">当前数据</h3>
            <p className="muted">只统计真实存在的记录，不包含任何演示数据。</p>
            <div className="stat-row stat-row-metrics">
              {[
                { label: "订单", value: status.orders },
                { label: "客户", value: status.clients },
                { label: "流程模板", value: status.templates },
                { label: "附件", value: status.attachments },
                { label: "待清理", value: status.pendingCleanup },
              ].map((item) => (
                <div className="stat" key={item.label}>
                  <span className="stat-value">{item.value}</span>
                  <span className="stat-label">{item.label}</span>
                </div>
              ))}
            </div>

            <h3 className="about-sub">编号高水位</h3>
            <p className="muted">
              年度编号记录独立存放，恢复旧备份不会降低；编号与队列位置无关。
            </p>
            {status.highWater.length === 0 ? (
              <p className="muted">尚无已分配的订单编号。</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>年份</th>
                    <th>已保留的最大序号</th>
                    <th>下一编号</th>
                  </tr>
                </thead>
                <tbody>
                  {status.highWater.map((item) => (
                    <tr key={item.year}>
                      <td>{item.year}</td>
                      <td className="mono">{item.lastAllocated}</td>
                      <td className="mono">
                        AF-{item.year}-{String(item.lastAllocated + 1).padStart(4, "0")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
