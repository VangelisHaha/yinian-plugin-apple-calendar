/**
 * CalDAV 发现与集合操作。
 *
 * 发现链是 RFC 4791 / 6764 规定的三跳，**不能跳过**：
 *
 * ```
 * PROPFIND /  →  current-user-principal   （我是谁）
 * PROPFIND principal  →  calendar-home-set （我的日历放在哪）
 * PROPFIND home, Depth:1  →  一串 calendar （有哪些日历）
 * ```
 *
 * 常见的错误做法是把 principal 路径写成 `/{appleId}/calendars/`——iCloud 的
 * principal 是一串数字 ID，和邮箱没关系，换个账号就崩。
 */

import {
  assertOk,
  childOf,
  davRequest,
  escapeXml,
  find,
  findAll,
  ICLOUD_ORIGIN,
  parseXml,
  textOf,
  type DavCredentials,
} from "./dav.mjs";

export interface DavContext {
  credentials: DavCredentials;
  timeoutSeconds: number;
}

/** 一个 CalDAV 日历集合。 */
export interface DavCalendar {
  /** 集合 URL（绝对地址）。它就是这个日历的稳定标识。 */
  url: string;
  displayName: string;
  /** 服务端支持的组件类型。只含 `VTODO` 的集合是提醒事项列表，不是日历。 */
  components: string[];
  /** 当前 sync-token；服务端不支持 sync-collection 时为空。 */
  syncToken: string;
  /** 集合层面的 ctag，变了说明里面有东西改过。 */
  ctag: string;
  readOnly: boolean;
}

/** 集合里的一个资源。 */
export interface DavCalendarObject {
  /** 资源 URL（绝对地址）。 */
  url: string;
  etag: string;
  /** iCalendar 正文。只有 sync-collection / multiget 才会带回来。 */
  ics: string;
}

const NS = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"`;

/** 走完发现链，返回该账号下的全部日历集合。 */
export async function discoverCalendars(
  context: DavContext,
): Promise<DavCalendar[]> {
  const principal = await discoverPrincipal(context);
  const home = await discoverCalendarHome(context, principal);
  return listCalendars(context, home);
}

/** 第一跳：我是谁。 */
export async function discoverPrincipal(context: DavContext): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  const response = assertOk(
    await davRequest(context.credentials, {
      method: "PROPFIND",
      url: `${ICLOUD_ORIGIN}/`,
      body,
      contentType: 'application/xml; charset="utf-8"',
      depth: "0",
      timeoutSeconds: context.timeoutSeconds,
    }),
    "查询 CalDAV 账号信息",
  );

  const document = parseXml(response.text);
  const principal = find(document, "current-user-principal");
  const href = principal ? textOf(principal, "href") : "";
  if (!href) {
    throw new Error(
      "CalDAV 服务端没有返回 current-user-principal，无法继续发现日历",
    );
  }
  return new URL(href, ICLOUD_ORIGIN).toString();
}

/** 第二跳：我的日历放在哪。 */
export async function discoverCalendarHome(
  context: DavContext,
  principalUrl: string,
): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
  const response = assertOk(
    await davRequest(context.credentials, {
      method: "PROPFIND",
      url: principalUrl,
      body,
      contentType: 'application/xml; charset="utf-8"',
      depth: "0",
      timeoutSeconds: context.timeoutSeconds,
    }),
    "查询日历根目录",
  );

  const document = parseXml(response.text);
  const homeSet = find(document, "calendar-home-set");
  const href = homeSet ? textOf(homeSet, "href") : "";
  if (!href) {
    throw new Error("CalDAV 服务端没有返回 calendar-home-set");
  }
  // 必须以 / 结尾，否则后面 Depth:1 拿不到子集合
  const home = new URL(href, principalUrl).toString();
  return home.endsWith("/") ? home : `${home}/`;
}

