/**
 * 一念回环 API 客户端（只读）。
 *
 * 用的是宿主在 `plugin.init` 里递来的 `apiToken`，它**只带 manifest 声明过的
 * scope**（契约 §3.3）。本插件声明了 `agenda:read` 与 `calendar:read`，所以除了
 * 这两个接口，其他都会得到 403 `PLUGIN_PERMISSION_DENIED`——这是设计如此，不是 bug。
 *
 * 插件**不写一念的库**（契约 §1 铁律 3）。镜像方向的写入全部发生在 CalDAV 那一侧。
 */

/**
 * `GET /api/v1/agenda` 的一个条目。
 *
 * 判别字段是 **`kind`**（Rust 侧 `#[serde(tag = "kind", rename_all = "snake_case")]`），
 * 不是 `type`。字段名都是 camelCase。
 */
export type AgendaItem =
  | { kind: "event"; event: AgendaEvent }
  | { kind: "schedule"; scheduleBlock: ScheduleBlock; task: TaskBrief }
  | { kind: "deadline"; task: TaskBrief };

export interface AgendaEvent {
  id: string;
  title: string;
  allDay?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface ScheduleBlock {
  id: string;
  taskId: string;
  plannedStartAt: string;
  plannedEndAt: string;
  /** 段名，如「中台开发」。同一任务多段排期时唯一能分辨它们的东西；手工块可为空。 */
  label?: string | null;
  status?: string | null;
  /** 来自哪个同步实例。手工排的块为 null。 */
  integrationId?: string | null;
}

export interface TaskBrief {
  id: string;
  title: string;
  status?: string | null;
  dueAt?: string | null;
  notes?: string | null;
}

export class HostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostApiError";
  }
}

export interface HostApiOptions {
  baseUrl: string;
  token: string;
  timeoutSeconds: number;
}

/**
 * 查 agenda。
 *
 * `from` / `to` 必须是 **RFC3339**，不是 `YYYY-MM-DD`——传日期会得到 400
 * `INVALID_ARGUMENT`，而错误文案不会告诉你是格式问题。
 */
export async function fetchAgenda(
  options: HostApiOptions,
  from: Date,
  to: Date,
): Promise<AgendaItem[]> {
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const payload = await get<AgendaItem[]>(options, `/agenda?${query}`);
  return payload ?? [];
}

async function get<T>(options: HostApiOptions, path: string): Promise<T> {
  if (!options.token) {
    throw new HostApiError(
      "宿主没有下发 API token。请确认一念版本 ≥ 0.7.0，且插件 manifest 声明了 permissions.api",
      0,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, options.timeoutSeconds) * 1000,
  );

  let response: Response;
  try {
    response = await fetch(`${trimEnd(options.baseUrl)}${path}`, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HostApiError(`读取一念 ${path} 超时`, 0);
    }
    throw new HostApiError(
      `读取一念 ${path} 失败: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    const code = extractCode(text);
    if (response.status === 403) {
      throw new HostApiError(
        `一念拒绝了这次读取（${code ?? "PLUGIN_PERMISSION_DENIED"}）：manifest 的 permissions.api 里没有声明所需 scope`,
        403,
        code,
      );
    }
    throw new HostApiError(
      `一念返回 HTTP ${response.status}${code ? `（${code}）` : ""}`,
      response.status,
      code,
    );
  }

  // 一念的成功信封是 { data: ... }
  const parsed = JSON.parse(text) as { data?: T };
  return parsed.data as T;
}

function extractCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    return parsed.error?.code;
  } catch {
    return undefined;
  }
}

function trimEnd(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
