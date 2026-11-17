import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom 没有实现 scrollIntoView（真实浏览器有）。不补这一条，
// 任何"把元素滚进可视区"的代码在组件测试里都会抛 TypeError。
// 需要断言调用参数的用例，自己在用例内替换成 spy。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
