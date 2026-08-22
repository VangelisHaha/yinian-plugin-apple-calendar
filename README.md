# yinian-plugin-apple-calendar

一念（Yinian）的 Apple 日历插件。两个方向，各自可独立开关：

| 方向 | 语义 |
|---|---|
| **Apple 日历 → 一念** | iCloud 上的日历落成一念里的**只读日历**，在月 / 周 / 甘特 / Agenda 上和本地事件一起展示 |
| **一念排期 → Apple 日历**（可选） | 一念里的**排期块**写进一个专用 Apple 日历，于是 iPhone 日历上就能看到今天要做什么。**单向镜像** |

零运行时依赖，只用 Node 20+ 标准库。

## 为什么走 CalDAV 而不是 EventKit

macOS 原生的 EventKit 走不通，这不是偷懒：

- **宿主拉起的子进程拿不到「日历」的 TCC 授权。** 插件是一念用 `node dist/main.mjs` 起的子进程，TCC 按 responsible process 归因到一念的 app bundle，而 bundle 必须在 `Info.plist` 里声明 `NSCalendarsFullAccessUsageDescription` 才可能拿到——那是宿主改动，不是插件能解决的。同一形态的问题在别的工具上有公开记录（claude-code #76936：Reminders 能过，Calendar 不能）。
- **一念是 ad-hoc 签名且每轮改动都覆盖安装**，TCC 记账会随 cdhash 变化反复失效，开发期每次装完都要重新授权一次。
- `osascript` 驱动 Calendar.app 同样要 Automation 授权，而且它的 AppleScript 词典对 RRULE 支持很差、批量操作极慢。

CalDAV 是纯 HTTPS，完全在插件进程内完成，不碰 TCC。

**代价**：只能看到 **iCloud 上的日历**。Mac 日历里挂在「我的电脑 / On My Mac」下的本机日历、以及某些订阅日历同步不到。

## 安装与配置

