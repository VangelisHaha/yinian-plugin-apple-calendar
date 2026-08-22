/**
 * 启用闸门与设置面板上的按钮。
 *
 * `config.validate` 是契约 §7.4 的第二层闸门。宿主已经查过必填与类型，这里只回答
 * 宿主查不到的问题：**这份凭据能不能真的登进 iCloud**。
 */

import { logger, type PluginContext } from "../sdk/index.mjs";
import {
  discoverCalendarHome,
  discoverPrincipal,
  listCalendars,
  type DavContext,
} from "../caldav/collection.mjs";
import { missingCredentialFields, readConfig } from "../config.mjs";

interface ValidateRequest {
  scope?: "plugin" | "integration";
  config?: unknown;
}

interface FieldError {
  field: string;
  message: string;
}

interface ValidateResult {
  ok: boolean;
  errors?: FieldError[];
}

interface ActionRequest {
  config?: unknown;
}

export async function validate(
  request: ValidateRequest,
): Promise<ValidateResult> {
  const config = readConfig(request.config);

  const missing = missingCredentialFields(config);
  if (missing.length > 0) return { ok: false, errors: missing };

  // 实例级校验不再打一次网络：凭据是插件级的，插件级那一轮已经验过。
  // 每次改实例配置都去连一次 iCloud 只会让「改个窗口天数」等好几秒。
  if (request.scope === "integration") return { ok: true };

  try {
    const dav: DavContext = {
      credentials: {
        appleId: config.appleId,
        appPassword: config.appPassword,
      },
      timeoutSeconds: config.timeoutSeconds,
    };
    const principal = await discoverPrincipal(dav);
    const home = await discoverCalendarHome(dav, principal);
    const calendars = await listCalendars(dav, home);
    logger.info(`凭据校验通过，发现 ${calendars.length} 个日历`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 归到 appPassword 上：99% 的失败是密码填错或填成了账号密码，
    // 挂在整体错误上用户不知道该改哪一栏
    return { ok: false, errors: [{ field: "appPassword", message }] };
  }
}

/** 设置面板的「测试连接」。 */
export async function testConnection(
  request: ActionRequest,
): Promise<{ message: string }> {
  const config = readConfig(request.config);
  const missing = missingCredentialFields(config);
  if (missing.length > 0) {
    return { message: missing.map((error) => error.message).join("；") };
  }

  const dav: DavContext = {
    credentials: { appleId: config.appleId, appPassword: config.appPassword },
    timeoutSeconds: config.timeoutSeconds,
  };

  try {
    const principal = await discoverPrincipal(dav);
    const home = await discoverCalendarHome(dav, principal);
    const calendars = await listCalendars(dav, home);
    if (calendars.length === 0) {
      return { message: "连接成功，但这个账号下没有日历。" };
    }
    const names = calendars
      .slice(0, 8)
      .map((calendar) => calendar.displayName)
      .join("、");
    const suffix = calendars.length > 8 ? ` 等 ${calendars.length} 个` : "";
    return { message: `连接成功，发现日历：${names}${suffix}` };
  } catch (error) {
    return {
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 实例设置里「同步哪些日历」的选项来源（契约 §7.3 的 `optionsFrom: rpc:*`）。
 *
 * `value` 用集合 URL，不用显示名：用户在 Apple 日历里改个名字，按名字存的配置
 * 就指向不存在的日历了，而且症状是「同步突然什么都拉不到」，极难联想到原因。
 */
export async function listCalendarOptions(
  request: ActionRequest,
): Promise<{ options: Array<{ value: string; label: string }> }> {
  const config = readConfig(request.config);
  if (missingCredentialFields(config).length > 0) return { options: [] };

  const dav: DavContext = {
    credentials: { appleId: config.appleId, appPassword: config.appPassword },
    timeoutSeconds: config.timeoutSeconds,
  };

  try {
    const principal = await discoverPrincipal(dav);
    const home = await discoverCalendarHome(dav, principal);
    const calendars = await listCalendars(dav, home);
    return {
      options: calendars
        // 镜像日历不列进来：选它同步等于把一念自己的排期再拉回一念
        .filter((calendar) => !calendar.url.includes("yinian-schedule-mirror"))
        .map((calendar) => ({
          value: calendar.url,
          label: calendar.readOnly
            ? `${calendar.displayName}（只读）`
            : calendar.displayName,
        })),
    };
  } catch (error) {
    logger.warn(
      `列出日历失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { options: [] };
  }
}

/** 诊断用：把当前状态摘要打进日志，方便排查「为什么没同步到」。 */
export function describeContext(context: PluginContext): string {
  return [
    `pluginId=${context.pluginId}`,
    `integrationId=${context.integrationId ?? "-"}`,
    `apiToken=${context.apiToken ? "已下发" : "未下发"}`,
    `devMode=${context.devMode}`,
  ].join(" ");
}