/** 第三跳：列出日历。 */
export async function listCalendars(
  context: DavContext,
  homeUrl: string,
): Promise<DavCalendar[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop>
  <d:resourcetype/>
  <d:displayname/>
  <d:current-user-privilege-set/>
  <c:supported-calendar-component-set/>
  <cs:getctag/>
  <d:sync-token/>
</d:prop></d:propfind>`;
  const response = assertOk(
    await davRequest(context.credentials, {
      method: "PROPFIND",
      url: homeUrl,
      body,
      contentType: 'application/xml; charset="utf-8"',
      depth: "1",
      timeoutSeconds: context.timeoutSeconds,
    }),
    "列出日历",
  );

  const document = parseXml(response.text);
  const calendars: DavCalendar[] = [];

  for (const entry of findAll(document, "response")) {
    const href = childOf(entry, "href")?.text.trim() ?? "";
    if (!href) continue;

    const resourceType = find(entry, "resourcetype");
    const isCalendar = resourceType?.children.some(
      (child) => child.name === "calendar",
    );
    if (!isCalendar) continue;

    const components = findAll(entry, "comp")
      .map((comp) => comp.attributes.name?.toUpperCase() ?? "")
      .filter(Boolean);
    // 只含 VTODO 的集合是「提醒事项」列表。当成日历拉会得到一堆没有时间的条目。
    if (components.length > 0 && !components.includes("VEVENT")) continue;

    const privileges = find(entry, "current-user-privilege-set");
    const canWrite = privileges
      ? privileges.children.some((child) =>
          child.children.some(
            (privilege) =>
              privilege.name === "write" || privilege.name === "write-content",
          ),
        )
      : false;

    calendars.push({
      url: new URL(href, homeUrl).toString(),
      displayName: textOf(entry, "displayname") || "未命名日历",
      components: components.length > 0 ? components : ["VEVENT"],
      syncToken: textOf(entry, "sync-token"),
      ctag: textOf(entry, "getctag"),
      // privilege-set 拿不到时按可写处理：读路径不受影响，写路径失败会有明确的
      // HTTP 403，比在这里猜「不可写」然后静默跳过要好排查
      readOnly: privileges ? !canWrite : false,
    });
  }

  return calendars;
}

/** `sync-collection` 的一次结果。 */
export interface SyncCollectionResult {
  objects: DavCalendarObject[];
  /** 远端已删除的资源 URL。 */
  deletedUrls: string[];
  /** 下一轮要带的 token。 */
  syncToken: string;
  /** 服务端截断了结果，需要再来一轮。 */
  truncated: boolean;
}

/**
 * RFC 6578 增量同步。
 *
 * `syncToken` 传空串是「初始同步」，服务端会回全量。**注意它不受时间窗口约束**——
 * 一个存了十年会议的日历初始同步会回全部。所以初始一轮走
 * [`calendarQuery`](#calendarQuery) 的时间窗口，只在拿到 token 之后才用这里增量。
 *
 * 返回 `syncToken: ""` 表示服务端不支持（或 token 失效），调用方应退回全量。
 */
export async function syncCollection(
  context: DavContext,
  calendarUrl: string,
  syncToken: string,
): Promise<SyncCollectionResult> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection ${NS}>
  <d:sync-token>${escapeXml(syncToken)}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>`;

  const response = await davRequest(context.credentials, {
    method: "REPORT",
    url: calendarUrl,
    body,
    contentType: 'application/xml; charset="utf-8"',
    depth: "0",
    timeoutSeconds: context.timeoutSeconds,
  });

  // 403 / 409 / 507 都可能是 token 失效或不支持。让调用方退回全量而不是报错——
  // 报错会让整个实例停摆，而全量只是慢一点。
  if (response.status >= 400) {
    return { objects: [], deletedUrls: [], syncToken: "", truncated: false };
  }

  const document = parseXml(response.text);
  const objects: DavCalendarObject[] = [];
  const deletedUrls: string[] = [];

  for (const entry of findAll(document, "response")) {
    const href = childOf(entry, "href")?.text.trim() ?? "";
    if (!href) continue;
    const url = new URL(href, calendarUrl).toString();
    const status = textOf(entry, "status");

    if (status.includes("404") || status.includes("410")) {
      deletedUrls.push(url);
      continue;
    }

    const ics = textOf(entry, "calendar-data");
    // 没有正文的条目不当成事件：sync-collection 在某些服务端上会为集合本身回一条
    if (!ics) continue;
    objects.push({ url, etag: textOf(entry, "getetag"), ics });
  }

  return {
    objects,
    deletedUrls,
    syncToken: textOf(document, "sync-token"),
    // 207 里带 507 状态说明服务端主动截断了
    truncated: response.text.includes("number-of-matches-within-limits"),
  };
}

