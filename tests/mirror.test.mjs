import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEvents } from "../dist/caldav/ics.mjs";
import { toExternalEvent } from "../dist/map.mjs";
import {
  MIRROR_UID_PREFIX,
  isMirrorUid,
  project,
  summaryFor,
} from "../dist/mirror/project.mjs";
import { fold, buildCalendar } from "../dist/caldav/write.mjs";

const OPTIONS = {
  calendarExternalId: "https://p01-caldav.icloud.com/123/calendars/work/",
  busyStatusOverride: "source",
  appleId: "me@icloud.com",
};

function single(body) {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
  const [event] = parseEvents(ics);
  return event;
}

test("重复事件的例外实例不会与主事件撞 externalId", () => {
  const master = single(
    [
      "BEGIN:VEVENT",
      "UID:weekly",
      "DTSTART:20260820T010000Z",
      "DTEND:20260820T020000Z",
      "RRULE:FREQ=WEEKLY",
      "SUMMARY:周会",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const exception = single(
    [
      "BEGIN:VEVENT",
      "UID:weekly",
      "RECURRENCE-ID:20260827T010000Z",
      "DTSTART:20260827T060000Z",
      "DTEND:20260827T070000Z",
      "SUMMARY:周会（改期）",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const a = toExternalEvent(master, OPTIONS);
  const b = toExternalEvent(exception, OPTIONS);
  assert.equal(a.externalId, "weekly");
  assert.equal(b.externalId, "weekly::20260827T010000Z");
  assert.notEqual(
    a.externalId,
    b.externalId,
    "共享 UID 的两条会互相覆盖，最后只剩一条",
  );
});

test("忙闲状态可被实例配置强制为空闲", () => {
  const event = single(
    [
      "BEGIN:VEVENT",
      "UID:holiday",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261002",
      "SUMMARY:国庆",
      "END:VEVENT",
    ].join("\r\n"),
  );

  assert.equal(toExternalEvent(event, OPTIONS).busyStatus, "busy");
  assert.equal(
    toExternalEvent(event, { ...OPTIONS, busyStatusOverride: "free" })
      .busyStatus,
    "free",
    "订阅类日历不该把用户一整天标成忙",
  );
});

test("组织者是自己时才标 isOrganizer", () => {
  const mine = single(
    [
      "BEGIN:VEVENT",
      "UID:o1",
      "DTSTART:20260820T010000Z",
      "DTEND:20260820T020000Z",
      "ORGANIZER:mailto:ME@icloud.com",
      "SUMMARY:我组织的",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const theirs = single(
    [
      "BEGIN:VEVENT",
      "UID:o2",
      "DTSTART:20260820T010000Z",
      "DTEND:20260820T020000Z",
      "ORGANIZER:mailto:other@example.com",
      "SUMMARY:别人组织的",
      "END:VEVENT",
    ].join("\r\n"),
  );

  assert.equal(toExternalEvent(mine, OPTIONS).isOrganizer, true);
  assert.equal(toExternalEvent(theirs, OPTIONS).isOrganizer, false);
});

test("无标题事件用占位而不是被丢掉", () => {
  const event = single(
    [
      "BEGIN:VEVENT",
      "UID:blank",
      "DTSTART:20260820T010000Z",
      "DTEND:20260820T020000Z",
      "END:VEVENT",
    ].join("\r\n"),
  );
  assert.equal(toExternalEvent(event, OPTIONS).title, "（无标题）");
});

// ─── 排期镜像 ────────────────────────────────────────────────────────────────

function block(overrides = {}) {
  return {
    kind: "schedule",
    scheduleBlock: {
      id: "blk-1",
      taskId: "task-1",
      plannedStartAt: "2026-08-20T01:00:00Z",
      plannedEndAt: "2026-08-20T05:00:00Z",
      label: "中台开发",
      status: "planned",
      integrationId: "int-1",
      ...overrides,
    },
    task: { id: "task-1", title: "订单中心重构", status: "doing" },
  };
}

test("排期块被投影成带段名的事件", () => {
  const [event] = project([block()], { includeDeadlines: false });
  assert.equal(event.uid, `${MIRROR_UID_PREFIX}blk-1`);
  assert.equal(
    event.summary,
    "订单中心重构 · 中台开发",
    "Apple 日历上没有左栏，只写段名认不出是哪个需求",
  );
  assert.equal(event.allDay, false);
  assert.equal(event.transparent, false);
});

test("取消的排期不镜像，完成的排期不占忙时", () => {
  assert.deepEqual(
    project([block({ status: "canceled" })], { includeDeadlines: false }),
    [],
  );
  const [finished] = project([block({ status: "finished" })], {
    includeDeadlines: false,
  });
  assert.equal(
    finished.transparent,
    true,
    "做完的段留在日历上有回顾价值，但不该继续占忙",
  );
});

test("没有段名时用任务标题", () => {
  assert.equal(
    summaryFor({ label: null }, { title: "订单中心重构" }),
    "订单中心重构",
  );
  assert.equal(
    summaryFor({ label: "   " }, { title: "订单中心重构" }),
    "订单中心重构",
  );
});

test("反向或零长的排期被补成 15 分钟", () => {
  const [event] = project(
    [
      block({
        plannedStartAt: "2026-08-20T05:00:00Z",
        plannedEndAt: "2026-08-20T01:00:00Z",
      }),
    ],
    { includeDeadlines: false },
  );
  assert.equal(event.startAt, "2026-08-20T05:00:00.000Z");
  assert.equal(event.endAt, "2026-08-20T05:15:00.000Z");
});

test("截止时间默认不镜像，打开后是全天且不占忙", () => {
  const deadline = {
    kind: "deadline",
    task: { id: "t-9", title: "交周报", dueAt: "2026-08-21T09:00:00Z" },
  };

  assert.deepEqual(project([deadline], { includeDeadlines: false }), []);

  const [event] = project([deadline], { includeDeadlines: true });
  assert.equal(event.allDay, true);
  assert.equal(event.startDate, "2026-08-21");
  assert.equal(event.endDate, "2026-08-22", "end_date 右开");
  assert.equal(event.transparent, true, "截止是标记不是占用");
  assert.equal(event.summary, "截止：交周报");
});

test("一念里的 Event 不参与镜像", () => {
  const items = [
    { kind: "event", event: { id: "e-1", title: "外部同步来的会" } },
    block(),
  ];
  const projected = project(items, { includeDeadlines: false });
  assert.equal(projected.length, 1, "把事件写回日历等于回声");
  assert.ok(projected[0].uid.startsWith(MIRROR_UID_PREFIX));
});

test("只认自己写入的 UID 前缀", () => {
  assert.equal(isMirrorUid("yinian-schedule-blk-1"), true);
  assert.equal(isMirrorUid("yinian-deadline-t-1"), true);
  assert.equal(
    isMirrorUid("A1B2C3-user-own-event"),
    false,
    "用户手动加进这个日历的东西，插件没资格删",
  );
});

// ─── ICS 写入 ────────────────────────────────────────────────────────────────

test("生成的 ICS 用 CRLF 且全天写成 VALUE=DATE", () => {
  const ics = buildCalendar({
    uid: "yinian-schedule-blk-1",
    summary: "订单中心重构 · 中台开发",
    allDay: true,
    startDate: "2026-08-20",
    endDate: "2026-08-21",
  });

  assert.ok(ics.includes("\r\n"), "RFC 5545 要求 CRLF，用 \\n 客户端解析不稳定");
  assert.ok(!/[^\r]\n/.test(ics), "不能出现裸 LF");
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20260820"));
  assert.ok(ics.includes("DTEND;VALUE=DATE:20260821"));
  assert.ok(ics.includes("BEGIN:VEVENT") && ics.includes("END:VCALENDAR"));
});

test("定时事件一律写成 UTC，不写没有定义的 TZID", () => {
  const ics = buildCalendar({
    uid: "yinian-schedule-blk-2",
    summary: "写代码",
    allDay: false,
    startAt: "2026-08-20T09:00:00+08:00",
    endAt: "2026-08-20T12:00:00+08:00",
  });
  assert.ok(ics.includes("DTSTART:20260820T010000Z"));
  assert.ok(ics.includes("DTEND:20260820T040000Z"));
  assert.ok(!ics.includes("TZID"), "写 TZID 而不带 VTIMEZONE 是无效 ICS");
});

test("折行按字节且不切断 UTF-8 字符", () => {
  const line = `SUMMARY:${"中".repeat(60)}`;
  const folded = fold(line);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "超过 75 字节必须折行");
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part, "utf8") <= 76);
  }
  // 折回来必须还是原文，切断字符会得到乱码
  const rejoined = parts
    .map((part, index) => (index === 0 ? part : part.slice(1)))
    .join("");
  assert.equal(rejoined, line);
});

test("生成的 ICS 能被自己的解析器读回来", () => {
  const ics = buildCalendar({
    uid: "yinian-schedule-blk-3",
    summary: "标题里有逗号, 分号; 和换行",
    description: "第一行\n第二行",
    allDay: false,
    startAt: "2026-08-20T01:00:00Z",
    endAt: "2026-08-20T05:00:00Z",
    transparent: true,
  });

  const [event] = parseEvents(ics);
  assert.equal(event.uid, "yinian-schedule-blk-3");
  assert.equal(event.summary, "标题里有逗号, 分号; 和换行");
  assert.equal(event.description, "第一行\n第二行");
  assert.equal(event.transparent, true);
});
