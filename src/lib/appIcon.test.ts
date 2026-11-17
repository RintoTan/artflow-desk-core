import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IconInfo } from "../bridge/commands";

let info: IconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
const iconGet = vi.fn(async () => info);
const iconSet = vi.fn(async (variant: string) => {
  info = { variant, storedVariant: variant, defaultVariant: "orbit" };
  return info;
});

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    iconApi: {
      get: () => iconGet(),
      set: (variant: string) => iconSet(variant),
    },
  };
});

async function loadModule() {
  return import("./appIcon");
}

beforeEach(() => {
  info = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
  iconGet.mockClear();
  iconSet.mockClear();
});

afterEach(async () => {
  const mod = await loadModule();
  mod.resetIconForTests();
  vi.restoreAllMocks();
});

describe("图标标识归一化", () => {
  it("三个稳定标识原样通过", async () => {
    const { normalizeIcon } = await loadModule();
    expect(normalizeIcon("orbit")).toBe("orbit");
    expect(normalizeIcon("layers")).toBe("layers");
    expect(normalizeIcon("wave-a")).toBe("wave-a");
  });

  it("旧版本缺失、空值、拼错、展示名都回退 orbit", async () => {
    const { normalizeIcon } = await loadModule();
    for (const bad of [undefined, null, "", "Wave A", "wave_a", "ORBIT", "custom"]) {
      expect(normalizeIcon(bad)).toBe("orbit");
    }
  });

  it("默认值与后端一致（orbit）", async () => {
    const { DEFAULT_ICON_VARIANT, ICON_VARIANTS } = await loadModule();
    expect(DEFAULT_ICON_VARIANT).toBe("orbit");
    expect(ICON_VARIANTS[0]).toBe("orbit");
  });

  it("每套图标都是用户提供的原图，不是近似替代图", async () => {
    const { ICON_VARIANTS, ICON_LABEL, iconAsset } = await loadModule();
    const urls = ICON_VARIANTS.map((variant) => iconAsset(variant));
    expect(new Set(urls).size).toBe(3);

    // 构建时小 SVG 会被内联成 data URI，所以按 <title> 指纹比对：
    // 只要有人把素材换成占位图，这里立刻失败。
    for (const variant of ICON_VARIANTS) {
      const decoded = decodeURIComponent(iconAsset(variant));
      expect(decoded).toContain("svg");
      expect(decoded).toContain(`ArtFlow miniDesk — ${ICON_LABEL[variant]}`);
      // 不得引用外部字体或外链图片：先去掉命名空间声明，它本身不是网络请求
      const body = decoded.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/, "");
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toContain("<image");
      expect(body).not.toContain("@font-face");
      expect(body).not.toContain("xlink:href");
    }
  });
});

describe("预览与保存", () => {
  it("启动时读后端；读失败也停在 orbit，不抛错", async () => {
    const { loadIcon, currentIcon, isIconLoaded } = await loadModule();
    info = { variant: "layers", storedVariant: "layers", defaultVariant: "orbit" };
    await loadIcon();
    expect(currentIcon()).toBe("layers");
    expect(isIconLoaded()).toBe(true);

    const mod = await loadModule();
    mod.resetIconForTests();
    iconGet.mockRejectedValueOnce({ code: "DB", message: "读不了" });
    await mod.loadIcon();
    expect(mod.currentIcon()).toBe("orbit");
  });

  it("预览立刻生效但不写库", async () => {
    const { loadIcon, setIconPreview, currentIcon, savedIcon, hasIconPreview } =
      await loadModule();
    await loadIcon();
    setIconPreview("wave-a");
    expect(currentIcon()).toBe("wave-a");
    expect(savedIcon()).toBe("orbit");
    expect(hasIconPreview()).toBe(true);
    expect(iconSet).not.toHaveBeenCalled();
  });

  it("保存成功才更新已保存值并清预览", async () => {
    const { loadIcon, setIconPreview, persistIcon, currentIcon, savedIcon } = await loadModule();
    await loadIcon();
    setIconPreview("layers");
    expect(await persistIcon("layers")).toBeNull();
    expect(iconSet).toHaveBeenCalledWith("layers");
    expect(savedIcon()).toBe("layers");
    expect(currentIcon()).toBe("layers");
  });

  it("保存失败保留预览并返回原因", async () => {
    const { loadIcon, setIconPreview, persistIcon, currentIcon, savedIcon } = await loadModule();
    await loadIcon();
    setIconPreview("layers");
    iconSet.mockRejectedValueOnce({ code: "DB", message: "磁盘只读" });

    const error = await persistIcon("layers");
    expect(error).toContain("磁盘只读");
    expect(savedIcon()).toBe("orbit");
    expect(currentIcon()).toBe("layers");
  });

  it("放弃预览回到已保存值", async () => {
    const { loadIcon, setIconPreview, clearIconPreview, currentIcon, hasIconPreview } =
      await loadModule();
    await loadIcon();
    setIconPreview("wave-a");
    clearIconPreview();
    expect(currentIcon()).toBe("orbit");
    expect(hasIconPreview()).toBe(false);
  });

  it("订阅者会收到预览与保存的通知", async () => {
    const { loadIcon, setIconPreview, persistIcon, subscribeIcon } = await loadModule();
    await loadIcon();
    const seen: string[] = [];
    const stop = subscribeIcon(() => seen.push("tick"));
    setIconPreview("layers");
    await persistIcon("layers");
    stop();
    setIconPreview("orbit");
    expect(seen.length).toBe(2);
  });
});
