/**
 * Simplified Chinese dictionary (the key-set source of truth).
 * Add a new key here, then mirror it in `./en.ts`.
 */
export const zh = {
  cardRunning: '执行中…',
  cardDone: '完成',
  cardFailed: '失败',
  expandInput: '展开输入',
  collapseInput: '收起输入',
  expandOutput: '展开输出',
  collapseOutput: '收起输出',
  bannerPrefix: '⚠ 工具调用长时间未响应：',
  bannerRunning: '（已运行 {s}s）',
  skip: '跳过',
  cardDesc: '第三方模型 ToolCall 兼容（schema 清理）与无响应调用跳过',
  enabledTitle: 'ToolCall 兼容模式',
  enabledDesc: '自动清理工具调用中非法或冗余的 sandbox_permissions / justification（Full access 下全部清理），合法提权请求保留并走审批',
  escapesTitle: '展开时渲染转义字符',
  escapesDesc: '展开工具调用卡片时把参数与输出中的转义序列（\\n、\\" 等）渲染为实际字符',
  thresholdTitle: '无响应提示阈值',
  thresholdDesc: '工具调用运行超过该时长后显示未响应提示（1–600 秒）',
  secondsUnit: '秒',
  thresholdAria: '无响应提示阈值（秒）',
  expandSettings: '展开设置',
  collapseSettings: '收起设置',
}

/** Locale key set, shared with every other dictionary. */
export type LocaleKey = keyof typeof zh
