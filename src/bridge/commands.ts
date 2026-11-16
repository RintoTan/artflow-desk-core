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

export type Order = {
  id: string;
  code: string;
  title: string;
  clientId: string | null;
  commissionType: string | null;
  amountCents: number | null;
  status: "active" | "complete" | "cancelled";
  currentStageId: string | null;
  currentStageTitle: string | null;
  queuePosition: number;
  plannedStartDate: string | null;
  plannedDeliveryDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateOrderInput = {
  title: string;
  clientId?: string | null;
  commissionType?: string | null;
  amountCents?: number | null;
  plannedStartDate?: string | null;
  plannedDeliveryDate?: string | null;
  templateId?: string | null;
  requestId?: string | null;
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

export const api = {
  status: () => invoke<EnvironmentStatus>("environment_status"),
  timezoneGet: () => invoke<TimezoneInfo>("working_timezone_get"),
  timezoneSet: (timezoneName: string) =>
    invoke<TimezoneInfo>("working_timezone_set", { timezoneName }),
  createOrder: (input: CreateOrderInput) => invoke<Order>("create_order", { input }),
};
