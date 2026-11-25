/**
 * 页面头部：标题 + 可选副标题 + 可选右侧操作区。
 *
 * 设计取舍：外层与内层的类名都允许透传（`className` / `textClassName` / `actionsClassName`）。
 * 理由是现有页面已经用各自的外层类（`.orders-head`、`.stats-toolbar`…）定了布局细节，
 * 强行把内部结构换成统一类名等于顺手重排六个页面的顶部——那不是这批要做的事。
 * 组件先把**结构**统一（标题层级、副标题位置、操作槽位置），样式仍交给页面既有规则，
 * 这样回退成本最低。
 *
 * 它不持有任何业务状态：不接 onClick、不读数据，只摆放调用方给的东西。
 */
type Props = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区：按钮、筛选器、视图切换等既有控件。 */
  actions?: React.ReactNode;
  /** 外壳类名，通常沿用页面原有的 header 类，保持既有布局。 */
  className?: string;
  /** 标题/副标题容器的类名，保留原先的内部 flex 规则。 */
  textClassName?: string;
  /** 操作区容器的类名。 */
  actionsClassName?: string;
};

export default function PageHeader({
  title,
  description,
  actions,
  className,
  textClassName,
  actionsClassName,
}: Props) {
  return (
    <header className={["page-header", className ?? ""].filter(Boolean).join(" ")}>
      <div className={["page-header-text", textClassName ?? ""].filter(Boolean).join(" ")}>
        <h1 className="page-header-title">{title}</h1>
        {description ? <p className="page-header-desc">{description}</p> : null}
      </div>
      {actions ? (
        <div className={["page-header-actions", actionsClassName ?? ""].filter(Boolean).join(" ")}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}
