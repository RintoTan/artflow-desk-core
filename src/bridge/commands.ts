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
  /** true = 当前进程跑在 QA 沙箱（后端总是返回；旧夹具可省略）。 */
  qaMode?: boolean;
  /** `seeded` / `clean`；正式模式为 null。 */
  qaScenario?: string | null;
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

export type DeadlineState = "overdue" | "today" | "dueSoon" | "unscheduled" | "scheduled";

export type Capabilities = {
  canStartWork: boolean;
  canUndoStartWork: boolean;
  undoBlockedReason: string | null;
  canAdvance: boolean;
  canRework: boolean;
  /** 是否存在"至少跨过一个中间阶段"的前向目标。 */
  canSkip: boolean;
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
  /** 所属流程模板；阶段筛选按 (stageTemplateId, stageId) 匹配 */
  stageTemplateId: string;
  /** 接稿渠道；NULL = 未设置（旧订单不会被回填） */
  source: string | null;
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
  /** 按工作时时区判定的交付风险；终态订单恒为 scheduled */
  deadlineState: DeadlineState;
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
  oldStartDate: string | null;
  oldDeliveryDate: string | null;
  newStartDate: string | null;
  newDeliveryDate: string | null;
  reason: string | null;
  changeSource: string | null;
  /** 跳级专用：被跳过阶段的快照 JSON 文本；其它事件为 null。 */
  skippedStages: string | null;
  /** 跳级专用原因；与改期 reason、事件 note 分开。 */
  skipReason: string | null;
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
  source?: string | null;
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
  source: string | null;
  amountCents: number | null;
  plannedStartDate: string | null;
  plannedDeliveryDate: string | null;
  note: string | null;
  /** 改期来源：日历或订单详情。缺省由后端视为 order_details。 */
  changeSource?: "calendar" | "order_details";
  /** 改期原因，选填。 */
  reason?: string | null;
};

export type LifecycleInput = {
  orderId: string;
  expectedRevision: number;
  requestId?: string | null;
};

export type ReworkInput = LifecycleInput & { targetStageId: string | null };

export type BackupStatus = {
  schemaVersion: number;
  formatVersion: number;
  appVersion: string;
  generation: string;
  root: string;
  workingTimezone: string;
  lastSuccessAt: string | null;
  lastPath: string | null;
  reminderDays: number;
  reminderDue: boolean;
  daysSinceLast: number | null;
  lastError: string | null;
  orders: number;
  attachments: number;
  databaseBytes: number;
  reachable: boolean;
};

export type BackupSummary = {
  orders: number;
  activeOrders: number;
  clients: number;
  templates: number;
  events: number;
  attachments: number;
  stageSkips: number;
  reschedules: number;
};

export type BackupCreated = {
  path: string;
  bytes: number;
  files: number;
  attachmentFiles: number;
  databaseBytes: number;
  schemaVersion: number;
  summary: BackupSummary;
  createdAt: string;
};

export type BackupPreview = {
  path: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  workingTimezone: string;
  sourceGenerationId: string | null;
  files: number;
  attachmentFiles: number;
  bytes: number;
  /** `current` / `older`（可在隔离代际内迁移）/ `newer`（拒绝） */
  schemaRelation: "current" | "older" | "newer" | string;
  summary: BackupSummary;
  canRestore: boolean;
  blockReason: string | null;
};

export type BackupRestored = {
  newGeneration: string;
  previousGeneration: string;
  migratedFrom: number;
  schemaVersion: number;
  summary: BackupSummary;
  raisedWatermarks: Array<{ year: number; lastAllocated: number }>;
  missingThumbs: number;
  cleanupTasksRetargeted: number;
  staleJobsClosed: number;
  preRestoreBackup: string | null;
};

export type QuarantineItem = {
  name: string;
  bytes: number;
  modifiedAt: string;
  referenced: boolean;
};

export type QuarantineReport = {
  generation: string;
  dir: string;
  items: QuarantineItem[];
  totalBytes: number;
  referencedCount: number;
  removableCount: number;
  removableBytes: number;
};

export type QuarantineCleared = {
  removed: number;
  skippedReferenced: number;
  skippedUnsafe: number;
  bytesFreed: number;
  errors: string[];
};

export type JobsReport = {
  counts: { pending: number; running: number; done: number; failed: number; total: number };
  prunable: number;
  oldestDoneAt: string | null;
};

export type PruneReport = {
  cutoff: string;
  matched: number;
  removed: number;
  keptPending: number;
  keptRecent: number;
};

