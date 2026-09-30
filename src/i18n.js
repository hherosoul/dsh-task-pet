/** Bilingual messages (zh/en). Locale handling follows the whale-pet mechanism:
 * the active DSH client locale selects the table, with en as fallback. */
export const FALLBACK_LOCALE = 'en';

/** Map a DSH locale (e.g. 'zh-CN', 'zh_CN', 'en-US') to our two-table key. */
export function normalizeLanguage(locale) {
  const raw = String(locale ?? '').toLowerCase();
  return raw.startsWith('zh') ? 'zh' : FALLBACK_LOCALE;
}

export const MESSAGES = Object.freeze({
  zh: Object.freeze({
    'bubble.morning': '啾啾早安！今天有 {count} 件事',
    'bubble.morning.empty': '啾啾早安！今天暂时没有安排',
    'bubble.reminder': '啾！{time}了，该{task}了',
    'bubble.break': '啾…起来接杯水吧',
    'bubble.evening': '啾呜～今天做完了 {count} 件事',
    'bubble.dataError': '啾…任务数据好像出错了',
    'bubble.clipboard': '啾，提示词已复制，去输入框粘贴发送吧',
    'prompt.morning': '看看今天的待办和日程',
    'prompt.reminder': '处理刚才的提醒：{task}',
    'prompt.focus': '看看番茄钟状态',
    'prompt.break': '本轮专注了多久？休息一会儿',
    'prompt.schedule': '看看本周的日程安排',
    'prompt.evening': '帮我复盘今天的完成情况',
    'panel.title': '知知 · 设置',
    'panel.size': '大小',
    'panel.motion': '动画',
    'panel.hide': '隐藏',
    'panel.reset': '回到默认位置',
    'action.restore': '唤回知知',
    'aria.pet': '任务桌宠：点击将当前场景的提示词填入主输入框',
    'aria.badge': '{count} 条到期未处理的提醒',
    'aria.countdown': '番茄钟剩余 {minutes} 分钟',
    'plugin.description': '知更鸟日常事务桌宠：六场景、任务提醒、番茄钟与提示词注入',
  }),
  en: Object.freeze({
    'bubble.morning': 'Chirp chirp, good morning! {count} things today',
    'bubble.morning.empty': 'Chirp chirp, good morning! Nothing scheduled today',
    'bubble.reminder': 'Chirp! It is {time} — time for {task}',
    'bubble.break': 'Chirp… time for a glass of water',
    'bubble.evening': 'Chirp… {count} things done today',
    'bubble.dataError': 'Chirp… the task data looks broken',
    'bubble.clipboard': 'Chirp — prompt copied, paste it into the composer to send',
    'prompt.morning': 'Show today\'s todos and schedule',
    'prompt.reminder': 'Handle the reminder: {task}',
    'prompt.focus': 'Show the pomodoro status',
    'prompt.break': 'How long was this focus round? Time for a break',
    'prompt.schedule': 'Show this week\'s schedule',
    'prompt.evening': 'Help me review what got done today',
    'panel.title': 'Robin · Settings',
    'panel.size': 'Size',
    'panel.motion': 'Motion',
    'panel.hide': 'Hide',
    'panel.reset': 'Reset position',
    'action.restore': 'Bring the robin back',
    'aria.pet': 'Task pet: click to fill the composer with the current scene prompt',
    'aria.badge': '{count} due unhandled reminders',
    'aria.countdown': 'Pomodoro: {minutes} minutes left',
    'plugin.description': 'Robin daily-task desk pet: six scenes, task reminders, pomodoro and prompt injection',
  }),
});

/** Create a translate thunk. Unknown keys fall back to en, then to the key. */
export function createTranslator(locale) {
  const active = MESSAGES[locale] ? locale : FALLBACK_LOCALE;
  return (key, params) => {
    let text = MESSAGES[active][key] ?? MESSAGES[FALLBACK_LOCALE][key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  };
}
