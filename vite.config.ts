import { execSync } from "node:child_process";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** 跑一条 git 命令；没有 git（归档源码、精简环境）就返回 null，不抛。 */
function gitOutput(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 把当前提交号带进前端：QA 截图和问题反馈里能直接看出跑的是哪一版。
 *
 * 固定 7 位短 SHA。工作区有未提交改动时追加 `-dirty`——否则同一个短 SHA 会对应
 * 两种不同的代码，而「按提交号排查」这件事就失效了。
 * `git status --porcelain` 跳过 .gitignore 忽略的路径，所以 `dist/`、`target/`
 * 这些构建产物不会把干净的树误判成脏。
 */
function buildId(): string {
  const sha = gitOutput("rev-parse --short=7 HEAD");
  if (!sha) return "unknown";
  return gitOutput("status --porcelain --untracked-files=normal") ? `${sha}-dirty` : sha;
}

/**
 * 可选的发布标记（如 `v0.1.2-demo.1`）。
 *
 * 它标识的是 GitHub Release 迭代，**不是应用版本**，也不参与 QA 判定。
 * 没有设置就是空串，界面不显示任何发布标记。
 */
function releaseLabel(): string {
  return (process.env.VITE_RELEASE_LABEL ?? "").trim();
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __RELEASE_LABEL__: JSON.stringify(releaseLabel()),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "safari15",
    sourcemap: false,
  },
});
