/**
 * 配置读取与规范化。
 *
 * 宿主已经按 schema 做过形状校验（契约 §7.4 的第一层闸门），所以这里不重复校验
 * 类型与范围，只做两件事：把插件级与实例级配置合成一个类型化对象，以及给
 * 宿主校验不到的东西（凭据是否真的能登进去）留出口。
 */

export interface PluginConfig {
  appleId: string;
  appPassword: string;
  timeoutSeconds: number;
}

export interface IntegrationConfig {
  /** 要同步的日历 URL；空表示全部。 */
  calendars: string[];
  pastDays: number;
  futureDays: number;
  busyStatusOverride: "source" | "free";
  mirrorEnabled: boolean;
  mirrorCalendarName: string;
  mirrorPastDays: number;
  mirrorFutureDays: number;
  mirrorIncludeDeadlines: boolean;
}

export type Config = PluginConfig & IntegrationConfig;

/**
 * 从宿主下发的配置里取值。
 *
 * `sync.pull` 的 `config` 是插件级与实例级**合并后**的结果（契约 §5.1），所以
 * 一次就能取全。分组字段（`windowGroup` / `mirrorGroup`）在宿主那侧是扁平提交的，
 * 但为了不依赖这个实现细节，两种形态都认。
 */
export function readConfig(raw: unknown): Config {
  const source = flatten(raw);
  return {
    appleId: text(source.appleId),
    appPassword: text(source.appPassword),
    timeoutSeconds: integer(source.httpTimeoutSeconds, 20, 5, 60),

    calendars: list(source.calendars),
    pastDays: integer(source.pastDays, 30, 0, 730),
    futureDays: integer(source.futureDays, 180, 1, 730),
    busyStatusOverride: source.busyStatusOverride === "free" ? "free" : "source",

    mirrorEnabled: source.mirrorEnabled === true,
    mirrorCalendarName: text(source.mirrorCalendarName) || "一念 · 排期",
    mirrorPastDays: integer(source.mirrorPastDays, 7, 0, 90),
    mirrorFutureDays: integer(source.mirrorFutureDays, 60, 1, 365),
    mirrorIncludeDeadlines: source.mirrorIncludeDeadlines === true,
  };
}

/** 凭据缺失时给一句人能看懂的话，而不是让 CalDAV 回一个 401。 */
export function missingCredentialFields(
  config: Config,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  if (!config.appleId) {
    errors.push({ field: "appleId", message: "请填写 Apple 账号邮箱" });
  } else if (!config.appleId.includes("@")) {
    errors.push({ field: "appleId", message: "Apple 账号应该是一个邮箱地址" });
  }
  if (!config.appPassword) {
    errors.push({
      field: "appPassword",
      message: "请填写 App 专用密码（不是 Apple 账号本身的密码）",
    });
  } else if (config.appPassword.replace(/[\s-]/g, "").length !== 16) {
    // Apple 生成的 App 专用密码固定 16 位。长度不对基本可以断定填成了账号密码，
    // 而那个错误在 CalDAV 那边只会回一个 401，没人能猜到是这个原因。
    errors.push({
      field: "appPassword",
      message:
        "App 专用密码是 16 位（Apple 显示成 xxxx-xxxx-xxxx-xxxx）。看起来填的是 Apple 账号密码",
    });
  }
  return errors;
}

/** 把一层分组展平，同时保留顶层字段。 */
function flatten(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        flat[inner] = innerValue;
      }
      continue;
    }
    flat[key] = value;
  }
  return flat;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
