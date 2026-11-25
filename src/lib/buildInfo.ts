/**
 * 构建身份：提交号与发布标记。
 *
 * 两个值都在构建时由 `vite.config.ts` 注入（见其 `define`），运行时不去问 Git，
 * 也不新增后端字段。这里用函数而不是模块级常量，是为了测试能临时替换全局；
 * 页面每次渲染拿到的都是当次的值。
 *
 * 三者是**互相独立**的概念，不许互相顶替：
 * - 应用版本：来自 `Cargo.toml`，经后端 `environment_status` 给出；
 * - 运行环境：正式 / QA 测试环境，由 `status.qaMode` 判定；
 * - 发布标记：GitHub Release 的 Demo 迭代（如 `v0.1.2-demo.1`），不改变应用版本。
 */

const UNKNOWN = "unknown";

/** 7 位短 SHA；脏工作区已由构建脚本追加 `-dirty`。取不到时如实显示 `unknown`。 */
export function buildId(): string {
  const raw = typeof __BUILD_ID__ === "string" ? __BUILD_ID__.trim() : "";
  return raw === "" ? UNKNOWN : raw;
}

/** 发布标记；没有设置时返回空串，界面据此决定不显示。 */
export function releaseLabel(): string {
  return typeof __RELEASE_LABEL__ === "string" ? __RELEASE_LABEL__.trim() : "";
}

/**
 * 「运行构建」文案：环境在前，发布标记在后。
 *
 * 没有标记时原样返回环境文案，不留下多余的间隔符——空字段比缺失字段更容易被误读。
 */
export function buildKindLabel(base: string, label: string = releaseLabel()): string {
  return label === "" ? base : `${base} · Demo · ${label}`;
}
