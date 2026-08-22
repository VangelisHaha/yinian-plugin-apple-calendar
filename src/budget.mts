/**
 * action 的时间预算。
 *
 * 自定义方法（含 action）只有 **15 秒**超时（SDK 的 `TIMEOUTS.custom`），超了宿主
 * 直接杀进程并记 `PLUGIN_RPC_TIMEOUT`。而「测试镜像写入」要做 6 次 CalDAV 往返
 * （发现链 3 次 + 建日历 + 写 + 删），iCloud 慢的时候单靠「把单次超时调小」压不住：
 * 6 × 3 秒就已经 18 秒了。
 *
 * 所以按剩余预算走：每一步问一次还剩多少，不够就**提前返回已经验证到的部分结论**。
 * 被宿主杀掉的话用户只看到「插件超时」，什么信息都没有；提前返回至少能告诉他
 * 「读通了，写没测完」。
 */

/** 留给序列化与返回的余量，别把预算用到最后一毫秒。 */
const SAFETY_MARGIN_MS = 1_500;

export class Budget {
  private readonly deadline: number;

  constructor(totalMs: number) {
    this.deadline = Date.now() + Math.max(0, totalMs - SAFETY_MARGIN_MS);
  }

  /** 还剩多少秒可用，向下取整。 */
  remainingSeconds(): number {
    return Math.max(0, Math.floor((this.deadline - Date.now()) / 1000));
  }

  /**
   * 下一步该用多长的单次超时。
   *
   * 取「剩余预算」与 `preferred` 的较小值：剩得多也不必给一步太长，
   * 一步卡住不该把后面几步的机会全吃掉。
   */
  stepTimeout(preferred: number): number {
    return Math.min(preferred, Math.max(1, this.remainingSeconds()));
  }

  /** 预算是否还够做一步。低于 2 秒就别开始了，开了也做不完。 */
  canContinue(): boolean {
    return this.remainingSeconds() >= 2;
  }
}
