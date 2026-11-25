/**
 * 空状态。
 *
 * 只表达一件事：**这里本来可以有内容，但当前没有**。
 * 所以它不承担"加载中"和"加载失败"——那两种状态各自有含义，
 * 混进来会让人分不清"还没读到"和"确实没有"。
 *
 * `inline` 用于表格单元格、列表项内部这类已经有容器边框的位置：
 * 去掉大留白，避免一个空格子撑出一大块死区。
 */
type Props = {
  title: string;
  /** 补充说明：为什么空、空了意味着什么。可选。 */
  description?: string;
  /** 可选操作入口（按钮/链接）。保持调用方原有的可用性。 */
  action?: React.ReactNode;
  inline?: boolean;
  className?: string;
};

export default function EmptyState({ title, description, action, inline, className }: Props) {
  return (
    <div
      className={[
        "empty-state",
        inline ? "empty-state-inline" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-desc">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
