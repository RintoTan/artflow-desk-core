import { invoke } from "@tauri-apps/api/core";

export type AppError = { code: string; message: string };

export type YearWatermark = { year: number; lastAllocated: number };

export type EnvironmentStatus = {
  appVersion: string;
  firstRun: boolean;
  generation: string;
  schemaVersion: number;
  upgradedFrom: number | null;
  rootPath: string;
  sqliteVersion: string;
  journalMode: string;
  workingTimezone: string;
  systemTimezone: string;
  lockHeld: boolean;
  orders: number;
  clients: number;
  templates: number;
  attachments: number;
  pendingCleanup: number;
  highWater: YearWatermark[];
  integrity: string;
};

export type TimezoneInfo = {
  workingTimezone: string;
  systemTimezone: string;
  sameAsSystem: boolean;
};

export type WorkState = "queued" | "inProgress" | "completed" | "cancelled";

export type Capabilities = {
  canStartWork: boolean;
  canUndoStartWork: boolean;
  undoBlockedReason: string | null;
  canAdvance: boolean;
  canRework: boolean;
  canComplete: boolean;
  canCancel: boolean;
  canReopen: boolean;
  canEditWorkflow: boolean;
};

export type StageView = {
  id: string;
  title: string;
  position: number;
  isCurrent: boolean;
};

export type OrderStatus = "active" | "complete" | "cancelled";

export type OrderView = {
  id: string;
  code: string;
  title: string;
  clientId: string | null;
  clientName: string | null;
  commissionType: string | null;
  amountCents: number | null;
  note: string | null;
  status: OrderStatus;
  workState: WorkState;
  currentStageId: string | null;
  currentStageTitle: string | null;
  currentStageIndex: number | null;
  stageCount: number;
  stages: StageView[];
  queuePosition: number;
  plannedStartDate: string | null;
  plannedDeliveryDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  capabilities: Capabilities;
};

export type OrderEvent = {
  id: number;
  orderId: string;
  kind: string;
  fromStageId: string | null;
  fromStageTitle: string | null;
  toStageId: string | null;
  toStageTitle: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  movement: string | null;
  note: string | null;
  occurredAt: string;
};

export type ClientChoice =
  | { mode: "none" }
  | { mode: "existing"; clientId: string }
  | { mode: "new"; displayName: string; contact?: string | null; note?: string | null };

export type CreateOrderInput = {
  title: string;
  client: ClientChoice;
  commissionType?: string | null;
  amountCents?: number | null;
  plannedStartDate?: string | null;
  plannedDeliveryDate?: string | null;
  note?: string | null;
  templateId?: string | null;
  requestId?: string | null;
};

export type UpdateDetailsInput = {
  orderId: string;
  expectedRevision: number;
  title: string;
  clientId: string | null;
  commissionType: string | null;
  amountCents: number | null;
  plannedStartDate: string | null;
  plannedDeliveryDate: string | null;
  note: string | null;
};

export type LifecycleInput = {
  orderId: string;
  expectedRevision: number;
  requestId?: string | null;
};

export type ReworkInput = LifecycleInput & { targetStageId: string | null };

/** 把后端结构化错误转成可读中文，不做字符串猜测。 */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const candidate = error as Partial<AppError>;
    if (typeof candidate.message === "string") {
      const code = typeof candidate.code === "string" ? candidate.code : "ERROR";
      return `${candidate.message}（${code}）`;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Partial<AppError>).code === "CONFLICT"
  );
}

/** 为一次性操作生成幂等键：同一次点击只产生一个业务结果。 */
export function newRequestId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export const api = {
  status: () => invoke<EnvironmentStatus>("environment_status"),
  timezoneGet: () => invoke<TimezoneInfo>("working_timezone_get"),
  timezoneSet: (timezoneName: string) =>
    invoke<TimezoneInfo>("working_timezone_set", { timezoneName }),

  listOrders: () => invoke<OrderView[]>("list_orders"),
  getOrder: (orderId: string) => invoke<OrderView>("get_order", { orderId }),
  listOrderEvents: (orderId: string) => invoke<OrderEvent[]>("list_order_events", { orderId }),
  listClients: () => invoke<ClientView[]>("list_clients"),
  createOrder: (input: CreateOrderInput) => invoke<OrderView>("create_order", { input }),
  updateOrderDetails: (input: UpdateDetailsInput) =>
    invoke<OrderView>("update_order_details", { input }),

  startWork: (input: LifecycleInput) => invoke<OrderView>("start_work", { input }),
  undoStartWork: (input: LifecycleInput) => invoke<OrderView>("undo_start_work", { input }),
  advanceStage: (input: LifecycleInput) => invoke<OrderView>("advance_stage", { input }),
  reworkStage: (input: ReworkInput) => invoke<OrderView>("rework_stage", { input }),
  completeOrder: (input: LifecycleInput) => invoke<OrderView>("complete_order", { input }),
  cancelOrder: (input: LifecycleInput) => invoke<OrderView>("cancel_order", { input }),
  reopenOrder: (input: LifecycleInput) => invoke<OrderView>("reopen_order", { input }),

  workflowAddStage: (input: {
    orderId: string;
    expectedRevision: number;
    title: string;
    position?: number | null;
    requestId?: string | null;
  }) => invoke<OrderView>("workflow_add_stage", { input }),
  workflowRenameStage: (input: {
    orderId: string;
    expectedRevision: number;
    stageId: string;
    title: string;
    requestId?: string | null;
  }) => invoke<OrderView>("workflow_rename_stage", { input }),
  workflowRemoveStage: (input: {
    orderId: string;
    expectedRevision: number;
    stageId: string;
    replacementStageId?: string | null;
    requestId?: string | null;
  }) => invoke<OrderView>("workflow_remove_stage", { input }),
  workflowReorderStages: (input: {
    orderId: string;
    expectedRevision: number;
    orderedStageIds: string[];
    requestId?: string | null;
  }) => invoke<OrderView>("workflow_reorder_stages", { input }),
};

