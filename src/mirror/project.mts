/**
 * 排期镜像的投影：一念 agenda → 应该存在于 Apple 日历里的一组事件。
 *
 * **纯函数，不碰网络**。镜像的全部语义判断都在这里，好让「哪些该写、哪些该删、
 * 标题长什么样」可以用单测钉住，而不用连真的 iCloud。
 *
 * 方向是**一念 → Apple，单向**。在 Apple 侧改这个日历里的事件，下一轮会被覆盖。
 * 理由：同步来的排期块权威在原系统（飞书项目的节点排期），一念自己都不改它
 * （契约 §5.1 的 `ExternalScheduleSlot`），再给 Apple 一份写权限只会让三方各不一致。
 */

import type { AgendaItem, ScheduleBlock, TaskBrief } from "../host.mjs";

/** UID 前缀。靠它认出「这个日历里哪些事件是我写的」。 */
export const MIRROR_UID_PREFIX = "yinian-schedule-";
export const MIRROR_DEADLINE_PREFIX = "yinian-deadline-";

/** 一条要镜像的事件。 */
export interface MirrorEvent {
  uid: string;
  summary: string;
  description: string;
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  /** 已完成 / 已取消的段不占忙时。 */
  transparent: boolean;
}

export interface ProjectOptions {
  includeDeadlines: boolean;
}

/**
 * 把 agenda 投影成镜像事件。
 *
 * 三条取舍：
 *
 * 1. **只镜像排期块，不镜像一念里的 Event**。Event 要么本来就来自某个外部日历
 *    （再写回去等于回声），要么是用户手工建的（他自己知道）。镜像的价值只在排期。
 * 2. **已取消的段不镜像**，直接从 Apple 侧删掉。已完成的段保留但标空闲——
 *    「今天做完了什么」在日历上是有价值的回顾。
 * 3. **UID 用排期块 id**，于是改期就是 PUT 覆盖，天然幂等，不需要记账。
 */
export function project(
  items: AgendaItem[],
  options: ProjectOptions,
): MirrorEvent[] {
  const events: MirrorEvent[] = [];

  for (const item of items) {
    if (item.kind === "schedule") {
      const event = fromScheduleBlock(item.scheduleBlock, item.task);
      if (event) events.push(event);
      continue;
    }
    if (item.kind === "deadline" && options.includeDeadlines) {
      const event = fromDeadline(item.task);
      if (event) events.push(event);
    }
  }

  return events;
}

function fromScheduleBlock(
  block: ScheduleBlock,
  task: TaskBrief,
): MirrorEvent | null {
  // 取消的段不该出现在日历上
  if (block.status === "canceled") return null;
  if (!block.plannedStartAt || !block.plannedEndAt) return null;

  const start = Date.parse(block.plannedStartAt);
  const end = Date.parse(block.plannedEndAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  return {
    uid: `${MIRROR_UID_PREFIX}${block.id}`,
    summary: summaryFor(block, task),
    description: descriptionFor(block, task),
    allDay: false,
    startAt: new Date(start).toISOString(),
    // 零长或反向的段补 15 分钟：Apple 日历对零长事件的显示不可靠
    endAt: new Date(end > start ? end : start + 15 * 60_000).toISOString(),
    transparent: block.status === "finished" || block.status === "unfinished",
  };
}

function fromDeadline(task: TaskBrief): MirrorEvent | null {
  if (!task.dueAt) return null;
  const due = Date.parse(task.dueAt);
  if (Number.isNaN(due)) return null;

  // 截止时间做成全天事件：它回答「最晚什么时候完成」，钉在某个具体时刻上
  // 会让人误以为那是要开始做的时间。end_date 右开，所以是次日。
  const date = new Date(due).toISOString().slice(0, 10);
  return {
    uid: `${MIRROR_DEADLINE_PREFIX}${task.id}`,
    summary: `截止：${task.title}`,
    description: "来自一念的任务截止时间",
    allDay: true,
    startDate: date,
    endDate: addDays(date, 1),
    // 截止是个标记而不是一段占用，绝不能标忙
    transparent: true,
  };
}

/**
 * 事件标题。
 *
 * 有段名时写成「任务标题 · 段名」。段名本身（「中台开发」）单独放在 Apple 日历上
 * 看不出是哪个需求的开发，而任务标题单独放又分不清同一任务的三段排期——
 * 这与甘特图上「条上只写段名」是不同场景：那里左栏常驻显示任务标题，这里没有左栏。
 */
export function summaryFor(block: ScheduleBlock, task: TaskBrief): string {
  const label = block.label?.trim();
  const title = task.title.trim() || "（无标题任务）";
  return label ? `${title} · ${label}` : title;
}

function descriptionFor(block: ScheduleBlock, task: TaskBrief): string {
  const lines = ["由一念（Yinian）的排期镜像生成，在这里的修改会被下一次同步覆盖。"];
  if (task.status) lines.push(`任务状态：${task.status}`);
  if (block.status) lines.push(`排期状态：${block.status}`);
  if (block.integrationId) {
    lines.push("这段排期来自外部同步源，排期权威在原系统。");
  }
  return lines.join("\n");
}

/** 本插件写入的资源都以固定前缀开头，diff 时靠它区分「我写的」和「别人的」。 */
export function isMirrorUid(uid: string): boolean {
  return (
    uid.startsWith(MIRROR_UID_PREFIX) || uid.startsWith(MIRROR_DEADLINE_PREFIX)
  );
}

/** 镜像资源在 CalDAV 集合里的文件名。用 UID 保证幂等。 */
export function resourceNameFor(uid: string): string {
  return `${uid}.ics`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
