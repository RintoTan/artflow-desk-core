/**
 * 订单状态的中文文案。全站唯一来源——不要在页面里再维护一份。
 *
 * 未知状态原样返回，避免新增枚举时界面出现空白。
 */
const ORDER_STATUS_LABEL: Record<string, string> = {
  active: "活动",
  complete: "已完成",
  cancelled: "已取消",
};

export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) {
    return "—";
  }
  return ORDER_STATUS_LABEL[status] ?? status;
}
