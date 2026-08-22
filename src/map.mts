/**
 * CalDAV 事件 → 一念 `ExternalEvent`（契约 §5.1.1）。
 *
 * 只做字段映射，不碰网络也不做时间窗口过滤——那样才好用单测覆盖各种 ICS 边界。
 */

import type { IcsEvent } from "./caldav/ics.mjs";
import type { DavCalendar } from "./caldav/collection.mjs";

/** 契约 §5.1.1 的 ExternalCalendar。 */
export interface ExternalCalendar {
  externalId: string;
  name: string;
}

/** 契约 §5.1.1 的 ExternalEvent。 */
export interface ExternalEvent {
  externalId: string;
  calendarExternalId?: string;
  title: string;
  notes?: string;
  status?: "active" | "canceled";
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  busyStatus?: "busy" | "tentative" | "free";
  responseStatus?: "needs_action" | "accepted" | "declined" | "tentative";
  isOrganizer: boolean;
  recurrenceRule?: string;
  remoteUpdatedAt?: string;
  remoteData?: Record<string, unknown>;
  details?: Array<{ label: string; value: string; kind?: "text" | "link" }>;
}

/** 日历集合 → 一念的日历容器。用集合 URL 当 externalId：改名不会让它变成新日历。 */
export function toExternalCalendar(calendar: DavCalendar): ExternalCalendar {
  return { externalId: calendar.url, name: calendar.displayName };
}

export interface MapOptions {
  calendarExternalId: string;
  /** `free` 时无视 ICS 的 TRANSP，一律标空闲。 */
  busyStatusOverride: "source" | "free";
  /** 当前用户的 Apple 账号，用来判断是不是组织者。 */
  appleId: string;
}

/**
 * 映射一个事件。
 *
 * `externalId` 的构造是这里唯一需要想清楚的事：
 *
 * - 普通事件用 `UID`。
 * - **重复事件的例外实例**（带 `RECURRENCE-ID`）与主事件共享同一个 `UID`，
 *   直接用 UID 会让它们互相覆盖，最后只剩一条。所以拼上 `RECURRENCE-ID`。
 *   这与契约 §5.1.1 说的「一条外部记录可以产多个事件时自己拼稳定后缀」同一个道理，
 *   而且**不能用序号**——顺序一变全错位。
 */
export function toExternalEvent(
  event: IcsEvent,
  options: MapOptions,
): ExternalEvent | null {
  const title = event.summary.trim();
  // 标题为空的事件宿主会判形状错误整条丢掉。给一个占位比丢掉好：用户在 Apple
  // 日历上确实建了一条无标题事件，让它在一念里也看得见。
  const safeTitle = title || "（无标题）";

  const mapped: ExternalEvent = {
    externalId: event.recurrenceId
      ? `${event.uid}::${event.recurrenceId}`
      : event.uid,
    calendarExternalId: options.calendarExternalId,
    title: safeTitle,
    allDay: event.allDay,
    status: event.cancelled ? "canceled" : "active",
    isOrganizer: isOrganizer(event, options.appleId),
    busyStatus:
      options.busyStatusOverride === "free"
        ? "free"
        : event.transparent
          ? "free"
          : "busy",
    responseStatus: toResponseStatus(event.partStat),
  };

  if (event.allDay) {
    if (!event.startDate || !event.endDate) return null;
    mapped.startDate = event.startDate;
    mapped.endDate = event.endDate;
  } else {
    if (!event.startAt || !event.endAt) return null;
    mapped.startAt = event.startAt;
    mapped.endAt = event.endAt;
  }

  if (event.description) mapped.notes = event.description;
  if (event.location) mapped.location = event.location;
  if (event.recurrenceRule) mapped.recurrenceRule = event.recurrenceRule;
  if (event.lastModified) mapped.remoteUpdatedAt = event.lastModified;

  const details = buildDetails(event);
  if (details.length > 0) mapped.details = details;

  mapped.remoteData = {
    uid: event.uid,
    ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
    ...(event.organizer ? { organizer: event.organizer } : {}),
    ...(event.partStat ? { partStat: event.partStat } : {}),
    transparent: event.transparent,
  };

  return mapped;
}

/**
 * 判断是不是自己组织的。
 *
 * ICS 的 `ORGANIZER` 是邮箱，而 Apple 账号可能有多个别名（`@icloud.com` /
 * `@me.com` / 自定义域名），所以只能做「相等则是、其余则不是」的保守判断。
 * 拿不准时返回 `false`——契约说同步来的事件缺省不是你组织的。
 */
function isOrganizer(event: IcsEvent, appleId: string): boolean {
  if (!event.organizer || !appleId) return false;
  return event.organizer.toLowerCase() === appleId.toLowerCase();
}

function toResponseStatus(
  partStat: string,
): NonNullable<ExternalEvent["responseStatus"]> {
  switch (partStat) {
    case "ACCEPTED":
      return "accepted";
    case "DECLINED":
      return "declined";
    case "TENTATIVE":
      return "tentative";
    case "NEEDS-ACTION":
      return "needs_action";
    default:
      // 没有 ATTENDEE 的事件（自己建的、订阅来的）就是已接受
      return "accepted";
  }
}

/**
 * 「来源」区的展示字段。
 *
 * 只放一念主模型装不下、但看事件时确实想知道的东西。不放 UID 之类的技术标识——
 * 那是给插件看的，已经在 `remoteData` 里。
 */
function buildDetails(
  event: IcsEvent,
): Array<{ label: string; value: string; kind?: "text" | "link" }> {
  const details: Array<{
    label: string;
    value: string;
    kind?: "text" | "link";
  }> = [];
  if (event.organizer) {
    details.push({ label: "组织者", value: event.organizer });
  }
  if (event.recurrenceRule) {
    details.push({ label: "重复规则", value: event.recurrenceRule });
  }
  if (event.recurrenceId) {
    details.push({ label: "重复事件的单次调整", value: event.recurrenceId });
  }
  return details;
}
