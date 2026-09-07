/** 稳定 UID + 条件创建；响应丢失时先读取原资源，不重复 PUT。 */
import type { DavContext } from "./collection.mjs";
import { davRequest, assertOk } from "./dav.mjs";
import { buildCalendar } from "./write.mjs";
import { parseEvents } from "./ics.mjs";
export async function ensureCreatedEvent(
  dav: DavContext,
  calendarUrl: string,
  item: Record<string, unknown>,
  operationId: string,
) {
  const uid = `yinian-ai-${operationId}`;
  const url = `${calendarUrl.replace(/\/$/, "")}/${encodeURIComponent(uid)}.ics`;
  const fields = Object.fromEntries(
    Object.entries({
      description: item.notes,
      location: item.location,
      startAt: item.startAt,
      endAt: item.endAt,
      startDate: item.startDate,
      endDate: item.endDate,
    }).filter(([, v]) => typeof v === "string"),
  );
  const ics = buildCalendar({
    uid,
    summary: String(item.title),
    allDay: Boolean(item.allDay),
    ...fields,
  });
  let remote = await davRequest(dav.credentials, {
    method: "GET",
    url,
    timeoutSeconds: dav.timeoutSeconds,
  });
  if (remote.status === 404) {
    const written = await davRequest(dav.credentials, {
      method: "PUT",
      url,
      body: ics,
      contentType: 'text/calendar; charset="utf-8"',
      ifNoneMatch: "*",
      timeoutSeconds: dav.timeoutSeconds,
    });
    if (written.status !== 412) assertOk(written, "创建 Apple 日程");
    remote = await davRequest(dav.credentials, {
      method: "GET",
      url,
      timeoutSeconds: dav.timeoutSeconds,
    });
  }
  assertOk(remote, "核对 Apple 日程");
  const parsed = parseEvents(remote.text).find((event) => event.uid === uid);
  if (!parsed) throw new Error("远端没有返回对应日程，请核对结果");
  return parsed;
}
