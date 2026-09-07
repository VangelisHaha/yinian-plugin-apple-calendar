import { discoverAccount } from "../caldav/account.mjs";
/**
 * `sync.pull`：把 iCloud 日历拉进一念。
 *
 * event 资源是 **pull-only、远端权威**（契约 §5.1.1），所以这里只负责把数据交回
 * 宿主，冲突判定与落库全在宿主的 `services/sync_event.rs`。
 *
 * 增量策略分两种，选哪种由「有没有 sync-token」决定：
 *
 * | 情况 | 做法 | `eventsComplete` |
 * |---|---|---|
 * | 首轮 / 用户点全量 / token 失效 | `calendar-query` 按时间窗口拉 | `true` |
 * | 有 token | `sync-collection` 只拿改动 | **`false`** |
 *
 * `eventsComplete` 在增量轮次必须是 `false`。契约 §5.1.1 明说增量源开了它，宿主会
 * 把没出现在本次结果里的事件全判成远端删除——也就是每轮把历史事件集体标成取消。
 */

import { context, logger, setState } from "../sdk/index.mjs";
import {
  calendarQuery,
  syncCollection,
  type DavCalendar,
  type DavContext,
} from "../caldav/collection.mjs";
import { parseEvents } from "../caldav/ics.mjs";
import { type Config } from "../config.mjs";
import { mirrorSchedules } from "../mirror/sync.mjs";
import {
  toExternalCalendar,
  toExternalEvent,
  type ExternalCalendar,
  type ExternalEvent,
} from "../map.mjs";

/** 宿主的 `sync.pull` 入参（契约 §5.1）。 */
export interface PullRequest {
  integrationId: string;
  traceId: string;
  resource: string;
  cursor?: string | null;
  since?: string | null;
  full?: boolean;
  config?: unknown;
}

/** 宿主的 `sync.pull` 出参。 */
export interface PullPage {
  calendars: ExternalCalendar[];
  events: ExternalEvent[];
  eventsComplete: boolean;
  cursor?: string | null;
  hasMore: boolean;
  deletedExternalIds: string[];
  items: never[];
}

/**
 * 每个日历一份的同步状态。
 *
 * 存在 `host.setState` 里（契约 §4.4：进程随时会被重启，内存状态不可靠）。
 * key 是集合 URL。
 */
interface CalendarState {
  syncToken: string;
  /** 上次成功同步的时间，仅用于诊断。 */
  syncedAt: string;
}

type SyncState = Record<string, CalendarState>;

