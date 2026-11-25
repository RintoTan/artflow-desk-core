import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "../bridge/commands";

let status: EnvironmentStatus;
let statusError: Error | null = null;

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => {
        if (statusError) throw statusError;
        return status;
      },
    },
  };
});

const { default: AboutPage } = await import("./AboutPage");

function baseStatus(patch: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-abc123def456",
    schemaVersion: 7,
    upgradedFrom: null,
    rootPath: "/Users/test/Library/Application Support/dev.artflow.minidesk.qa/seeded",
    qaMode: true,
    qaScenario: "seeded",
    sqliteVersion: "3.50.4",
    journalMode: "wal",
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    lockHeld: true,
    orders: 14,
    clients: 3,
    templates: 3,
    attachments: 7,
    pendingCleanup: 0,
    highWater: [{ year: 2026, lastAllocated: 14 }],
    integrity: "ok",
    ...patch,
  };
}

beforeEach(() => {
  statusError = null;
  status = baseStatus();
  // 构建身份用全局常量注入；用例之间必须互相隔离，否则「没注入」的用例会拿到上一条的值。
  vi.unstubAllGlobals();
});

describe("关于软件页面", () => {
  it("展示软件定位，并明确桌面端与 Web 端是独立产品", async () => {
    render(<AboutPage />);
    expect(await screen.findByRole("heading", { name: "关于软件" })).toBeTruthy();
    expect(screen.getByText(/面向独立画师的本地优先桌面委托管理工具/)).toBeTruthy();
    expect(screen.getByText(/不依赖云同步/)).toBeTruthy();
    expect(screen.getByText(/工程、数据与发布彼此独立，不共享数据库/)).toBeTruthy();
  });

  it("版本号来自后端状态，不在页面里写死", async () => {
    status = baseStatus({ appVersion: "9.9.9" });
    render(<AboutPage />);
    expect(await screen.findByText("v9.9.9")).toBeTruthy();
    expect(screen.queryByText("v0.1.0")).toBeNull();
  });

  it("构建号在正式环境也显示，取的是构建注入值", async () => {
    vi.stubGlobal("__BUILD_ID__", "b17a430");
    status = baseStatus({ qaMode: false, qaScenario: null });
    render(<AboutPage />);
    const version = await screen.findByRole("region", { name: "版本信息" });
    expect(within(version).getByText("b17a430")).toBeTruthy();
  });

  it("脏工作区的构建号带 -dirty，原样显示不当作另一个版本", async () => {
    vi.stubGlobal("__BUILD_ID__", "b17a430-dirty");
    render(<AboutPage />);
    const version = await screen.findByRole("region", { name: "版本信息" });
    expect(within(version).getByText("b17a430-dirty")).toBeTruthy();
    expect(screen.queryByText("v0.1.2")).toBeNull(); // 应用版本来自后端，不由构建号推出
  });

  it("拿不到 Git 信息时显示 unknown，不猜也不留空", async () => {
    delete (globalThis as { __BUILD_ID__?: string }).__BUILD_ID__;
    render(<AboutPage />);
    const version = await screen.findByRole("region", { name: "版本信息" });
    expect(within(version).getByText("unknown")).toBeTruthy();
  });

  it("没有发布标记时不显示 Demo", async () => {
    vi.stubGlobal("__RELEASE_LABEL__", "");
    render(<AboutPage />);
    const version = await screen.findByRole("region", { name: "版本信息" });
    expect(within(version).queryByText(/Demo/)).toBeNull();
  });

  it("发布标记与应用版本、运行环境三者独立显示", async () => {
    vi.stubGlobal("__BUILD_ID__", "b17a430");
    vi.stubGlobal("__RELEASE_LABEL__", "v0.1.2-demo.1");
    status = baseStatus({ appVersion: "0.1.2", qaMode: false, qaScenario: null });
    render(<AboutPage />);
    const version = await screen.findByRole("region", { name: "版本信息" });
    expect(within(version).getByText("v0.1.2")).toBeTruthy();
    expect(within(version).getByText("正式构建 · Demo · v0.1.2-demo.1")).toBeTruthy();
    expect(within(version).getByText("b17a430")).toBeTruthy();
  });

  it("开发与归属：已知信息展示，未知信息标「待补充」", async () => {
    render(<AboutPage />);
    const owners = await screen.findByRole("region", { name: "开发与归属" });
    expect(within(owners).getAllByText("RINTO").length).toBe(3); // 开发者 / 维护者 / 版权
    expect(within(owners).getByText("ArtFlow Desk")).toBeTruthy();
    expect(within(owners).getByText("许可证")).toBeTruthy();
    expect(within(owners).getByText("未设置公开许可证")).toBeTruthy();
    expect(within(owners).getAllByText("待补充").length).toBe(1); // 仅官网/联系方式
  });

  it("七个功能模块都有介绍，且不出现开发术语", async () => {
    render(<AboutPage />);
    const modules = await screen.findByRole("region", { name: "功能模块" });
    for (const title of [
      "工作台",
      "订单信息",
      "客户管理",
      "流程模板",
      "日历排单",
      "数据统计",
      "通用设置",
    ]) {
      expect(within(modules).getByRole("heading", { name: title })).toBeTruthy();
    }
    const text = modules.textContent ?? "";
    for (const jargon of ["Rust", "SQLite", "IPC", "Schema", "Migration"]) {
      expect(text).not.toContain(jargon);
    }
  });

  it("使用指引覆盖八个主题，且默认只展开第一个", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const details = guides.querySelectorAll("details");
    expect(details.length).toBe(8);
    expect(details[0]?.open).toBe(true);
    expect(details[1]?.open).toBe(false);
    expect(details[7]?.open).toBe(false);
  });

  it("指引可展开与收起", async () => {
    const user = userEvent.setup();
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const summary = within(guides).getByText("数据备份与恢复");
    await user.click(summary);
    const detail = summary.closest("details");
    expect(detail?.open).toBe(true);
    await user.click(summary);
    expect(summary.closest("details")?.open).toBe(false);
  });

  it("数据环境保留原页面的真实状态字段", async () => {
    render(<AboutPage />);
    await waitFor(() => expect(screen.getAllByText("gen-abc123def456").length).toBeGreaterThan(0));
    const env = screen.getByRole("region", { name: "数据环境" });
    for (const label of [
      "运行模式",
      "应用版本",
      "数据库结构",
      "数据代际",
      "SQLite",
      "日志模式",
      "写入锁",
      "工作时区",
      "系统时区",
    ]) {
      expect(within(env).getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("/Users/test/Library/Application Support/dev.artflow.minidesk.qa/seeded")).toBeTruthy();
    expect(within(env).getByText("订单")).toBeTruthy();
    expect(within(env).getAllByText("14").length).toBeGreaterThan(0); // 订单数 + 高水位
    expect(within(env).getByText("AF-2026-0015")).toBeTruthy();
    expect(screen.getByText(/完整性 正常/)).toBeTruthy();
  });

  it("QA 环境有两处醒目标识，正式环境没有", async () => {
    render(<AboutPage />);
    expect(await screen.findByTestId("qa-badge")).toBeTruthy();
    expect(screen.getByText(/QA 测试环境：数据目录与正式台账完全隔离/)).toBeTruthy();
    expect(screen.getByText(/QA 测试环境 · 预置场景（与正式数据隔离）/)).toBeTruthy();
  });

  it("正式环境下不显示 QA 标识", async () => {
    status = baseStatus({
      qaMode: false,
      qaScenario: null,
      rootPath: "/Users/test/Library/Application Support/dev.artflow.minidesk",
    });
    render(<AboutPage />);
    await waitFor(() => expect(screen.getByText("正式应用")).toBeTruthy());
    expect(screen.queryByTestId("qa-badge")).toBeNull();
    expect(screen.queryByText(/QA 测试环境：数据目录与正式台账完全隔离/)).toBeNull();
    expect(screen.getByText(/正式构建/)).toBeTruthy();
  });

  it("状态查询失败时明确报错，不猜测环境", async () => {
    statusError = new Error("数据目录不可读");
    render(<AboutPage />);
    await waitFor(() => expect(screen.getByText("无法读取数据环境")).toBeTruthy());
    expect(await screen.findByText(/数据目录不可读/)).toBeTruthy();
    expect(screen.queryByTestId("qa-badge")).toBeNull();
    expect(screen.queryByText("正式应用")).toBeNull();
    // 版本区不能假装读到了
    expect(screen.getAllByText("读取中…").length).toBeGreaterThan(0);
  });

  it("首次启动会说明已初始化正式数据库", async () => {
    status = baseStatus({ firstRun: true, qaMode: false, qaScenario: null });
    render(<AboutPage />);
    expect(await screen.findByText(/本次是首次启动，已初始化正式数据库/)).toBeTruthy();
  });

  it("没有编号时不渲染空表", async () => {
    status = baseStatus({ highWater: [] });
    render(<AboutPage />);
    expect(await screen.findByText("尚无已分配的订单编号。")).toBeTruthy();
    expect(screen.queryByText("下一编号")).toBeNull();
  });
});

