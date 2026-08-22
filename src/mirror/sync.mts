/**
 * 排期镜像的执行：把投影结果对账到 Apple 日历上。
 *
 * 对账而不是「清空重建」：清空重建每轮都会让 iPhone 上的日历闪一下（所有事件先消失
 * 再出现），还会把通知重新推一遍。所以按 UID 比对，只动真正变了的。
 *
 * **只删自己写的**。集合里出现前缀不匹配的资源就不碰——用户可能手动往这个日历里
 * 加了东西，插件没有资格替他删。
 */

import {
  deleteObject,
  listObjectEtags,
  makeCalendar,
  putObject,
  type DavCalendar,
  type DavContext,
} from "../caldav/collection.mjs";
import { buildCalendar } from "../caldav/write.mjs";
import { logger } from "../sdk/index.mjs";
import { fetchAgenda, type HostApiOptions } from "../host.mjs";
import {
  isMirrorUid,
  project,
  resourceNameFor,
  type MirrorEvent,
} from "./project.mjs";

export interface MirrorOptions {
  dav: DavContext;
  host: HostApiOptions;
  /** iCloud 的 calendar-home-set，用于必要时新建镜像日历。 */
  homeUrl: string;
  /** 已发现的日历，用来找现成的镜像日历。 */
  calendars: DavCalendar[];
  calendarName: string;
  pastDays: number;
  futureDays: number;
  includeDeadlines: boolean;
}

export interface MirrorReport {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  calendarUrl: string;
}

export async function mirrorSchedules(
  options: MirrorOptions,
): Promise<MirrorReport> {
  const calendarUrl = await ensureMirrorCalendar(options);
  const { start, end } = mirrorWindow(options);

  const agenda = await fetchAgenda(options.host, start, end);
  const desired = project(agenda, {
    includeDeadlines: options.includeDeadlines,
  });

  const existing = await listObjectEtags(options.dav, calendarUrl);
  const report: MirrorReport = {
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    calendarUrl,
  };

  const desiredByName = new Map<string, MirrorEvent>();
  for (const event of desired) {
    desiredByName.set(resourceNameFor(event.uid), event);
  }

  // 先删多余的：留着的话下面写入时可能撞上 iCloud 的集合大小限制
  for (const object of existing) {
    const name = decodeURIComponent(object.url.split("/").pop() ?? "");
    if (!name) continue;
    if (!isMirrorUid(name.replace(/\.ics$/i, ""))) {
      // 不是本插件写的，一律不碰
      report.skipped += 1;
      continue;
    }
    if (desiredByName.has(name)) continue;
    await deleteObject(options.dav, object.url);
    report.deleted += 1;
  }

  const existingNames = new Set(
    existing.map((object) =>
      decodeURIComponent(object.url.split("/").pop() ?? ""),
    ),
  );

  for (const [name, event] of desiredByName) {
    // 每轮都整条 PUT，不做「内容有没有变」的比较：比较需要先 GET 回正文，
    // 那是一次额外的往返，而 PUT 一条几百字节的 ICS 更便宜。
    await putObject(
      options.dav,
      `${calendarUrl}${encodeURIComponent(name)}`,
      buildCalendar(event),
    );
    if (existingNames.has(name)) report.updated += 1;
    else report.created += 1;
  }

  logger.info(
    `排期镜像：新增 ${report.created}、更新 ${report.updated}、删除 ${report.deleted}${
      report.skipped > 0 ? `，跳过 ${report.skipped} 个非本插件写入的条目` : ""
    }`,
  );
  return report;
}

/**
 * 找到（或创建）镜像日历。
 *
 * 优先按固定路径 slug 认，其次按名字。都没有才建——按名字建重复日历是这类插件
 * 最常见的抱怨来源。
 */
async function ensureMirrorCalendar(options: MirrorOptions): Promise<string> {
  const bySlug = options.calendars.find((calendar) =>
    calendar.url.includes("yinian-schedule-mirror"),
  );
  if (bySlug) return bySlug.url;

  const byName = options.calendars.find(
    (calendar) => calendar.displayName === options.calendarName,
  );
  if (byName) {
    if (byName.readOnly) {
      throw new Error(
        `日历「${options.calendarName}」是只读的，无法写入排期镜像。请换一个名字`,
      );
    }
    return byName.url;
  }

  logger.info(`在 iCloud 上创建镜像日历「${options.calendarName}」`);
  return makeCalendar(options.dav, options.homeUrl, options.calendarName);
}

/** 镜像窗口。与拉取窗口分开配：镜像通常只关心最近，拉取要覆盖更远。 */
export function mirrorWindow(
  options: Pick<MirrorOptions, "pastDays" | "futureDays">,
  now = new Date(),
): { start: Date; end: Date } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    start: new Date(midnight.getTime() - options.pastDays * 86_400_000),
    end: new Date(midnight.getTime() + options.futureDays * 86_400_000),
  };
}
