/**
 * 回收站页面（D2 骨架）。
 *
 * 本阶段只建立入口与容器：客户组、订单列表与操作在 D3/D4 实现。
 * 页面上显式标注「待接入」，而不是画一个假的空态——否则用户会以为
 * 回收站真的为空，而实际上是功能还没接上。
 */
export default function TrashPage() {
  return (
    <section className="panel panel-quiet" aria-labelledby="trash-title">
      <header className="panel-head">
        <div>
          <h2 id="trash-title">回收站</h2>
          <p className="muted">删除的订单与客户会保留在这里，直到你手动清空。</p>
        </div>
        <span className="badge badge-warn">待接入</span>
      </header>
      <p className="muted">
        本页正在接入中：已删除的客户组与订单、恢复与永久删除操作将在后续阶段开放。
        当前版本不会展示任何伪造的数据。
      </p>
    </section>
  );
}
