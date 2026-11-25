/**
 * 统一提示条。
 *
 * 三种语义：ok / warn / error。
 * 关键在于**角色**：只有 error 用 `alert`（打断式播报），ok 与 warn 用 `status`
 * （礼貌播报）——否则一条"已保存"也会像故障一样打断读屏。
 *
 * 样式沿用 `.notice` 体系，不新增颜色：项目里已经有三档底色来对应这三种语义，
 * 之前的问题只是有人绕过它自己调色。
 */
export type NoticeVariant = "ok" | "warn" | "error";

type Props = {
  variant: NoticeVariant;
  children: React.ReactNode;
  /** 页面局部布局微调（如弹窗内更紧凑），不要在这里改颜色。 */
  className?: string;
};

export default function Notice({ variant, children, className }: Props) {
  return (
    <p
      className={`notice notice-${variant}${className ? ` ${className}` : ""}`}
      role={variant === "error" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