// ---------------------------------------------------------------- DEV-03

export type QueueEntry = {
  orderId: string;
  code: string;
  title: string;
  queuePosition: number;
  workState: WorkState;
  currentStageTitle: string | null;
  clientName: string | null;
};

export type QueueSnapshot = {
  revision: number;
  entries: QueueEntry[];
};

export type ClientView = {
  id: string;
  displayName: string;
  contact: string | null;
  note: string | null;
  revision: number;
  orderCount: number;
  activeCount: number;
  completedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ClientOrderBrief = {
  id: string;
  code: string;
  title: string;
  status: OrderStatus;
  currentStageTitle: string | null;
  amountCents: number | null;
  createdAt: string;
};

export type ClientDetail = {
  client: ClientView;
  orders: ClientOrderBrief[];
};

export type StepView = {
  stepId: string;
  title: string;
  position: number;
};

export type TemplateView = {
  id: string;
  name: string;
  isDefault: boolean;
  revision: number;
  steps: StepView[];
  stepCount: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type StepInput = {
  stepId?: string | null;
  title: string;
};

export type ListDensity = "comfortable" | "compact";

export const queueApi = {
  list: () => invoke<QueueSnapshot>("queue_list"),
  move: (input: { orderId: string; expectedQueueRevision: number; toIndex: number }) =>
    invoke<QueueSnapshot>("queue_move", { input }),
};

export const clientApi = {
  list: () => invoke<ClientView[]>("list_clients"),
  create: (input: { displayName: string; contact?: string | null; note?: string | null }) =>
    invoke<ClientView>("client_create", { input }),
  update: (input: {
    clientId: string;
    expectedRevision: number;
    displayName: string;
    contact?: string | null;
    note?: string | null;
  }) => invoke<ClientView>("client_update", { input }),
  detail: (clientId: string) => invoke<ClientDetail>("client_detail", { clientId }),
};

export const templateApi = {
  list: () => invoke<TemplateView[]>("template_list"),
  create: (input: { name: string; steps: StepInput[]; makeDefault: boolean }) =>
    invoke<TemplateView>("template_create", { input }),
  update: (input: {
    templateId: string;
    expectedRevision: number;
    name: string;
    steps: StepInput[];
  }) => invoke<TemplateView>("template_update", { input }),
  duplicate: (input: { sourceId: string; name: string }) =>
    invoke<TemplateView>("template_duplicate", { input }),
  remove: (input: {
    templateId: string;
    expectedRevision: number;
    replacementDefaultId?: string | null;
  }) => invoke<TemplateView[]>("template_delete", { input }),
  setDefault: (input: { templateId: string }) =>
    invoke<TemplateView[]>("template_set_default", { input }),
};

export const preferenceApi = {
  get: (key: string) => invoke<string | null>("preference_get", { key }),
  set: (key: string, value: string) => invoke<string | null>("preference_set", { key, value }),
};

// ---------------------------------------------------------------- DEV-04 附件

export type AttachmentView = {
  id: string;
  orderId: string;
  originalName: string;
  displayName: string | null;
  note: string | null;
  tag: string | null;
  mimeType: string;
  byteSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
  state: "ok" | "missing" | "corrupt";
  createdAt: string;
  originalPath: string;
  thumbPath: string | null;
  fileExists: boolean;
  thumbExists: boolean;
};

export type ImportOutcome = {
  sourceName: string;
  ok: boolean;
  attachment: AttachmentView | null;
  error: string | null;
};

export type ThumbReport = {
  total: number;
  rebuilt: number;
  skipped: number;
  failed: number;
  failures: string[];
};

export type VerifyReport = {
  ok: number;
  missing: number;
  corrupt: number;
  attachments: AttachmentView[];
};

export const attachmentApi = {
  list: (orderId: string) => invoke<AttachmentView[]>("attachment_list", { orderId }),
  import: (input: { orderId: string; sourcePaths: string[]; tag?: string | null }) =>
    invoke<ImportOutcome[]>("attachment_import", { input }),
  remove: (attachmentId: string) => invoke<void>("attachment_remove", { attachmentId }),
  verify: (orderId: string) => invoke<VerifyReport>("attachment_verify", { orderId }),
  rebuildThumbs: (orderId: string) =>
    invoke<ThumbReport>("attachment_rebuild_thumbs", { orderId }),
  repair: (input: { attachmentId: string; sourcePath: string }) =>
    invoke<AttachmentView>("attachment_repair", { input }),
  updateMeta: (input: {
    attachmentId: string;
    displayName?: string | null;
    note?: string | null;
    tag?: string | null;
  }) => invoke<AttachmentView>("attachment_update_meta", { input }),
};
