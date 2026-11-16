type Props = {
  title: string;
  plan: string;
  items: string[];
};

/** 明确标注"尚未实现"的模块页，避免把占位当成已完成功能。 */
export default function Placeholder({ title, plan, items }: Props) {
  return (
    <section className="panel panel-quiet">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">模块尚未实现，计划于 {plan} 落地。当前版本不会伪造该模块的数据或交互。</p>
        </div>
        <span className="badge badge-warn">未实现</span>
      </header>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
