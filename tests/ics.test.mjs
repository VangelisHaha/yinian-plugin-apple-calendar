import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEvents, parseProperty, unfold } from "../dist/caldav/ics.mjs";

function wrap(body) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

test("折行的长标题会被合回一行", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:folded-1",
      "DTSTART:20260820T093000Z",
      "DTEND:20260820T103000Z",
      "SUMMARY:这是一个非常长的会议标题需要被折行处理否则解析出来就",
      " 只有前半截而后半截会被当成未知属性丢掉",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const [event] = parseEvents(ics);
  assert.equal(
    event.summary,
    "这是一个非常长的会议标题需要被折行处理否则解析出来就只有前半截而后半截会被当成未知属性丢掉",
  );
});

test("制表符开头的续行也算折行", () => {
  const lines = unfold("SUMMARY:前半\r\n\t后半");
  assert.deepEqual(lines, ["SUMMARY:前半后半"]);
});

test("全天事件的 DTEND 右开，直接用不做加减", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:allday-1",
      "DTSTART;VALUE=DATE:20260820",
      "DTEND;VALUE=DATE:20260821",
      "SUMMARY:只占 8/20 一天",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const [event] = parseEvents(ics);
  assert.equal(event.allDay, true);
  assert.equal(event.startDate, "2026-08-20");
  assert.equal(
    event.endDate,
    "2026-08-21",
    "ICS 的 DTEND 与一念的 end_date 都是右开，自己减一天会让事件短一天",
  );
  assert.equal(event.startAt, undefined, "全天事件不能同时带时间戳");
});

test("全天事件缺 DTEND 时按一天补", () => {
  const ics = wrap(
    ["BEGIN:VEVENT", "UID:allday-2", "DTSTART;VALUE=DATE:20260820", "SUMMARY:x", "END:VEVENT"].join(
      "\r\n",
    ),
  );
  const [event] = parseEvents(ics);
  assert.equal(event.startDate, "2026-08-20");
  assert.equal(event.endDate, "2026-08-21");
});

test("带 TZID 的本地时间会换算出正确偏移", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:tz-1",
      "DTSTART;TZID=Asia/Shanghai:20260820T093000",
      "DTEND;TZID=Asia/Shanghai:20260820T103000",
      "SUMMARY:上海时间的会",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const [event] = parseEvents(ics);
  assert.equal(
    event.startAt,
    "2026-08-20T09:30:00+08:00",
    "TZID 不换算的话会当成 UTC，整体差 8 小时",
  );
  assert.equal(Date.parse(event.startAt), Date.parse("2026-08-20T01:30:00Z"));
});

test("夏令时时区按目标时刻的规则换算", () => {
  const summer = parseEvents(
    wrap(
      [
        "BEGIN:VEVENT",
        "UID:dst-1",
        "DTSTART;TZID=America/New_York:20260715T120000",
        "DTEND;TZID=America/New_York:20260715T130000",
        "SUMMARY:夏令时",
        "END:VEVENT",
      ].join("\r\n"),
    ),
  )[0];
  const winter = parseEvents(
    wrap(
      [
        "BEGIN:VEVENT",
        "UID:dst-2",
        "DTSTART;TZID=America/New_York:20260115T120000",
        "DTEND;TZID=America/New_York:20260115T130000",
        "SUMMARY:冬令时",
        "END:VEVENT",
      ].join("\r\n"),
    ),
  )[0];

  assert.equal(summer.startAt, "2026-07-15T12:00:00-04:00");
  assert.equal(winter.startAt, "2026-01-15T12:00:00-05:00");
});

test("VALARM 里的属性不会污染事件本身", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:alarm-1",
      "DTSTART:20260820T093000Z",
      "DTEND:20260820T103000Z",
      "SUMMARY:真正的标题",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:提醒文案不该变成事件备注",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const [event] = parseEvents(ics);
  assert.equal(event.summary, "真正的标题");
  assert.equal(event.description, "", "VALARM 的 DESCRIPTION 不能当成事件备注");
});

test("一个资源里的多个 VEVENT 都会被取出", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:series-1",
      "DTSTART:20260820T093000Z",
      "DTEND:20260820T100000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=TH",
      "SUMMARY:周会",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series-1",
      "RECURRENCE-ID:20260827T093000Z",
      "DTSTART:20260827T140000Z",
      "DTEND:20260827T143000Z",
      "SUMMARY:周会（改到下午）",
      "END:VEVENT",
    ].join("\r\n"),
  );

  const events = parseEvents(ics);
  assert.equal(events.length, 2);
  assert.equal(events[0].recurrenceRule, "FREQ=WEEKLY;BYDAY=TH");
  assert.equal(events[1].recurrenceId, "20260827T093000Z");
});

test("DURATION 能替代缺失的 DTEND", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:dur-1",
      "DTSTART:20260820T093000Z",
      "DURATION:PT1H30M",
      "SUMMARY:一个半小时",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const [event] = parseEvents(ics);
  assert.equal(event.endAt, "2026-08-20T11:00:00Z");
});

test("零长事件被补成 15 分钟", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:zero-1",
      "DTSTART:20260820T093000Z",
      "DTEND:20260820T093000Z",
      "SUMMARY:零长",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const [event] = parseEvents(ics);
  assert.equal(
    event.endAt,
    "2026-08-20T09:45:00Z",
    "一念要求 end 晚于 start，零长事件会被判形状错误整条丢掉",
  );
});

test("没有 UID 的事件被跳过而不是产生一条无主数据", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "DTSTART:20260820T093000Z",
      "DTEND:20260820T100000Z",
      "SUMMARY:没有 UID",
      "END:VEVENT",
    ].join("\r\n"),
  );
  assert.deepEqual(parseEvents(ics), []);
});

test("转义字符与带引号的参数都能正确解析", () => {
  const property = parseProperty(
    'ORGANIZER;CN="Ops: Team, Asia":mailto:ops@example.com',
  );
  assert.equal(property.name, "ORGANIZER");
  assert.equal(property.params.CN, "Ops: Team, Asia");
  assert.equal(property.value, "mailto:ops@example.com");

  const description = parseProperty("DESCRIPTION:第一行\\n第二行\\, 带逗号");
  assert.equal(description.value, "第一行\n第二行, 带逗号");
});

test("STATUS 与 TRANSP 映射到取消与空闲", () => {
  const ics = wrap(
    [
      "BEGIN:VEVENT",
      "UID:flags-1",
      "DTSTART;VALUE=DATE:20260820",
      "DTEND;VALUE=DATE:20260821",
      "SUMMARY:节假日",
      "STATUS:CANCELLED",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const [event] = parseEvents(ics);
  assert.equal(event.cancelled, true);
  assert.equal(event.transparent, true);
});
