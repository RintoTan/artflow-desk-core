import { invoke } from "@tauri-apps/api/core";

import type { WorkStateKey } from "../lib/workState";

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
  /** 归档时间；非空表示已从「订单信息」的普通列表收起，其他页面照常显示。
   *  可缺省：旧缓存或测试夹具没有这个字段时应视为未归档，而不是已归档。 */
  archivedAt?: string | null;
  /** 置顶时间；非空只说明置过顶，是否**有效**要用 `isPinned()` 判（见 lib/ordersView）。 */
  pinnedAt?: string | null;
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

/** ORDER-01：从已有订单复制一笔新的活动订单。 */
export type DuplicateOrderInput = {
  sourceOrderId: string;
  title: string;
  clientId?: string | null;
  commissionType?: string | null;
  source?: string | null;
  amountCents?: number | null;
  note?: string | null;
  /** 默认 true；false 时不复制任何附件。 */
  copyAttachments: boolean;
  requestId?: string | null;
};

/** DEV-0.1.1-04：数据重置。六项独立，`only` 用于重试失败项。 */
export type DataResetInput = {
  business: boolean;
  settings: boolean;
  backups: boolean;
  reminder: boolean;
  logs: boolean;
  quarantine: boolean;
  only?: string[];
};

export type ResetItem = {
  option: string;
  /** ok | failed | skipped */
  status: string;
  reason: string | null;
  detail: string | null;
};

export type ResetReport = {
  items: ResetItem[];
  /** all_ok | partial | all_failed */
  overall: string;
  newGeneration: string | null;
  oldGeneration: string;
  oldGenerationPath: string;
  oldGenerationBytes: number;
  snapshotPath: string | null;
};

/** DEV-0.1.1-05：数据位置。 */
export type StorageStatus = {
  root: string;
  defaultRoot: string;
  pointerPath: string;
  custom: boolean;
};

export type MigratePreview = {
  sourceRoot: string;
  targetRoot: string;
  files: number;
  bytes: number;
  generations: string[];
  hasBackups: boolean;
  hasQuarantineEvidence: boolean;
  availableBytes: number;
  requiredBytes: number;
  fits: boolean;
};

