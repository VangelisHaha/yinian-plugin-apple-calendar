import assert from "node:assert/strict";
import { test } from "node:test";

import { Budget } from "../dist/budget.mjs";

test("单步超时不超过剩余预算", () => {
  const budget = new Budget(15_000);
  // 15s 预算扣掉 1.5s 余量约 13s，想要 4s 就给 4s
  assert.equal(budget.stepTimeout(4), 4);
  // 想要的比剩余还多时，收敛到剩余
  assert.ok(budget.stepTimeout(60) <= 14);
});

test("预算耗尽时停下而不是硬撞宿主超时", () => {
  const exhausted = new Budget(1_000);
  assert.equal(
    exhausted.canContinue(),
    false,
    "剩不到两秒就别开始下一步了，开了也做不完",
  );
  assert.ok(
    exhausted.stepTimeout(4) >= 1,
    "单次超时不能是 0，那会让请求立刻失败而不是快速失败",
  );
});

test("余量确保不会把预算用到最后一毫秒", () => {
  // 预算刚好等于余量时，剩余就该是 0：没有时间留给序列化与返回
  assert.equal(new Budget(1_500).remainingSeconds(), 0);
  assert.equal(new Budget(0).remainingSeconds(), 0);
});

test("充足预算下可以继续", () => {
  assert.equal(new Budget(15_000).canContinue(), true);
});