1. 到 [account.apple.com](https://account.apple.com) 生成一个 **App 专用密码**（要求账号已开双重认证）。它是 16 位，Apple 显示成 `xxxx-xxxx-xxxx-xxxx`。
2. 在一念的设置 → 插件里安装本插件，填 Apple 账号与 App 专用密码，点「测试连接」确认能列出日历。
3. 新建一个同步实例，选要同步哪些日历、拉取的时间窗口。
4. 需要排期镜像的话，在实例设置里打开「启用排期镜像」。

> **App 专用密码是长期有效的完整日历读写凭据**，而一念一期的插件是没有沙箱的普通用户态进程（契约 §9）。填进来等于把 iCloud 日历的读写权限交给本插件进程。不接受这一点就不要启用它。
>
> 另外：改过 Apple 账号主密码后，所有 App 专用密码会被自动吊销，需要重新生成一个填回来。

## 拉取方向的实现要点

### 增量策略

| 情况 | 做法 | `eventsComplete` |
|---|---|---|
| 首轮 / 用户点全量 / token 失效 | `calendar-query` 按时间窗口拉 | `true` |
| 有 sync-token | `sync-collection`（RFC 6578）只拿改动 | **`false`** |

`eventsComplete` 在增量轮次**必须是 `false`**。契约 §5.1.1 明说增量源开了它，宿主会把没出现在本次结果里的事件全判成远端删除——也就是每轮把历史事件集体标成取消。

同理，**空结果绝不声明 `eventsComplete: true`**：那等于让宿主把该实例下所有事件一次性标成取消。

### 为什么不用 sync-collection 做初始同步

`sync-token` 传空串时服务端会回**全部**资源，不受时间窗口约束。一个存了十年会议的 iCloud 账号初始同步要拉几千条，而没人会在一念里翻 2013 年的会议。所以初始一轮走 `calendar-query` 的时间窗口，只在拿到 token 之后才用增量。

### ICS 解析的几个坑

- **`DTEND` 是右开的**，一念的全天事件 `end_date` 也是右开，正好对上，**不要自己减一天**。只占 8/20 一天的事件在 ICS 里就是 `DTSTART;VALUE=DATE:20260820` / `DTEND;VALUE=DATE:20260821`。
- **折行必须先合并**。ICS 每行不超过 75 字节，超了折行、续行以空格或制表符开头。中文标题两三个字就超；不先合行的话长标题会被截成一半，后半截还会被当成未知属性丢掉。
- **`TZID` 要真的换算**。带 `TZID=Asia/Shanghai` 的时间不带偏移量，当 UTC 解会整体差 8 小时。这里用 `Intl` 反解偏移（夏令时也正确），不引 tzdata 依赖。
- **`VALARM` 要隔离**。提醒块里也有 `DESCRIPTION` 和 `SUMMARY`，不隔离的话提醒文案会变成事件备注。
- **重复事件的例外实例**（带 `RECURRENCE-ID`）与主事件共享同一个 `UID`。直接用 UID 当 `externalId` 会让它们互相覆盖，最后只剩一条，所以拼成 `<uid>::<recurrence-id>`。
- **零长事件补 15 分钟**。一念要求 `end` 晚于 `start`，零长会被判形状错误整条丢掉。

### 只含 VTODO 的集合会被跳过

那是「提醒事项」列表，不是日历。当成日历拉会得到一堆没有时间的条目。

## 镜像方向的实现要点

### 这是单向的，而且必须是单向的

在 Apple 侧改动镜像日历里的事件，下一轮同步会被覆盖回去。理由不是懒：

同步来的排期块，其权威在原系统（比如飞书项目的节点排期）。一念自己都不改它——契约 §5.1 的 `ExternalScheduleSlot` 就是这么定的。再给 Apple 一份写权限，就变成三方各持一份，merge 出来的结果和三方都不一致。这和 `docs/07` §13.1 拒绝 event 双向同步是同一条理由。

想在一念这侧可编辑，就别把它交给同步：手工建一个排期块。

### 幂等靠 UID

- 排期块 → `yinian-schedule-<block_id>`
- 截止时间 → `yinian-deadline-<task_id>`

于是改期就是 PUT 覆盖，不需要记账。窗口内做全量对账（不是清空重建——清空重建每轮都会让 iPhone 上的日历闪一下，还会把通知重推一遍）。

**只删自己前缀的资源。** 集合里出现前缀不匹配的东西就跳过：用户可能手动往这个日历里加过内容，插件没有资格替他删。

### 其他取舍

- **不镜像一念里的 Event**。它要么本来就来自某个外部日历（写回去等于回声），要么是用户手工建的（他自己知道）。镜像的价值只在排期。
- **取消的段不镜像**，直接从 Apple 侧删掉；**完成的段保留但标 `TRANSP:TRANSPARENT`**——「今天做完了什么」在日历上有回顾价值，但不该继续占忙时。
- 标题写成「任务标题 · 段名」。只写段名（「中台开发」）在 Apple 日历上认不出是哪个需求；只写任务标题又分不清同一任务的三段排期。这与一念甘特图上「条上只写段名」不冲突：那里有常驻左栏显示任务标题，Apple 日历没有。
- **截止时间默认不镜像**，打开后写成全天事件且一律标空闲——它回答「最晚什么时候完成」，钉在某个具体时刻上会让人误以为那是要开始做的时间。
- **镜像失败不影响拉取**。拉进来的日历数据已经算出来了，让镜像的一个 403 把它一起丢掉毫无道理。错误进插件日志，在诊断面板能看到。

### 需要一念 ≥ 0.7.0

镜像要读一念的 agenda，靠的是宿主在 `plugin.init` 里下发的 `apiToken`。这个 token **只带 manifest 声明过的 scope**（契约 §3.3），本插件声明了 `agenda:read` 与 `calendar:read`。

0.7.0 之前的一念不下发 token（`api_token` 是空串），此时插件会在启动日志里给出警告，**拉取方向照常工作**，只有镜像不可用。

插件**不写一念的库**（契约 §1 铁律 3）。镜像方向的写入全部发生在 CalDAV 那一侧。

## 开发

```bash
npm install
npm run verify          # build + doctor + 单测
npm run typecheck
npm run pack:zip        # 出可安装的 zip
```

### 用真凭据探测

单测覆盖不了「iCloud 到底允不允许」，所以有一个探针：

```bash
npm run build
APPLE_ID=you@icloud.com APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run probe
# 加 -- --write 才会验证 MKCALENDAR / PUT / DELETE（会建一个临时日历）
node scripts/probe.mjs --write
```

它回答四个问题：认证能不能过、发现链走不走通、`sync-collection` 支持不支持、**`MKCALENDAR` 允不允许**。最后一条决定镜像能不能自己建日历——不允许的话镜像得改成写进用户手工建好的日历。

凭据只从环境变量读，不落盘、不进日志。

## 已知边界

- **增量轮次的删除拿不到**。`sync-collection` 报告的删除是资源 URL，而 `externalId` 是 ICS 里的 UID，两者对不上（资源被删了也就读不到它的 UID）。所以远端删除只有在走全量窗口的那一轮才会被识别（靠宿主的 `eventsComplete` 机制）。表现是：在 Apple 上删掉一个事件，最长要等到下一次全量同步才会在一念里标成取消。手动点「全量同步」可以立刻对上。
- **重复事件只落主事件 + RRULE 原文**，不展开实例。一念自己的 occurrence 持久化也还没做（见 `docs/01-roadmap.md`），两边正好对齐。
- **只覆盖 iCloud 日历**，本机日历（On My Mac）与部分订阅日历同步不到。
- **不支持 Apple 之外的 CalDAV 服务端**。代码大体通用，但发现链的重定向处理与 `MKCALENDAR` 的路径 slug 是按 iCloud 的行为写的，没在 Fastmail / Nextcloud 上验证过。

## 相关文档

- 插件契约：一念仓库的 `docs/11-plugin-architecture.md`（**source of truth**）
- Event 与外部日历同步语义：`docs/07-event-calendar-design.md` §13
- 排期块与 Deadline 的分层建模：`docs/07-event-calendar-design.md`
