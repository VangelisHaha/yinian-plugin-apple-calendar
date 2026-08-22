/**
 * 生成 iCalendar 文本（镜像方向用）。
 *
 * 只生成一念需要的最小属性集。两条硬要求：
 *
 * 1. **行必须以 CRLF 结束**（RFC 5545 §3.1）。用 `\n` 的话 iCloud 会接受但
 *    Apple 日历客户端解析结果不稳定，表现是事件时间随机偏移或干脆不显示。
 * 2. **超过 75 字节要折行**。中文标题两三个字就超，不折行时某些客户端会截断。
 */

import { escapeText } from "./ics.mjs";

export interface IcsEventInput {
  uid: string;
  summary: string;
  description?: string;
  /** `true` 时用 `startDate` / `endDate`（右开）。 */
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  /** `true` 写 `TRANSP:TRANSPARENT`，在 Apple 日历上不占忙时。 */
  transparent?: boolean;
  /** `LAST-MODIFIED`，用来让客户端知道这条更新过。 */
  lastModified?: string;
}

/** 一个 VEVENT 包成一个完整 VCALENDAR。CalDAV 的一个资源就是一个 VCALENDAR。 */
export function buildCalendar(event: IcsEventInput): string {
  const now = utcStamp(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yinian//Apple Calendar Plugin//CN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${now}`,
    `LAST-MODIFIED:${event.lastModified ? utcStamp(new Date(event.lastModified)) : now}`,
    `SUMMARY:${escapeText(event.summary)}`,
  ];

  if (event.allDay) {
    if (!event.startDate || !event.endDate) {
      throw new Error(`全天事件 ${event.uid} 缺 startDate / endDate`);
    }
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.startDate)}`);
    // 右开，与一念的 end_date 语义一致，不做加减
    lines.push(`DTEND;VALUE=DATE:${compactDate(event.endDate)}`);
  } else {
    if (!event.startAt || !event.endAt) {
      throw new Error(`定时事件 ${event.uid} 缺 startAt / endAt`);
    }
    // 一律写成 UTC：本插件不生成 VTIMEZONE，写 TZID 而不带定义是无效 ICS
    lines.push(`DTSTART:${utcStamp(new Date(event.startAt))}`);
    lines.push(`DTEND:${utcStamp(new Date(event.endAt))}`);
  }

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.transparent) lines.push("TRANSP:TRANSPARENT");

  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** `2026-08-20` → `20260820`。 */
function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

/** `Date` → `20260820T093000Z`。 */
export function utcStamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("无效时间，无法写入 ICS");
  }
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * 折行到 75 字节。
 *
 * 按**字节**而不是字符计数，但不能把一个 UTF-8 字符切两半——切开会让整条属性
 * 变成乱码。所以逐字符累加字节数，到界就断。
 */
export function fold(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;

  const parts: string[] = [];
  let buffer = "";
  let bytes = 0;
  // 续行前缀占 1 字节，所以续行的净容量是 74
  let limit = 75;

  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) {
      parts.push(buffer);
      buffer = "";
      bytes = 0;
      limit = 74;
    }
    buffer += char;
    bytes += size;
  }
  if (buffer) parts.push(buffer);

  return parts.join("\r\n ");
}
