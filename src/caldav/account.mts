/** 同步与 AI 写入共用账号发现，凭据只在插件内使用。 */
import { readConfig } from "../config.mjs";
import {
  discoverPrincipal,
  discoverCalendarHome,
  listCalendars,
  type DavContext,
} from "./collection.mjs";
export async function discoverAccount(raw: unknown) {
  const config = readConfig(raw);
  const dav: DavContext = {
    credentials: { appleId: config.appleId, appPassword: config.appPassword },
    timeoutSeconds: config.timeoutSeconds,
  };
  const principal = await discoverPrincipal(dav);
  const homeUrl = await discoverCalendarHome(dav, principal);
  const allCalendars = await listCalendars(dav, homeUrl);
  return { config, dav, homeUrl, allCalendars };
}