export type SkipInput = LifecycleInput & {
  targetStageId: string;
  reason?: string | null;
};

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
  skipStage: (input: SkipInput) => invoke<OrderView>("skip_stage", { input }),
  completeOrder: (input: LifecycleInput) => invoke<OrderView>("complete_order", { input }),
  cancelOrder: (input: LifecycleInput) => invoke<OrderView>("cancel_order", { input }),
  reopenOrder: (input: LifecycleInput) => invoke<OrderView>("reopen_order", { input }),

  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupCreate: (targetPath?: string | null) =>
    invoke<BackupCreated>("backup_create", { targetPath: targetPath ?? null }),
  backupInspect: (path: string) => invoke<BackupPreview>("backup_inspect", { path }),
  backupRestore: (path: string) => invoke<BackupRestored>("backup_restore", { path }),
  backupSetReminder: (days: number) => invoke<BackupStatus>("backup_set_reminder", { days }),
  restartApp: () => invoke<void>("restart_app"),

  maintenanceQuarantine: () => invoke<QuarantineReport>("maintenance_quarantine"),
  maintenanceQuarantineClear: (names: string[]) =>
    invoke<QuarantineCleared>("maintenance_quarantine_clear", { names }),
  maintenanceJobs: (pruneDays: number) =>
    invoke<JobsReport>("maintenance_jobs", { pruneDays }),
  maintenanceJobsPrune: (input: { olderThanDays: number; dryRun: boolean }) =>
    invoke<PruneReport>("maintenance_jobs_prune", { input }),

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
  /** 已知委托金额合计（分）；NULL 金额不计入，也不当成 0 */
  knownAmountCents: number;
  /** 最近一次下单时间（UTC RFC3339），按工作时时区格式化后显示 */
  lastOrderAt: string | null;
  tags: ClientTag[];
  createdAt: string;
  updatedAt: string;
};

export type ClientTag = {
  id: string;
  name: string;
  /** 使用该标签的客户数 */
  clientCount: number;
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

export const clientTagApi = {
  list: () => invoke<ClientTag[]>("client_tag_list"),
  create: (name: string) => invoke<ClientTag>("client_tag_create", { name }),
  remove: (tagId: string) => invoke<null>("client_tag_delete", { tagId }),
  link: (clientId: string, tagId: string) =>
    invoke<ClientTag[]>("client_tag_link", { clientId, tagId }),
  unlink: (clientId: string, tagId: string) =>
    invoke<ClientTag[]>("client_tag_unlink", { clientId, tagId }),
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

// ---------------------------------------------------------------- DEV-06B 主题

export type ThemeInfo = {
  /** arctic / dark / system，已校验 */
  mode: string;
  /** #rrggbb 或 null */
  accent: string | null;
  /** 库里的原始值，用于识别"配置损坏" */
  storedMode: string | null;
};

export const themeApi = {
  get: () => invoke<ThemeInfo>("ui_theme_get"),
  set: (mode: string, accent: string | null) =>
    invoke<ThemeInfo>("ui_theme_set", { mode, accent }),
};

// ---------------------------------------------------------------- DEV-06B 应用图标

export type IconInfo = {
  /** orbit / layers / wave-a，已校验 */
  variant: string;
  /** 库里的原始值，用于识别"配置损坏" */
  storedVariant: string | null;
  /** 后端认定的默认变体，界面不必再硬编码一份 */
  defaultVariant: string;
};

export const iconApi = {
  get: () => invoke<IconInfo>("ui_icon_get"),
  set: (variant: string) => invoke<IconInfo>("ui_icon_set", { variant }),
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
  /** null = 尚未分类；reference = 参考素材；final = 成品 */
  role: "reference" | "final" | null;
  /** 是否允许出现在本机默认画廊 */
  galleryVisible: boolean;
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

// ---------------------------------------------------------------- DEV-05

export type DashboardMetrics = {
  activeTotal: number;
  queued: number;
  inProgress: number;
  dueSoon: number;
  dueToday: number;
  overdue: number;
  unscheduled: number;
  completedThisMonth: number;
  cancelledThisMonth: number;
  createdThisMonth: number;
  timezone: string;
  today: string;
  month: string;
};

export type CompletedEventRow = {
  eventId: number;
  orderId: string;
  code: string;
  title: string;
  occurredAt: string;
  localTime: string;
  stageTitle: string | null;
};

export type StatsRangeKey = "thisMonth" | "last6" | "last12" | "all";

export type MonthBucket = {
  month: string;
  created: number;
  completed: number;
  cancelled: number;
  amountCents: number;
  knownOrders: number;
  unknownOrders: number;
};

export type StatsReport = {
  range: StatsRangeKey;
  timezone: string;
  fromMonth: string;
  toMonth: string;
  months: MonthBucket[];
  totals: MonthBucket;
  basis: string[];
};

export type ExportResult = { path: string; rows: number; bytes: number };

export const statsApi = {
  dashboard: () => invoke<DashboardMetrics>("dashboard_metrics"),
  completedEvents: (month: string) =>
    invoke<CompletedEventRow[]>("dashboard_completed_events", { month }),
  report: (range: StatsRangeKey) => invoke<StatsReport>("stats_report", { range }),
  exportSummary: (input: { path: string; range: StatsRangeKey }) =>
    invoke<ExportResult>("export_summary_csv", { input }),
  exportOrders: (input: { path: string; scope: "all" | "filtered"; orderIds?: string[] }) =>
    invoke<ExportResult>("export_orders_csv", { input }),
};

export type UpdateAttachmentMetaInput = {
  attachmentId: string;
  displayName?: string | null;
  note?: string | null;
  tag?: string | null;
  /** 省略 = 不改；null = 回到未分类 */
  role?: "reference" | "final" | null;
  /** 省略 = 不改 */
  galleryVisible?: boolean;
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
  updateMeta: (input: UpdateAttachmentMetaInput) =>
    invoke<AttachmentView>("attachment_update_meta", { input }),
};
