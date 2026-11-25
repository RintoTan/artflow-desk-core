/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

// 只给样式回归测试与构建配置用的最小 Node 声明：项目没有安装 @types/node，
// 为了几个调用点引入整套 Node 类型不划算，这里只声明真正用到的那几个。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function resolve(...segments: string[]): string;
}
declare const process: { cwd(): string; env: Record<string, string | undefined> };

/** 构建时由 vite.config.ts 注入的提交号：7 位短 SHA，脏工作区带 `-dirty`，取不到为 `unknown`。 */
declare const __BUILD_ID__: string;

/** 构建时由 `VITE_RELEASE_LABEL` 注入的发布标记（如 `v0.1.2-demo.1`）；未设置时为空串。 */
declare const __RELEASE_LABEL__: string;

declare module "node:child_process" {
  export function execSync(
    command: string,
    options: { encoding: "utf8"; stdio?: readonly string[] },
  ): string;
}