export async function pull(request: PullRequest): Promise<PullPage> {
  // 每次调用重新取上下文：进程会被重启并重放 plugin.init，
  // 缓存下来的是上一轮的配置（SDK 文档明确警告过）
  const ctx = context();
  const { config, dav, homeUrl, allCalendars } = await discoverAccount(
    request.config ?? ctx.config,
  );
  const calendars = selectCalendars(allCalendars, config);

  if (calendars.length === 0) {
    logger.warn("这个 Apple 账号下没有可同步的日历");
  }
  const previous = readState(ctx);
  const nextState: SyncState = {};
  const events: ExternalEvent[] = [];
  const deletedExternalIds: string[] = [];
  // 只有当**所有**日历都走了全量窗口，本次结果才算完整集合。任何一个日历走增量，
  // 整页就不能声明 complete——宿主是按 Integration 整体做清理判断的。
  let allFullScan = true;

  const { start, end } = windowFor(config);

  for (const calendar of calendars) {
    const token = request.full ? "" : (previous[calendar.url]?.syncToken ?? "");
    const outcome = token
      ? await incremental(dav, calendar, token)
      : await fullScan(dav, calendar, start, end);

    if (!outcome.complete) allFullScan = false;

    for (const raw of outcome.ics) {
      for (const parsed of parseEvents(raw)) {
        const mapped = toExternalEvent(parsed, {
          calendarExternalId: calendar.url,
          busyStatusOverride: config.busyStatusOverride,
          appleId: config.appleId,
        });
        if (mapped) events.push(mapped);
      }
    }

    // 增量里的删除是资源 URL，而 externalId 是 UID——两者对不上。所以只能靠
    // 宿主的 eventsComplete 机制清理，或者在这里放弃。取舍见 README 的「已知边界」。
    deletedExternalIds.push(...outcome.deletedExternalIds);

    nextState[calendar.url] = {
      syncToken: outcome.syncToken,
      syncedAt: new Date().toISOString(),
    };
  }

  // 每个日历一份 token。整个 state 就是这张表，序列化后远小于 64KB 上限
  setState({ integrationId: request.integrationId, state: nextState });

  // 镜像挂在拉取之后，**失败不影响拉取结果**：拉进来的日历数据已经算出来了，
  // 让镜像的一个 403 把它一起丢掉毫无道理。错误进插件日志，用户在诊断面板能看到。
  if (config.mirrorEnabled) {
    try {
      await mirrorSchedules({
        dav,
        host: {
          baseUrl: ctx.apiBaseUrl,
          token: ctx.apiToken,
          timeoutSeconds: config.timeoutSeconds,
        },
        homeUrl,
        calendars: allCalendars,
        calendarName: config.mirrorCalendarName,
        pastDays: config.mirrorPastDays,
        futureDays: config.mirrorFutureDays,
        includeDeadlines: config.mirrorIncludeDeadlines,
      });
    } catch (error) {
      logger.error(
        `排期镜像失败（本次拉取不受影响）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    calendars: calendars.map(toExternalCalendar),
    events,
    eventsComplete: allFullScan,
    cursor: null,
    hasMore: false,
    deletedExternalIds,
    items: [],
  };
}

interface PullOutcome {
  ics: string[];
  deletedExternalIds: string[];
  syncToken: string;
  /** `true` 表示这一轮拿到的是该日历在窗口内的完整集合。 */
  complete: boolean;
}

/** 全量窗口拉取，顺便拿一个 sync-token 供下轮增量。 */
async function fullScan(
  dav: DavContext,
  calendar: DavCalendar,
  start: Date,
  end: Date,
): Promise<PullOutcome> {
  const objects = await calendarQuery(dav, calendar.url, start, end);
  logger.info(`全量拉取「${calendar.displayName}」：${objects.length} 个条目`);
  return {
    ics: objects.map((object) => object.ics),
    deletedExternalIds: [],
    // PROPFIND 阶段就把 sync-token 一起取回来了，省一次请求
    syncToken: calendar.syncToken,
    complete: true,
  };
}

/** 增量拉取。token 失效时退回全量的判断交给调用方下一轮。 */
async function incremental(
  dav: DavContext,
  calendar: DavCalendar,
  token: string,
): Promise<PullOutcome> {
  const result = await syncCollection(dav, calendar.url, token);
  if (!result.syncToken) {
    // 服务端不支持或 token 过期。清空 token，下一轮自然走全量。
    logger.warn(
      `「${calendar.displayName}」的增量同步不可用，下一轮将回退到全量`,
    );
    return {
      ics: [],
      deletedExternalIds: [],
      syncToken: "",
      complete: false,
    };
  }

  logger.debug(
    `增量拉取「${calendar.displayName}」：${result.objects.length} 变更 / ${result.deletedUrls.length} 删除`,
  );
  return {
    ics: result.objects.map((object) => object.ics),
    deletedExternalIds: [],
    syncToken: result.syncToken,
    complete: false,
  };
}

/** 决定同步哪些日历。纯筛选，发现由调用方做。 */
export function selectCalendars(
  all: DavCalendar[],
  config: Config,
): DavCalendar[] {
  if (config.calendars.length === 0) {
    // 镜像日历自己不该被拉回来：它里面的内容本来就是一念的排期，
    // 再拉进来会变成「排期块 + 一条同名事件」双份。
    return all.filter((calendar) => !isMirrorCalendar(calendar, config));
  }
  const wanted = new Set(config.calendars);
  return all.filter((calendar) => wanted.has(calendar.url));
}

export function isMirrorCalendar(
  calendar: DavCalendar,
  config: Config,
): boolean {
  return (
    calendar.url.includes("yinian-schedule-mirror") ||
    calendar.displayName === config.mirrorCalendarName
  );
}

/** 时间窗口。以本地当天 00:00 为基准，避免窗口边界随同步时刻漂移。 */
export function windowFor(
  config: Pick<Config, "pastDays" | "futureDays">,
  now = new Date(),
): { start: Date; end: Date } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    start: new Date(midnight.getTime() - config.pastDays * 86_400_000),
    end: new Date(midnight.getTime() + config.futureDays * 86_400_000),
  };
}

function readState(ctx: { state?: Record<string, unknown> }): SyncState {
  const stored = ctx.state;
  if (!stored || typeof stored !== "object") return {};
  const state: SyncState = {};
  for (const [url, value] of Object.entries(
    stored as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") continue;
    const token = (value as { syncToken?: unknown }).syncToken;
    if (typeof token !== "string") continue;
    state[url] = {
      syncToken: token,
      syncedAt:
        typeof (value as { syncedAt?: unknown }).syncedAt === "string"
          ? (value as { syncedAt: string }).syncedAt
          : "",
    };
  }
  return state;
}

function emptyPage(): PullPage {
  return {
    calendars: [],
    events: [],
    // 空结果绝不能声明完整：那等于让宿主把该 Integration 下所有事件标成取消
    eventsComplete: false,
    cursor: null,
    hasMore: false,
    deletedExternalIds: [],
    items: [],
  };
}