describe("快捷键与内容规范", () => {
  it("快捷键主题列出六组键位，范围与代码实现一致", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const shortcuts = within(guides).getByText("快捷键与键盘操作").closest("details")!;
    await userEvent.setup().click(within(shortcuts).getByText("快捷键与键盘操作"));

    const rows = shortcuts.querySelectorAll("tbody tr");
    expect(rows.length).toBe(6);
    const table = shortcuts.textContent ?? "";
    // 实现：⌘N 只在订单/客户/模板；设置页只有 ⌘S；⌘F 与方向键/Enter 只在订单列表
    expect(table).toContain("订单、客户、流程模板");
    expect(table).toContain("订单详情、客户、流程模板、通用设置");
    expect(table).toContain("聚焦搜索框");
    expect(table).toContain("订单列表");
    expect(table).toContain("⌘ N");
    expect(table).toContain("⌘ S");
    expect(table).toContain("⌘ F");
    expect(table).toContain("Esc");
    // 不得出现未验证的 Windows 键位
    expect(table).not.toContain("Ctrl");
    expect(table).not.toContain("Cmd");
  });

  it("快捷键行为说明覆盖五条要点", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const body = within(guides).getByText("快捷键与键盘操作").closest("details")!.textContent ?? "";
    expect(body).toMatch(/只移动键盘光标，不会改变订单在队列里的顺序/);
    expect(body).toMatch(/按 Enter 才会打开当前光标所在的订单/);
    expect(body).toMatch(/⌘ S 只在存在未保存修改时执行保存/);
    expect(body).toMatch(/Esc 按弹窗层级处理，只关最上面那一层/);
    expect(body).toMatch(/输入框、文本域或下拉框里时，方向键与 Enter 只作用于输入内容/);
  });

  it("快捷键主题是第二个，排在快速开始之后", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const titles = [...guides.querySelectorAll("summary")].map((s) => s.textContent);
    expect(titles[0]).toBe("快速开始");
    expect(titles[1]).toBe("快捷键与键盘操作");
    expect(titles).toHaveLength(8);
  });

  it("使用指引不包含测试流程、预置数据与开发阶段编号", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const text = guides.textContent ?? "";
    for (const bad of ["DEV-", "预置场景", "预置数据", "验收", "自动化测试", "测试用例", "QA 测试环境"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("功能模块说明同样不混入开发与测试内容", async () => {
    render(<AboutPage />);
    const modules = await screen.findByRole("region", { name: "功能模块" });
    const text = modules.textContent ?? "";
    for (const bad of ["DEV-", "预置", "验收", "测试数据"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("保留专业术语：schema / generation / SQLite / WAL / CSV / 工作时区", async () => {
    render(<AboutPage />);
    await waitFor(() => expect(screen.getAllByText("gen-abc123def456").length).toBeGreaterThan(0));
    const page = document.body.textContent ?? "";
    for (const term of ["数据库结构版本", "数据代际", "SQLite", "日志模式", "工作时区"]) {
      expect(page).toContain(term);
    }
    // CSV 只出现在功能模块的导出说明里
    expect(page).toContain("CSV");
  });

  it("许可证改为「未设置公开许可证」，且不宣称任何开源协议", async () => {
    render(<AboutPage />);
    const owners = await screen.findByRole("region", { name: "开发与归属" });
    expect(within(owners).getByText("未设置公开许可证")).toBeTruthy();
    const text = owners.textContent ?? "";
    for (const license of ["MIT", "Apache", "GPL", "BSD", "专有"]) {
      expect(text).not.toContain(license);
    }
  });

  it("QA 真实状态标识与数据环境字段未受影响", async () => {
    render(<AboutPage />);
    expect(await screen.findByTestId("qa-badge")).toBeTruthy();
    const env = screen.getByRole("region", { name: "数据环境" });
    expect(within(env).getByText(/QA 测试环境：数据目录与正式台账完全隔离/)).toBeTruthy();
    expect(within(env).getByText("SQLite")).toBeTruthy();
    expect(within(env).getByText("wal")).toBeTruthy();
    expect(within(env).getByText("3.50.4")).toBeTruthy();
    expect(within(env).getByText("AF-2026-0015")).toBeTruthy();
    // 数据环境的真实状态不属于「用户指引」，仍然保留
    expect(await screen.findByText(/QA 测试构建（预置场景）/)).toBeTruthy();
  });
});
