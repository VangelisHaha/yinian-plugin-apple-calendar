import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureCreatedEvent } from "../dist/caldav/create.mjs";
const dav = {
  credentials: { appleId: "fake@example.test", appPassword: "fake" },
  timeoutSeconds: 2,
};
for (const allDay of [false, true])
  test(`稳定 UID 创建及重试（全天=${allDay}）`, async () => {
    const original = globalThis.fetch;
    let stored;
    let puts = 0;
    const methods = [];
    globalThis.fetch = async (url, init) => {
      methods.push(init.method);
      assert.match(String(url), /yinian-ai-same-op.ics$/);
      if (init.method === "PUT") {
        puts++;
        assert.equal(init.headers["If-None-Match"], "*");
        stored = init.body;
        return new Response(null, { status: 201 });
      }
      return stored ? new Response(stored) : new Response("", { status: 404 });
    };
    try {
      const item = {
        title: "中文会议",
        notes: "第一行\n第二行",
        location: "会议室, A;东侧",
        allDay,
        ...(allDay
          ? { startDate: "2026-09-08", endDate: "2026-09-10" }
          : {
              startAt: "2026-09-08T09:00:00+08:00",
              endAt: "2026-09-08T10:00:00+08:00",
            }),
      };
      const first = await ensureCreatedEvent(
        dav,
        "https://example.test/calendar/",
        item,
        "same-op",
      );
      const repeated = await ensureCreatedEvent(
        dav,
        "https://example.test/calendar/",
        item,
        "same-op",
      );
      assert.equal(puts, 1);
      assert.deepEqual(first, repeated);
      assert.equal(first.summary, "中文会议");
      assert.equal(first.location, "会议室, A;东侧");
      assert.deepEqual(methods, ["GET", "PUT", "GET", "GET"]);
    } finally {
      globalThis.fetch = original;
    }
  });
test("GET 出错不能盲目 PUT", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response("", { status: 500 });
  };
  try {
    await assert.rejects(() =>
      ensureCreatedEvent(
        dav,
        "https://example.test/c/",
        {
          title: "测试",
          allDay: true,
          startDate: "2026-09-08",
          endDate: "2026-09-09",
        },
        "same-op",
      ),
    );
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
