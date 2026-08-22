/**
 * iCalendar（RFC 5545）读写。只处理 `VEVENT`，够本插件用。
 *
 * 四个必须做对的地方，每一个都踩过或看别人踩过：
 *
 * 1. **unfold 要先做**。ICS 每行不超过 75 字节，超了就折行，续行以空格或制表符开头。
 *    不先合行的话，一个长标题会被截成两半，后半截还会被当成未知属性丢掉。
 * 2. **`DTEND` 是右开的**，一念的全天事件 `end_date` 也是右开——正好对上，
 *    **不要自己减一天**。只占 8/20 一天的全天事件，ICS 里就是
 *    `DTSTART;VALUE=DATE:20260820` / `DTEND;VALUE=DATE:20260821`。
 * 3. **全天缺 `DTEND`** 时按「一天」补（`DTSTART` + 1 天）；定时缺 `DTEND` 时
 *    先看 `DURATION`，再退回与 `DTSTART` 相同（零长事件）。
 * 4. **`TZID` 要真的换算**。带 `TZID=Asia/Shanghai` 的本地时间不带偏移量，
 *    直接当 UTC 解会整体差 8 小时。用 `Intl` 反解偏移，不引 tzdata 依赖。
 */

/** 一条已解析的 ICS 属性。 */
export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** 一个 VEVENT。 */
export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** `true` 时用 `startDate` / `endDate`；否则用 `startAt` / `endAt`。 */
  allDay: boolean;
  /** RFC3339（含偏移量）。 */
  startAt?: string;
  endAt?: string;
  /** `YYYY-MM-DD`，`endDate` **右开**。 */
  startDate?: string;
  endDate?: string;
  /** `CANCELLED` → 取消。 */
  cancelled: boolean;
  /** `TRANSP:TRANSPARENT` → 空闲。 */
  transparent: boolean;
  /** `PARTSTAT` 的原始取值，如 `ACCEPTED`。 */
  partStat: string;
  /** RRULE 原文，原样透传给一念。 */
  recurrenceRule?: string;
  /** `RECURRENCE-ID` 存在说明这是重复事件的一个例外实例。 */
  recurrenceId?: string;
  /** `LAST-MODIFIED` 或 `DTSTAMP`，RFC3339。 */
  lastModified?: string;
  /** 组织者邮箱（去掉 `mailto:`）。 */
  organizer: string;
}

/** 解析失败的原因。整条跳过，不让一条坏数据毁掉整次同步。 */
export class IcsError extends Error {}

/**
 * 从一段 ICS 文本里取出所有 VEVENT。
 *
 * 一个资源里可能有多个 VEVENT（重复事件 + 它的例外实例），所以返回数组。
 */
export function parseEvents(source: string): IcsEvent[] {
  const lines = unfold(source);
  const events: IcsEvent[] = [];
  let current: IcsProperty[] | null = null;
  /** VEVENT 内部的嵌套块深度（VALARM 等）。>0 时属性不收。 */
  let nested = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (current === null) {
      if (upper === "BEGIN:VEVENT") {
        current = [];
        nested = 0;
      }
      continue;
    }

    // VEVENT 里的嵌套块：VALARM 的 SUMMARY / DESCRIPTION 会盖掉事件自己的，必须隔离
    if (upper.startsWith("BEGIN:")) {
      nested += 1;
      continue;
    }
    if (upper.startsWith("END:")) {
      if (nested > 0) {
        nested -= 1;
        continue;
      }
      // nested === 0 时这条 END 就是 END:VEVENT
      const event = buildEvent(current);
      if (event) events.push(event);
      current = null;
      continue;
    }

    if (nested === 0) current.push(parseProperty(line));
  }

  return events;
}

/**
 * 合并折行。
 *
 * RFC 5545 §3.1：续行以单个空格或制表符开头，去掉那个字符后与上一行相接。
 */
export function unfold(source: string): string[] {
  const raw = source.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
      continue;
    }
    if (line.trim()) lines.push(line);
  }
  return lines;
}

/** `NAME;PARAM=VAL:value` → 结构。 */
export function parseProperty(line: string): IcsProperty {
  const colon = findValueColon(line);
  const head = colon === -1 ? line : line.slice(0, colon);
  const value = colon === -1 ? "" : line.slice(colon + 1);

  const parts = splitParams(head);
  const name = (parts.shift() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    params[part.slice(0, equals).toUpperCase()] = stripQuotes(
      part.slice(equals + 1),
    );
  }

  return { name, params, value: unescapeText(value) };
}

/**
 * 找到分隔名字与值的冒号。
 *
 * 不能直接 `indexOf(':')`：参数值可以带引号且引号里能有冒号
 * （`ORGANIZER;CN="Ops: Team":mailto:x@y`）。
 */
function findValueColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) return index;
  }
  return -1;
}

