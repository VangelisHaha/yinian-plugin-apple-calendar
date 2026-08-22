/**
 * 启用闸门与设置面板上的按钮。
 *
 * `config.validate` 是契约 §7.4 的第二层闸门。宿主已经查过必填与类型，这里只回答
 * 宿主查不到的问题：**这份凭据能不能真的登进 iCloud**。
 */

import { logger, type PluginContext } from "../sdk/index.mjs";
import { TIMEOUTS } from "../sdk/index.mjs";
import {
  deleteObject,
  discoverCalendarHome,
  discoverPrincipal,
  listCalendars,
  makeCalendar,
  putObject,
  type DavContext,
} from "../caldav/collection.mjs";
import { buildCalendar } from "../caldav/write.mjs";
import { Budget } from "../budget.mjs";
import { missingCredentialFields, readConfig } from "../config.mjs";

/** action 的硬超时，取 SDK 的常量而不是自己写 15000。 */
const ACTION_TIMEOUT_MS = TIMEOUTS.custom ?? 15_000;

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

/**
 * 「去生成 App 专用密码」。
 *
 * 插件画不了界面，只能靠 action 的 `openUrl` 让宿主用系统浏览器打开
 * （契约 §7.3）。不这么做的话，用户得自己记住「account.apple.com → 登录与安全
 * → App 专用密码」这条路径——而这是启用本插件的第一步，卡在这里等于装不上。
 */
export function openAppleAccount(): {
  message: string;
  openUrl: string;
} {
  return {
    openUrl: "https://account.apple.com",
    message:
      "已打开 Apple 账号页。登录后进「登录与安全」→「App 专用密码」→「生成 App 专用密码」，" +
      "起个名字（比如「一念日历」）即可。生成的 16 位密码**只显示一次**，请直接复制粘贴到上面那一栏。" +
      "看不到这个入口说明账号还没开双重认证，需要先开。",
  };
}

/**
 * 「测试镜像写入」。
 *
 * 与「测试连接」刻意分成两个按钮：读通不代表写得进去。`MKCALENDAR` 在某些
 * Apple 账号上会被拒（企业管理的账号、家庭共享的受限成员），而这决定了排期镜像
 * 能不能自己建日历。让用户在**打开镜像开关之前**就知道，而不是等到第一次同步
 * 之后去插件日志里找一条 403。
 *
 * 全程按预算走：6 次往返顶不住 15 秒硬超时时提前返回部分结论。
 */
export async function testMirrorWrite(
  request: ActionRequest,
): Promise<{ message: string }> {
  const config = readConfig(request.config);
  const missing = missingCredentialFields(config);
  if (missing.length > 0) {
    return {
      message: `请先填好凭据：${missing.map((error) => error.message).join("；")}`,
    };
  }

  const budget = new Budget(ACTION_TIMEOUT_MS);
  const credentials = {
    appleId: config.appleId,
    appPassword: config.appPassword,
  };
  const step = (preferred = 4): DavContext => ({
    credentials,
    timeoutSeconds: budget.stepTimeout(preferred),
  });

  const done: string[] = [];
  try {
    const principal = await discoverPrincipal(step());
    const home = await discoverCalendarHome(step(), principal);
    const calendars = await listCalendars(step(), home);
    done.push(`读取正常（${calendars.length} 个日历）`);

    const existing = calendars.find(
      (calendar) =>
        calendar.url.includes("yinian-schedule-mirror") ||
        calendar.displayName === config.mirrorCalendarName,
    );

    if (existing?.readOnly) {
      return {
        message: `${done.join("；")}。但日历「${existing.displayName}」是只读的，写不进去——请把「镜像日历名称」改成一个别的名字。`,
      };
    }

    if (!budget.canContinue()) {
      return {
        message: `${done.join("；")}。iCloud 响应偏慢，写入没测完，请再点一次。`,
      };
    }

    let calendarUrl: string;
    if (existing) {
      calendarUrl = existing.url;
      done.push(`复用已有日历「${existing.displayName}」`);
    } else {
      calendarUrl = await makeCalendar(
        step(),
        home,
        config.mirrorCalendarName,
      );
      done.push(`成功创建日历「${config.mirrorCalendarName}」`);
    }

    if (!budget.canContinue()) {
      return {
        message: `${done.join("；")}。写入单条事件没测完，请再点一次。`,
      };
    }

    // 用固定 UID：反复点这个按钮不会在日历里堆一串测试事件
    const uid = "yinian-mirror-selftest";
    const resource = `${calendarUrl}${uid}.ics`;
    const startAt = new Date(Date.now() + 3_600_000).toISOString();
    await putObject(
      step(),
      resource,
      buildCalendar({
        uid,
        summary: "一念 · 写入自检（会自动删除）",
        description: "这条由「测试镜像写入」生成，随后会被删掉。",
        allDay: false,
        startAt,
        endAt: new Date(Date.parse(startAt) + 1_800_000).toISOString(),
        transparent: true,
      }),
    );
    done.push("写入单条事件成功");

    if (budget.canContinue()) {
      await deleteObject(step(2), resource);
      done.push("清理成功");
    } else {
      done.push(
        "但没来得及清理，日历里会留一条「一念 · 写入自检」，可以手动删掉",
      );
    }

    return {
      message: `排期镜像可用。${done.join("；")}。`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const prefix = done.length > 0 ? `${done.join("；")}。` : "";
    return {
      message:
        `${prefix}写入失败：${reason}\n\n` +
        "如果失败在创建日历这一步，说明这个 Apple 账号不允许新建日历。" +
        "解决办法：先在 Mac 或 iPhone 的日历 App 里手工建一个 iCloud 日历，" +
        "再把上面的「镜像日历名称」改成它的名字。",
    };
  }
}