/**
 * 按时间窗口拉事件（RFC 4791 `calendar-query`）。
 *
 * 初始同步与不支持 sync-collection 的服务端都走这里。时间参数是 UTC 的
 * `YYYYMMDDTHHMMSSZ` 格式，**不是 RFC3339**——写错服务端会静默返回空结果。
 */
export async function calendarQuery(
  context: DavContext,
  calendarUrl: string,
  startUtc: Date,
  endUtc: Date,
): Promise<DavCalendarObject[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${davTime(startUtc)}" end="${davTime(endUtc)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const response = assertOk(
    await davRequest(context.credentials, {
      method: "REPORT",
      url: calendarUrl,
      body,
      contentType: 'application/xml; charset="utf-8"',
      depth: "1",
      timeoutSeconds: context.timeoutSeconds,
    }),
    "拉取日历事件",
  );

  const document = parseXml(response.text);
  const objects: DavCalendarObject[] = [];
  for (const entry of findAll(document, "response")) {
    const href = childOf(entry, "href")?.text.trim() ?? "";
    const ics = textOf(entry, "calendar-data");
    if (!href || !ics) continue;
    objects.push({
      url: new URL(href, calendarUrl).toString(),
      etag: textOf(entry, "getetag"),
      ics,
    });
  }
  return objects;
}

/** 列出集合里所有资源的 URL 与 etag，不带正文。镜像做 diff 时用。 */
export async function listObjectEtags(
  context: DavContext,
  calendarUrl: string,
): Promise<Array<{ url: string; etag: string }>> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`;
  const response = assertOk(
    await davRequest(context.credentials, {
      method: "PROPFIND",
      url: calendarUrl,
      body,
      contentType: 'application/xml; charset="utf-8"',
      depth: "1",
      timeoutSeconds: context.timeoutSeconds,
    }),
    "列出日历内的条目",
  );

  const document = parseXml(response.text);
  const entries: Array<{ url: string; etag: string }> = [];
  for (const entry of findAll(document, "response")) {
    const href = childOf(entry, "href")?.text.trim() ?? "";
    if (!href) continue;
    const url = new URL(href, calendarUrl).toString();
    // 集合自己也会出现在 Depth:1 的结果里，靠 resourcetype 排掉
    if (find(entry, "collection")) continue;
    entries.push({ url, etag: textOf(entry, "getetag") });
  }
  return entries;
}

/** 建一个日历集合（RFC 4791 `MKCALENDAR`）。 */
export async function makeCalendar(
  context: DavContext,
  homeUrl: string,
  name: string,
  color = "#C2410C",
): Promise<string> {
  // 集合路径用固定 slug，不用随机 UUID：重装插件后要能认出上次建的那个日历
  const url = `${homeUrl}yinian-schedule-mirror/`;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar ${NS}>
  <d:set><d:prop>
    <d:displayname>${escapeXml(name)}</d:displayname>
    <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    <a:calendar-color>${escapeXml(color)}</a:calendar-color>
  </d:prop></d:set>
</c:mkcalendar>`;

  const response = await davRequest(context.credentials, {
    method: "MKCALENDAR",
    url,
    body,
    contentType: 'application/xml; charset="utf-8"',
    timeoutSeconds: context.timeoutSeconds,
  });

  // 405 / 409 说明集合已存在，直接复用
  if (response.status === 405 || response.status === 409) return url;
  assertOk(response, `创建日历「${name}」`);
  return url;
}

/** 写入（或覆盖）一个日历资源。 */
export async function putObject(
  context: DavContext,
  url: string,
  ics: string,
): Promise<void> {
  assertOk(
    await davRequest(context.credentials, {
      method: "PUT",
      url,
      body: ics,
      contentType: 'text/calendar; charset="utf-8"',
      timeoutSeconds: context.timeoutSeconds,
    }),
    `写入 ${url}`,
  );
}

/** 删除一个日历资源。404 视为成功——目标本来就不在。 */
export async function deleteObject(
  context: DavContext,
  url: string,
): Promise<void> {
  const response = await davRequest(context.credentials, {
    method: "DELETE",
    url,
    timeoutSeconds: context.timeoutSeconds,
  });
  if (response.status === 404) return;
  assertOk(response, `删除 ${url}`);
}

/** CalDAV 的时间格式：UTC 的 `YYYYMMDDTHHMMSSZ`。 */
export function davTime(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}
