import { describe, expect, it } from "vitest";

import { partitionImagePaths } from "./attachmentDrop";

describe("拖拽文件前置过滤", () => {
  it("接受后端白名单里的四种扩展名，大小写不敏感", () => {
    const result = partitionImagePaths([
      "/tmp/a.png",
      "/tmp/b.JPG",
      "/tmp/c.jpeg",
      "/tmp/d.WebP",
    ]);
    expect(result.accepted).toHaveLength(4);
    expect(result.rejected).toHaveLength(0);
  });

  it("拒绝不支持或没有扩展名的文件，并给出可读原因", () => {
    const result = partitionImagePaths(["/tmp/a.gif", "/tmp/README", "/tmp/b.pdf"]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.name)).toEqual(["a.gif", "README", "b.pdf"]);
    expect(result.rejected[0]?.reason).toContain("不支持 .gif");
    expect(result.rejected[1]?.reason).toContain("没有扩展名");
  });

  it("混合拖入时只放行合法项，不让整批失败", () => {
    const result = partitionImagePaths(["/tmp/x.png", "/tmp/y.tiff", "/tmp/z.webp"]);
    expect(result.accepted).toEqual(["/tmp/x.png", "/tmp/z.webp"]);
    expect(result.rejected).toHaveLength(1);
  });
});
