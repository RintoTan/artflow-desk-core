/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

// 只给样式回归测试用的最小 Node 声明：项目没有安装 @types/node，
// 为了一个读文件断言引入整套 Node 类型不划算，这里只声明真正用到的两个 API。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function resolve(...segments: string[]): string;
}
declare const process: { cwd(): string };
