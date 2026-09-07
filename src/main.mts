import { handlers as agentTools } from "./handlers/tools.mjs";
/**
 * Apple 日历插件入口。
 *
 * 只做方法名到 handler 的映射。业务在 `handlers/`，CalDAV 细节在 `caldav/`，
 * 排期镜像在 `mirror/`。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger, start } from "./sdk/index.mjs";
import * as config from "./handlers/config.mjs";
import * as sync from "./handlers/sync.mjs";

/** 版本只维护在 manifest 一处。 */
function readManifestVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "yinian-plugin.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

start({
  version: readManifestVersion(),
  onInit: (ctx) => {
    // 没有 token 就说明宿主版本低于 0.7.0，或 manifest 的 permissions.api 被改空了。
    // 排期镜像会因此失败，但拉取方向不受影响——在这里说清楚，免得用户只看到
    // 「排期镜像失败」而不知道根因。
    if (!ctx.apiToken) {
      logger.warn(
        "宿主未下发 API token，排期镜像将不可用（需要一念 ≥ 0.7.0）。日历拉取不受影响",
      );
    }
    logger.debug(config.describeContext(ctx));
  },
  handlers: {
    ...agentTools,
    // event 是 pull-only，宿主不会对它调 sync.push（契约 §5.1.1）
    "sync.pull": sync.pull,
    "config.validate": config.validate,
    "appleCalendar.openAppleAccount": config.openAppleAccount,
    "appleCalendar.testConnection": config.testConnection,
    "appleCalendar.testMirrorWrite": config.testMirrorWrite,
    "appleCalendar.listCalendars": config.listCalendarOptions,
  },
});
