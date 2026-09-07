/** AI 日程创建；外部目标只能来自账号发现结果，不接受任意 URL。 */
import {
  context,
  toolHandlers,
  eventItemSchema,
  textResult,
  withToolReceipt,
  type ToolDefinition,
} from "../sdk/index.mjs";
import { discoverAccount } from "../caldav/account.mjs";
import { ensureCreatedEvent } from "../caldav/create.mjs";
import { toExternalCalendar, toExternalEvent } from "../map.mjs";
import { selectCalendars } from "./sync.mjs";
export const tools: ToolDefinition[] = [
  {
    name: "list_calendars",
    title: "查看可写 Apple 日历",
    description:
      "列出当前账号可写且已纳入此实例同步范围的日历。创建前先查询目标，多个同名日历必须让用户选择。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (r) => {
      const { config, allCalendars } = await discoverAccount(r.config);
      const calendars = selectCalendars(allCalendars, config)
        .filter((c) => !c.readOnly)
        .map((c) => ({ id: c.url, name: c.displayName }));
      return textResult(
        calendars.map((c) => `${c.name}\n${c.id}`).join("\n") ||
          "没有可写日历，请检查实例的日历选择",
        { calendars },
      );
    },
  },
  {
    name: "create_event",
    title: "创建 Apple 日程",
    description:
      "创建个人日程并同步到 Apple；不发邀请。必须先查询并明确选择 calendarId 和 calendarName，成功后在 Apple 修改，此后只读同步回一念。",
    effect: "write",
    binding: "event",
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", title: "目标日历标识" },
        calendarName: { type: "string", title: "目标日历名称" },
        item: eventItemSchema,
      },
      required: ["calendarId", "calendarName", "item"],
      additionalProperties: false,
    },
    execute: async (r) =>
      withToolReceipt(context().dataDir, r, async () => {
        const { config, dav, allCalendars } = await discoverAccount(r.config);
        const calendar = selectCalendars(allCalendars, config).find(
          (c) => c.url === r.arguments.calendarId && !c.readOnly,
        );
        if (!calendar || calendar.displayName !== r.arguments.calendarName)
          throw new Error("目标日历不存在、不可写或已改名，请重新选择");
        const parsed = await ensureCreatedEvent(
          dav,
          calendar.url,
          r.arguments.item as Record<string, unknown>,
          r.operationId!,
        );
        const event = toExternalEvent(parsed, {
          calendarExternalId: calendar.url,
          busyStatusOverride: config.busyStatusOverride,
          appleId: config.appleId,
        });
        if (!event) throw new Error("远端日程时间不完整");
        return {
          ...textResult(
            `已创建到 Apple 日历「${calendar.displayName}」：${event.title}`,
          ),
          binding: {
            resource: "event",
            event,
            calendar: toExternalCalendar(calendar),
          },
        };
      }),
  },
];
export const handlers = toolHandlers(tools);
