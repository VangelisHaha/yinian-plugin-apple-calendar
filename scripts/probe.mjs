#!/usr/bin/env node
/**
 * iCloud CalDAV 探针。**跑之前先编译**（`npm run build`）。
 *
 * 它回答四个只能用真凭据回答的问题：
 *
 * 1. Apple 账号 + App 专用密码能不能过 CalDAV 的 Basic 认证；
 * 2. 发现链走不走通（principal → calendar-home-set → 日历列表）；
 * 3. 服务端支持不支持 `sync-collection` 增量；
 * 4. **`MKCALENDAR` 允不允许**——这一条决定排期镜像能不能自己建日历。
 *    不允许的话镜像必须改成写进用户手工建好的日历。
 *
 * 用法：
 *
 * ```bash
 * APPLE_ID=you@icloud.com APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run probe
 * # 加 --write 才会真的建日历并写一条测试事件（结束后会清掉）
 * ```
 *
 * 凭据只从环境变量读，**不落盘、不进日志**。
 */

import {
  discoverCalendarHome,
  discoverPrincipal,
  listCalendars,
  syncCollection,
  makeCalendar,
  putObject,
  deleteObject,
} from "../dist/caldav/collection.mjs";
import { buildCalendar } from "../dist/caldav/write.mjs";

const appleId = process.env.APPLE_ID;
const appPassword = process.env.APPLE_APP_PASSWORD;
const allowWrite = process.argv.includes("--write");

if (!appleId || !appPassword) {
  console.error(
    "缺少凭据。用法：APPLE_ID=you@icloud.com APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run probe [-- --write]",
  );
  process.exit(2);
}

const context = {
  credentials: { appleId, appPassword },
  timeoutSeconds: 30,
};

let failed = false;

function ok(message) {
  console.log(`✔ ${message}`);
}
function bad(message) {
  failed = true;
  console.error(`✘ ${message}`);
}
function note(message) {
  console.log(`  ${message}`);
}

async function main() {
  console.log(`探测 iCloud CalDAV（账号 ${mask(appleId)}）\n`);

  const principal = await discoverPrincipal(context);
  ok("认证通过，拿到 current-user-principal");
  note(principal);

  const home = await discoverCalendarHome(context, principal);
  ok("拿到 calendar-home-set");
  note(home);

  const calendars = await listCalendars(context, home);
  ok(`发现 ${calendars.length} 个日历`);
  for (const calendar of calendars) {
    note(
      `${calendar.displayName}${calendar.readOnly ? "（只读）" : ""} — sync-token ${calendar.syncToken ? "有" : "无"}`,
    );
  }

  const withToken = calendars.filter((calendar) => calendar.syncToken);
  if (withToken.length === 0) {
    bad("没有任何日历返回 sync-token，增量同步不可用，只能每轮走时间窗口全量");
  } else {
    const target = withToken[0];
    const result = await syncCollection(context, target.url, target.syncToken);
    if (result.syncToken) {
      ok(
        `sync-collection 可用（「${target.displayName}」本轮 ${result.objects.length} 变更）`,
      );
    } else {
      bad(
        `「${target.displayName}」的 sync-collection 被拒，增量会退回全量（能用，但慢）`,
      );
    }
  }

  if (!allowWrite) {
    console.log(
      "\n跳过写入探测。加 `-- --write` 才会验证 MKCALENDAR 与 PUT（会建一个临时日历再删掉）。",
    );
    return;
  }

  console.log("\n--- 写入探测 ---");
  let mirrorUrl;
  try {
    mirrorUrl = await makeCalendar(context, home, "一念 · 探针");
    ok("MKCALENDAR 可用，排期镜像可以自己建日历");
    note(mirrorUrl);
  } catch (error) {
    bad(
      `MKCALENDAR 被拒：${error.message}。镜像必须改成写进用户手工建好的日历`,
    );
    return;
  }

  const uid = `yinian-probe-${Date.now()}`;
  const resource = `${mirrorUrl}${uid}.ics`;
  try {
    await putObject(
      context,
      resource,
      buildCalendar({
        uid,
        summary: "一念探针 · 中文标题测试",
        description: "这条是探针写的，随后会被删掉",
        allDay: false,
        startAt: new Date(Date.now() + 3_600_000).toISOString(),
        endAt: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    );
    ok("PUT 可用，中文标题写入成功");
  } catch (error) {
    bad(`PUT 失败：${error.message}`);
    return;
  }

  try {
    await deleteObject(context, resource);
    ok("DELETE 可用，测试事件已清理");
  } catch (error) {
    bad(`DELETE 失败：${error.message}，请手动删掉「一念 · 探针」日历`);
  }

  note(
    "「一念 · 探针」这个日历留在你的 iCloud 上了，确认完可以手动删除（或留着当镜像日历）。",
  );
}

function mask(value) {
  const at = value.indexOf("@");
  if (at <= 1) return "***";
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

main()
  .then(() => {
    console.log(failed ? "\n探测完成，有问题见上。" : "\n探测全部通过。");
    process.exit(failed ? 1 : 0);
  })
  .catch((error) => {
    console.error(`\n探测中断：${error.message}`);
    process.exit(1);
  });
