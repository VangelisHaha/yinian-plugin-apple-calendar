/**
 * CalDAV 传输层：一次 HTTP 请求 + 一个够用的 XML 读取器。
 *
 * 刻意不引 XML 库：插件包要零运行时依赖（宿主不给插件装 npm 包）。CalDAV 的响应
 * 结构固定得离谱——`<multistatus>` 里一串 `<response>`，每个里面几个已知的属性。
 * 用一个只认「标签 → 文本 / 子块」的读取器就够，而且不会因为一个陌生命名空间前缀
 * 就整体解析失败。
 *
 * 不做的事：不处理实体引用之外的 XML 特性（CDATA、注释、处理指令）。iCloud 不发这些。
 */

/** iCloud 的入口。发现链从这里开始，之后会被重定向到分区主机。 */
export const ICLOUD_ORIGIN = "https://caldav.icloud.com";

export interface DavCredentials {
  appleId: string;
  appPassword: string;
}

export interface DavRequest {
  method: string;
  url: string;
  /** 请求体，PROPFIND / REPORT 是 XML，PUT 是 ICS。 */
  body?: string;
  contentType?: string;
  /** PROPFIND / REPORT 用；`0` 只看自己，`1` 看直接子级。 */
  depth?: "0" | "1";
  /** PUT 时用 `*` 表示「只在不存在时创建」，用 etag 表示「只在没被改过时覆盖」。 */
  ifMatch?: string;
  ifNoneMatch?: string;
  timeoutSeconds: number;
}

export interface DavResponse {
  status: number;
  headers: Headers;
  text: string;
}

export class DavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "DavError";
  }
}

/**
 * 发一次 CalDAV 请求。
 *
 * 两件必须做对的事：
 *
 * 1. **手动跟重定向**。`fetch` 默认会跟，但跟随时会把 `Authorization` 头丢掉
 *    （跨主机重定向的安全默认），而 iCloud 恰恰会把 `caldav.icloud.com` 上的请求
 *    重定向到 `pXX-caldav.icloud.com`。丢了头就得到 401，看起来像密码错。
 * 2. **Basic 认证**。iCloud 的 CalDAV 不支持 OAuth（Apple 开发者论坛明确说过），
 *    只能 Apple 账号 + App 专用密码。
 */
export async function davRequest(
  credentials: DavCredentials,
  request: DavRequest,
  redirectsLeft = 5,
): Promise<DavResponse> {
  const headers: Record<string, string> = {
    Authorization: basicAuth(credentials),
    // iCloud 对没有 UA 的请求偶尔直接 400
    "User-Agent": "yinian-apple-calendar/0.1",
  };
  if (request.contentType) headers["Content-Type"] = request.contentType;
  if (request.depth) headers.Depth = request.depth;
  if (request.ifMatch) headers["If-Match"] = request.ifMatch;
  if (request.ifNoneMatch) headers["If-None-Match"] = request.ifNoneMatch;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, request.timeoutSeconds) * 1000,
  );

  let response: Response;
  try {
    // exactOptionalPropertyTypes 下不能把 undefined 显式塞进 body，分开构造
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };
    if (request.body !== undefined) init.body = request.body;
    response = await fetch(request.url, init);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DavError(
        `${request.method} ${request.url} 超过 ${request.timeoutSeconds} 秒未响应`,
      );
    }
    throw new DavError(
      `${request.method} ${request.url} 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (isRedirect(response.status)) {
    const location = response.headers.get("location");
    if (!location) {
      throw new DavError(
        `${request.url} 返回 ${response.status} 但没给 Location`,
        response.status,
      );
    }
    if (redirectsLeft <= 0) {
      throw new DavError(`${request.url} 重定向次数过多`, response.status);
    }
    return davRequest(
      credentials,
      { ...request, url: new URL(location, request.url).toString() },
      redirectsLeft - 1,
    );
  }

  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

/** 401 单独成句：这是唯一一个用户自己能修的错误。 */
export function assertOk(response: DavResponse, what: string): DavResponse {
  if (response.status === 401 || response.status === 403) {
    throw new DavError(
      `${what} 被拒（HTTP ${response.status}）。请确认用的是 App 专用密码而不是 Apple 账号密码，且账号已开启双重认证`,
      response.status,
      response.text,
    );
  }
  if (response.status >= 400) {
    throw new DavError(
      `${what} 失败（HTTP ${response.status}）`,
      response.status,
      response.text.slice(0, 500),
    );
  }
  return response;
}

function basicAuth({ appleId, appPassword }: DavCredentials): string {
  // App 专用密码 Apple 显示成 xxxx-xxxx-xxxx-xxxx，很多人会连横线一起复制。
  // iCloud 两种都认，但去掉横线更保险，也免得用户以为自己填错了。
  const password = appPassword.replace(/[\s-]/g, "");
  const encoded = Buffer.from(`${appleId}:${password}`, "utf8").toString(
    "base64",
  );
  return `Basic ${encoded}`;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 307 || status === 308;
}

// ---------------------------------------------------------------------------
// 极简 XML 读取
// ---------------------------------------------------------------------------

/** 一个 XML 元素：只保留本地名（去掉命名空间前缀）、文本与子元素。 */
export interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
  /** 属性，只在需要读 `<href>` 之类时用得上。当前保留但不解析属性值以外的东西。 */
  attributes: Record<string, string>;
}

/**
 * 解析一段 XML。
 *
 * 返回根元素。**标签名去掉命名空间前缀**——CalDAV 里同一个属性在不同服务器上
 * 可能是 `d:href`、`D:href` 或 `href`，按前缀匹配的代码换个服务器就全瞎。
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = {
    name: "#document",
    text: "",
    children: [],
    attributes: {},
  };
  const stack: XmlNode[] = [root];
  const tagPattern = /<([^>]+)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const between = source.slice(lastIndex, match.index);
    const current = stack[stack.length - 1] ?? root;
    if (between.trim()) {
      current.text += decodeEntities(between);
    }
    lastIndex = tagPattern.lastIndex;

    const raw = (match[1] ?? "").trim();
    // 声明、注释、处理指令一律跳过
    if (!raw || raw.startsWith("?") || raw.startsWith("!")) continue;

    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const inner = selfClosing ? raw.slice(0, -1).trim() : raw;
    const [rawName, ...attrParts] = inner.split(/\s+/);
    const node: XmlNode = {
      name: localName(rawName ?? ""),
      text: "",
      children: [],
      attributes: parseAttributes(attrParts.join(" ")),
    };
    current.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** 深度优先找出所有同名元素。 */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === name) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** 找第一个同名元素。 */
export function find(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

/** 第一个同名元素的文本，去空白；找不到返回空串。 */
export function textOf(node: XmlNode, name: string): string {
  return find(node, name)?.text.trim() ?? "";
}

/** 直接子元素里找第一个同名的（用于区分 `<response>` 各自的 `<href>`）。 */
export function childOf(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attributes[localName(match[1] ?? "")] = decodeEntities(match[2] ?? "");
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    // & 必须最后处理，否则 &amp;lt; 会被解成 <
    .replace(/&amp;/g, "&");
}

/** 写 XML 文本节点时用。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