function splitParams(head: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let buffer = "";
  for (const char of head) {
    if (char === '"') {
      quoted = !quoted;
      buffer += char;
    } else if (char === ";" && !quoted) {
      parts.push(buffer);
      buffer = "";
    } else buffer += char;
  }
  if (buffer) parts.push(buffer);
  return parts;
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** RFC 5545 §3.3.11 的转义。 */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildEvent(properties: IcsProperty[]): IcsEvent | null {
  const pick = (name: string) =>
    properties.find((property) => property.name === name);

  const uid = pick("UID")?.value.trim();
  const dtStart = pick("DTSTART");
  // UID 是外部主键，没有它宿主没法去重也没法认出「同一条改了」。整条跳过。
  if (!uid || !dtStart) return null;

  const allDay =
    dtStart.params.VALUE?.toUpperCase() === "DATE" ||
    /^\d{8}$/.test(dtStart.value.trim());

  const event: IcsEvent = {
    uid,
    summary: pick("SUMMARY")?.value.trim() ?? "",
    description: pick("DESCRIPTION")?.value.trim() ?? "",
    location: pick("LOCATION")?.value.trim() ?? "",
    allDay,
    cancelled: (pick("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
    transparent: (pick("TRANSP")?.value ?? "").toUpperCase() === "TRANSPARENT",
    partStat: (pick("ATTENDEE")?.params.PARTSTAT ?? "").toUpperCase(),
    organizer: (pick("ORGANIZER")?.value ?? "").replace(/^mailto:/i, "").trim(),
  };

  const rrule = pick("RRULE")?.value.trim();
  if (rrule) event.recurrenceRule = rrule;
  const recurrenceId = pick("RECURRENCE-ID")?.value.trim();
  if (recurrenceId) event.recurrenceId = recurrenceId;

  const modified = pick("LAST-MODIFIED") ?? pick("DTSTAMP");
  if (modified) {
    const stamp = toRfc3339(modified);
    if (stamp) event.lastModified = stamp;
  }

  if (allDay) {
    const start = parseDateOnly(dtStart.value);
    if (!start) return null;
    event.startDate = start;
    const dtEnd = pick("DTEND");
    // DTEND 已经是右开，与一念的 end_date 语义相同，直接用
    event.endDate = dtEnd
      ? (parseDateOnly(dtEnd.value) ?? addDays(start, 1))
      : addDays(start, 1);
    // 反了的话（远端数据坏）退回一天，不要产生负长度事件
    if (event.endDate <= event.startDate) event.endDate = addDays(start, 1);
  } else {
    const start = toRfc3339(dtStart);
    if (!start) return null;
    event.startAt = start;
    const dtEnd = pick("DTEND");
    const duration = pick("DURATION");
    event.endAt =
      (dtEnd ? toRfc3339(dtEnd) : undefined) ??
      (duration ? applyDuration(start, duration.value) : undefined) ??
      start;
    // 一念要求 end 晚于 start；零长事件补 15 分钟，否则会被判成形状错误整条丢掉
    if (Date.parse(event.endAt) <= Date.parse(event.startAt)) {
      event.endAt = new Date(Date.parse(event.startAt) + 15 * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    }
  }

  return event;
}

/** `20260820` → `2026-08-20`。 */
function parseDateOnly(value: string): string | null {
  const digits = value.trim().replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * ICS 时间戳 → RFC3339。
 *
 * 三种形态：
 * - `20260820T093000Z`：已是 UTC
 * - `20260820T093000` + `TZID=Asia/Shanghai`：本地时间，要按该时区反解偏移
 * - `20260820T093000` 无 TZID：浮动时间，按本机时区处理（RFC 5545 的语义）
 */
export function toRfc3339(property: IcsProperty): string | null {
  const raw = property.value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw);
  if (!match) {
    // 有些服务端在 DTSTAMP 上直接给 RFC3339，容一下
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed)
      ? null
      : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  const [, year, month, day, hour, minute, second, zulu] = match;
  if (zulu === "Z") {
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  const timeZone = property.params.TZID;
  const offset = offsetFor(
    `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    timeZone,
  );
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/**
 * 求某个时区在某个本地时刻的 UTC 偏移。
 *
 * 做法：把「假设这个本地时间是 UTC」的时刻按目标时区格式化，看格式化结果与原值
 * 差多少，那个差值就是偏移。夏令时也能正确处理，因为格式化用的是目标时刻附近的规则。
 *
 * 拿不到时区（TZID 缺失或是 Apple 的私有 tzid）时退回本机时区——RFC 5545 对
 * 浮动时间的规定就是「按本地时间理解」。
 */
function offsetFor(localIso: string, timeZone?: string): string {
  const asUtc = Date.parse(`${localIso}Z`);
  if (Number.isNaN(asUtc)) return "Z";

  let minutes: number;
  try {
    const zone = timeZone ?? currentTimeZone();
    const formatted = formatInZone(new Date(asUtc), zone);
    minutes = Math.round((formatted - asUtc) / 60_000);
  } catch {
    // 未知 TZID：退回本机偏移。注意 getTimezoneOffset 的符号与 ISO 相反
    minutes = -new Date(asUtc).getTimezoneOffset();
  }

  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${rest}`;
}

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 把一个时刻按目标时区拆成字段，再当 UTC 拼回时间戳。 */
function formatInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const lookup = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  // Intl 在 hour12:false 下会把午夜给成 24，直接拼会越界
  const hour = lookup("hour") === "24" ? "00" : lookup("hour");
  return Date.parse(
    `${lookup("year")}-${lookup("month")}-${lookup("day")}T${hour}:${lookup("minute")}:${lookup("second")}Z`,
  );
}

/** `PT1H30M` / `P1D` → 加到起点上。只支持日/时/分/秒，周与月在事件时长里不出现。 */
function applyDuration(startRfc3339: string, duration: string): string | null {
  const match = /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    duration.trim().toUpperCase(),
  );
  if (!match) return null;
  const [, sign, days, hours, minutes, seconds] = match;
  const total =
    (Number(days ?? 0) * 86_400 +
      Number(hours ?? 0) * 3_600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000;
  const base = Date.parse(startRfc3339);
  if (Number.isNaN(base)) return null;
  const time = sign === "-" ? base - total : base + total;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}