export type MigrateReport = {
  sourceRoot: string;
  targetRoot: string;
  files: number;
  bytes: number;
  generations: string[];
  copiedFiles: number;
  verifiedFiles: number;
  snapshotPath: string | null;
  switched: boolean;
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
  /** 总数，含回收站 */
  orders: number;
  activeOrders: number;
  /** 总数，含回收站 */
  clients: number;
  templates: number;
  events: number;
  attachments: number;
  stageSkips: number;
  reschedules: number;
  /** `orders` 中在回收站的部分；旧后端可能缺省 */
  trashedOrders?: number;
  /** `clients` 中在回收站的部分；旧后端可能缺省 */
  trashedClients?: number;
  /** 财务四表是库存计数：含已归档平台、已作废流水、回收站订单的收款。旧后端缺省。 */
  paymentPlatforms?: number;
  paymentSchedules?: number;
  paymentRecords?: number;
  refundRecords?: number;
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
  /** 恢复会补什么、不补什么（平台回填、缺退款表等）。旧后端缺省 */
  warnings?: string[];
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
  /** 兼容提示：时区、高水位、平台回填、缺退款表。旧后端缺省 */
  warnings?: string[];
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
  duplicateOrder: (input: DuplicateOrderInput) =>
    invoke<OrderView>("duplicate_order", { input }),
  archiveOrder: (orderId: string) => invoke<OrderView>("order_archive", { orderId }),
  unarchiveOrder: (orderId: string) => invoke<OrderView>("order_unarchive", { orderId }),
  pinOrder: (orderId: string) => invoke<OrderView>("order_pin", { orderId }),
  unpinOrder: (orderId: string) => invoke<OrderView>("order_unpin", { orderId }),
  updateOrderDetails: (input: UpdateDetailsInput) =>
    invoke<OrderView>("update_order_details", { input }),

  startWork: (input: LifecycleInput) => invoke<OrderView>("start_work", { input }),
  undoStartWork: (input: LifecycleInput) => invoke<OrderView>("undo_start_work", { input }),
  advanceStage: (input: LifecycleInput) => invoke<OrderView>("advance_stage", { input }),
  reworkStage: (input: ReworkInput) => invoke<OrderView>("rework_stage", { input }),
  skipStage: (input: SkipInput) => invoke<OrderView>("skip_stage", { input }),
  completeOrder: (input: LifecycleInput) => invoke<OrderView>("complete_order", { input }),
  /**
   * 取消订单。`refundDecision` 必填：不允许由前端替用户猜「有没有退钱」。
   * `record` 时 `refunds` 至少一笔，后端会在同一事务里写入。
   */
  cancelOrder: (input: {
    orderId: string;
    expectedRevision: number;
    requestId: string | null;
    refundDecision: "none" | "record";
    refunds: Array<{
      paymentRecordId: string | null;
      amountCents: number;
      refundedOn: string;
      method: string | null;
      note: string | null;
    }>;
  }) => invoke<OrderView>("cancel_order", { input }),
  reopenOrder: (input: LifecycleInput) => invoke<OrderView>("reopen_order", { input }),

  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupCreate: (targetPath?: string | null) =>
    invoke<BackupCreated>("backup_create", { targetPath: targetPath ?? null }),
  backupInspect: (path: string) => invoke<BackupPreview>("backup_inspect", { path }),
  backupRestore: (path: string) => invoke<BackupRestored>("backup_restore", { path }),
  backupSetReminder: (days: number) => invoke<BackupStatus>("backup_set_reminder", { days }),
  restartApp: () => invoke<void>("restart_app"),
  dataReset: (input: DataResetInput) => invoke<ResetReport>("data_reset", { input }),
  storageStatus: () => invoke<StorageStatus>("storage_status"),
  storagePreview: (target: string) => invoke<MigratePreview>("storage_preview", { target }),
  storageMigrate: (target: string) => invoke<MigrateReport>("storage_migrate", { target }),
  storageUseDefault: () => invoke<void>("storage_use_default"),

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
  exportFinanceStats: (input: { path: string; range: StatsRangeKey }) =>
    invoke<ExportResult>("export_finance_stats_csv", { input }),
  exportPayments: (input: { path: string }) =>
    invoke<ExportResult>("export_payments_csv", { input }),
  exportOrders: (input: {
    path: string;
    scope: "all" | "filtered";
    orderIds?: string[];
    /** 是否包含回收站订单；默认 false */
    includeTrashed?: boolean;
  }) => invoke<ExportResult>("export_orders_csv", { input }),
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

// ---------------------------------------------------------------- 回收站

/** 回收站里的一条订单。删除时间可能早于所属客户组（删客户前它已单独删过）。 */
export type TrashOrder = {
  id: string;
  code: string;
  title: string;
  deletedAt: string;
  /** 删除前的制作进度，不是 `orders.status`。 */
  workState: WorkStateKey;
  /** 原客户名；客户组成员为 null（组头已有名字）。 */
  originalClientName: string | null;
  /** 附件**记录**数，不是文件数（一条记录对应原图 + 缩略图）。 */
  attachmentCount: number;
};

export type TrashGroup = {
  clientId: string;
  clientName: string;
  deletedAt: string;
  orders: TrashOrder[];
};

export type TrashSnapshot = {
  groups: TrashGroup[];
  looseOrders: TrashOrder[];
  groupCount: number;
  looseOrderCount: number;
  /** 全部回收站订单，含客户组内部。 */
  totalOrderCount: number;
};

/** 删除客户前的影响范围。 */
export type ClientDeleteImpact = {
  clientId: string;
  clientName: string;
  /** 客户名下全部订单（含已在回收站的）。 */
  orderCount: number;
  /** 其中已经在回收站的，会被并入本次客户组。 */
  alreadyTrashed: number;
};

export type DeletedOrder = { orderId: string; deletedAt: string };

export type DeletedClient = {
  clientId: string;
  deletedAt: string;
  ordersTrashed: number;
  ordersAlreadyTrashed: number;
};

export type RestoredOrder = { orderId: string; ordersRestored: number };

export type RestoredClient = {
  clientId: string;
  ordersRestored: number;
  clientsRestored: number;
};

/** 一次永久删除的附件清理结果：记录数、登记文件数、实际清理结果分开报。 */
export type PurgeCleanup = {
  cleaned: number;
  pending: number;
  pendingPaths: string[];
};

export type PurgeResult = {
  ordersPurged: number;
  attachmentsRemoved: number;
  filesRegistered: number;
  cleanup: PurgeCleanup;
};

export type PurgeGroupResult = {
  clientId: string;
  clientsPurged: number;
  ordersPurged: number;
  attachmentsRemoved: number;
  filesRegistered: number;
  cleanup: PurgeCleanup;
};

export type TrashBatchOutcome = {
  label: string;
  ok: boolean;
  ordersPurged: number;
  filesRegistered: number;
  cleanupPending: number;
  error: string | null;
};

export type EmptyTrashResult = {
  batches: TrashBatchOutcome[];
  purgedBatches: number;
  failedBatches: number;
  ordersPurged: number;
  filesRegistered: number;
  cleanupPending: number;
};

export type PurgeCleanupStatus = {
  failed: number;
  oldestCreatedAt: string | null;
};

export const trashApi = {
  snapshot: () => invoke<TrashSnapshot>("trash_snapshot"),
  clientDeleteImpact: (clientId: string) =>
    invoke<ClientDeleteImpact>("trash_client_delete_impact", { clientId }),
  deleteOrder: (orderId: string) => invoke<DeletedOrder>("trash_delete_order", { orderId }),
  deleteClient: (clientId: string) => invoke<DeletedClient>("trash_delete_client", { clientId }),
  restoreOrder: (orderId: string) => invoke<RestoredOrder>("trash_restore_order", { orderId }),
  restoreClient: (clientId: string) => invoke<RestoredClient>("trash_restore_client", { clientId }),
  purgeOrder: (orderId: string) => invoke<PurgeResult>("trash_purge_order", { orderId }),
  purgeClient: (clientId: string) => invoke<PurgeGroupResult>("trash_purge_client", { clientId }),
  empty: () => invoke<EmptyTrashResult>("trash_empty"),
  cleanupStatus: () => invoke<PurgeCleanupStatus>("trash_cleanup_status"),
  retryCleanup: () => invoke<PurgeCleanupStatus>("trash_retry_cleanup"),
};

// ---------------------------------------------------------------- FIN-02

export type PlatformView = {
  id: string;
  name: string;
  /** null = 未配置费率；0 = 明确零费率。两者不可混淆。 */
  feeRateBp: number | null;
  archived: boolean;
  sortPosition: number;
  createdAt: string;
  updatedAt: string;
};

export type DeletePlatformReport = {
  id: string;
  name: string;
  /** 因删除平台而失去关联的收款流水数；这些流水的快照仍然保留。 */
  detachedPayments: number;
};

/**
 * 费率一律以**用户输入的原文**送到后端换算（`"1.25"` → 125bp）。
 * 前端只负责展示，不重复实现一套可能漂移的解析。
 */
export const financeApi = {
  platforms: () => invoke<PlatformView[]>("finance_platform_list"),
  createPlatform: (input: { name: string; feeRate: string | null }) =>
    invoke<PlatformView>("finance_platform_create", { input }),
  updatePlatform: (input: { id: string; name: string; feeRate: string | null }) =>
    invoke<PlatformView>("finance_platform_update", { input }),
  archivePlatform: (id: string) => invoke<PlatformView>("finance_platform_archive", { id }),
  restorePlatform: (id: string) => invoke<PlatformView>("finance_platform_restore", { id }),
  reorderPlatforms: (ids: string[]) =>
    invoke<PlatformView[]>("finance_platform_reorder", { ids }),
  deletePlatform: (id: string) =>
    invoke<DeletePlatformReport>("finance_platform_delete", { id }),
};

// ---------------------------------------------------------------- FIN-03

export type PaymentRecordView = {
  id: string;
  orderId: string;
  scheduleId: string | null;
  kind: "full" | "deposit" | "installment" | "final";
  amountCents: number;
  receivedOn: string;
  platformId: string | null;
  platformName: string | null;
  feeRateBp: number | null;
  feeCents: number;
  /** 派生值，后端算好：amountCents - feeCents */
  netCents: number;
  method: string | null;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
};

export type PlanItemView = {
  id: string;
  kind: "full" | "deposit" | "installment" | "final";
  amountCents: number;
  expectedDate: string | null;
  sortPosition: number;
  receivedCents: number;
  outstandingCents: number;
  status: "unpaid" | "partial" | "settled" | "overdue";
};

/** 订单财务全景。全部由后端派生，没有任何「已收」「待收」落库字段。 */
export type RefundView = {
  id: string;
  orderId: string;
  /** null = 未关联原收款，系统核验不了可退款余额。 */
  paymentRecordId: string | null;
  amountCents: number;
  refundedOn: string;
  method: string | null;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  unmatched: boolean;
};

export type OrderFinanceView = {
  orderId: string;
  orderAmountCents: number | null;
  planMode: "none" | "full" | "deposit_final" | "installment" | "mixed";
  planItems: PlanItemView[];
  planTotalCents: number;
  planMatchesOrder: boolean;
  records: PaymentRecordView[];
  voidedRecords: PaymentRecordView[];
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
  refunds: RefundView[];
  voidedRefunds: RefundView[];
  refundTotalCents: number;
  /** 净到账 − 有效退款；允许为负（退款超过已记录到账）。 */
  netRetainedCents: number;
  /** 订单已取消：财务只读，但退款仍可管理。 */
  cancelled: boolean;
  /** 订单金额未知时为 null：不能拿 0 表示「已结清」。 */
  remainingCents: number | null;
  overReceivedCents: number;
  /** 既无计划也无流水：界面必须说「未记录收款信息」，而不是「未收款 0」。 */
  unrecorded: boolean;
  hasRecordsWithoutPlan: boolean;
};

export type PlanItemInput = {
  id?: string | null;
  kind: PlanItemView["kind"];
  amountCents: number;
  expectedDate: string | null;
};

export type CreateRecordInput = {
  orderId: string;
  scheduleId: string | null;
  kind: PaymentRecordView["kind"];
  amountCents: number;
  receivedOn: string;
  platformId: string | null;
  feeCents: number;
  method: string | null;
  note: string | null;
  requestId: string | null;
};

export type UpdateRecordInput = {
  id: string;
  scheduleId: string | null;
  kind: PaymentRecordView["kind"];
  amountCents: number;
  receivedOn: string;
  platformId: string | null;
  feeCents: number;
  method: string | null;
  note: string | null;
};

export const paymentsApi = {
  snapshot: (orderId: string) =>
    invoke<OrderFinanceView>("finance_order_snapshot", { orderId }),
  savePlan: (input: { orderId: string; items: PlanItemInput[]; confirmDetach: boolean }) =>
    invoke<OrderFinanceView>("finance_payment_plan_save", { input }),
  createRecord: (input: CreateRecordInput) =>
    invoke<PaymentRecordView>("finance_payment_record_create", { input }),
  updateRecord: (input: UpdateRecordInput) =>
    invoke<PaymentRecordView>("finance_payment_record_update", { input }),
  voidRecord: (input: { id: string; reason: string }) =>
    invoke<PaymentRecordView>("finance_payment_record_void", { input }),
  /** 预估手续费；费率为 null 时返回 null，界面必须让用户自己填实际手续费。 */
  quoteFee: (amountCents: number, feeRateBp: number | null) =>
    invoke<{ amountCents: number; feeRateBp: number | null; suggestedFeeCents: number | null }>(
      "finance_payment_fee_quote",
      { amountCents, feeRateBp },
    ),
};

export const refundsApi = {
  create: (input: {
    orderId: string;
    paymentRecordId: string | null;
    amountCents: number;
    refundedOn: string;
    method: string | null;
    note: string | null;
    requestId: string | null;
  }) => invoke<RefundView>("finance_refund_create", { input }),
  update: (input: {
    id: string;
    paymentRecordId: string | null;
    amountCents: number;
    refundedOn: string;
    method: string | null;
    note: string | null;
  }) => invoke<RefundView>("finance_refund_update", { input }),
  /** 退款错误时作废；不可恢复、不可物理删除。 */
  void: (input: { id: string; reason: string }) =>
    invoke<RefundView>("finance_refund_void", { input }),
};

// ---------------------------------------------------------------- FIN-05

export type MoneyTotals = {
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
  refundTotalCents: number;
  /** 净到账 − 退款；可以为负。 */
  netRetainedCents: number;
};

export type FinanceCurrentSnapshot = {
  remainingCents: number;
  overReceivedCents: number;
  unrecordedOrders: number;
  unknownAmountOrders: number;
  planMismatchOrders: number;
};

export type MonthCashFlow = {
  month: string;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
  refundTotalCents: number;
  netRetainedCents: number;
};

export type YearNetReceived = {
  year: string;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
};

export type ExpectedMonth = { month: string; amountCents: number; count: number };

export type ExpectedReceipts = {
  overdueCents: number;
  overdueCount: number;
  months: ExpectedMonth[];
  unscheduledCents: number;
  unscheduledCount: number;
  beyondCents: number;
  beyondCount: number;
  noPlanOrders: number;
};

export type PlatformRow = {
  platformName: string | null;
  count: number;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
};

export type MethodRow = {
  method: string | null;
  count: number;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
};

export type OrderTypeRow = {
  orderType: string | null;
  orders: number;
  orderAmountCents: number;
  unknownAmountOrders: number;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
  refundTotalCents: number;
  netRetainedCents: number;
};

export type ClientFinance = {
  clientId: string;
  displayName: string;
  orders: number;
  orderAmountCents: number;
  unknownAmountOrders: number;
  grossReceivedCents: number;
  feeTotalCents: number;
  netReceivedCents: number;
  refundTotalCents: number;
  netRetainedCents: number;
  remainingCents: number;
  overReceivedCents: number;
  unrecordedOrders: number;
};

export type FinanceStatsReport = {
  range: string;
  timezone: string;
  fromMonth: string;
  toMonth: string;
  lifetime: MoneyTotals;
  current: FinanceCurrentSnapshot;
  period: MoneyTotals;
  monthly: MonthCashFlow[];
  annual: YearNetReceived[];
  expected: ExpectedReceipts;
  byPlatform: PlatformRow[];
  byMethod: MethodRow[];
  byOrderType: OrderTypeRow[];
  /** 客户维度：累计口径，不随日期范围变化。 */
  byClient: ClientFinance[];
  basis: string[];
};

export const financeStatsApi = {
  /** 客户详情里的财务概览：与统计页共用同一份聚合。 */
  clientSummary: (clientId: string) =>
    invoke<ClientFinance>("finance_client_summary", { clientId }),
  /** 一次请求拿全部财务统计；前端不重算任何金额。 */
  report: (range: string) =>
    invoke<FinanceStatsReport>("finance_stats_report", { range }),
};
