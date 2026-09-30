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
    'bubble.reminderLate': '啾…{time}的{task}已经过时间了',
    'bubble.missed': '啾…有 {count} 条提醒已经过时间了',
    'bubble.break': '啾…起来接杯水吧',
    'bubble.evening': '啾呜～今天做完了 {count} 件事',
    'bubble.dataError': '啾…任务数据好像出错了',
    'bubble.clipboard': '啾，提示词已复制，去输入框粘贴发送吧',
    'prompt.morning': '看看今天的待办和日程',
    'prompt.reminder': '处理刚才的提醒：{task}',
    'prompt.missed': '帮我看看刚才错过的提醒',
    'prompt.focus': '看看番茄钟状态',
    'prompt.break': '本轮专注了多久？休息一会儿',
    'prompt.schedule': '看看本周的日程安排',
    'prompt.evening': '帮我复盘今天的完成情况',
    'panel.title.pomodoro': '知知 · 番茄设置',
    'panel.title': '知知 · 设置',
    'panel.size': '大小',
    'panel.motion': '动画',
    'panel.pomodoro': '番茄设置',
    'panel.preview': '预览日程',
    'panel.hide': '隐藏',
    'panel.guide': '使用教程',
    'pomodoro.quick.prompt': '开始一个番茄钟：工作 {work} 分钟、休息 {break} 分钟',
    'tomato.aria': '番茄钟：点一下开始计时，正在计时时点一下停止',
    'pomodoro.work': '工作时长（分钟）',
    'pomodoro.break': '休息时长（分钟）',
    'pomodoro.fill': '填入设置',
    'pomodoro.start': '开始',
    'pomodoro.stop': '停止',
    'pomodoro.fill.prompt': '把番茄钟设为工作 {work} 分钟、休息 {break} 分钟',
    'pomodoro.start.prompt': '开始一个番茄钟',
    'pomodoro.stop.prompt': '停止番茄钟',
    'confirm.body': '确认后会把这段提示词填入主对话框，并覆盖输入框里现在的内容。',
    'confirm.cancel': '取消',
    'confirm.accept': '确认填入',
    'guide.prompt': '打开知更鸟桌宠的使用教程：直接展示插件里固定的 guide/index.html，不要重新生成',
    'action.restore': '唤回知知',
    'agenda.title': '日程',
    'agenda.upcoming': '即将到来',
    'agenda.empty': '暂时没有安排',
    'agenda.preview': '详情',
    'agenda.prompt': '把日程整体预览一下：先看未来要发生的事，再看最近一个月已经发生的',
    'agenda.more': '还有 {count} 件未列出',
    'agenda.kind.task': '待办',
    'agenda.kind.schedule': '日程',
    'aria.pet': '任务桌宠：点击将当前场景的提示词填入主输入框',
    'aria.badge': '{count} 件待办与日程，点击查看列表',
    'aria.countdown': '番茄钟剩余 {minutes} 分钟',
    'plugin.description': '知更鸟日常事务桌宠：六场景、任务提醒、番茄钟与提示词注入',
  }),
  en: Object.freeze({
    'bubble.morning': 'Chirp chirp, good morning! {count} things today',
    'bubble.morning.empty': 'Chirp chirp, good morning! Nothing scheduled today',
    'bubble.reminder': 'Chirp! It is {time} — time for {task}',
    'bubble.reminderLate': 'Chirp… {task} at {time} is overdue',
    'bubble.missed': 'Chirp… {count} reminders passed while I was away',
    'bubble.break': 'Chirp… time for a glass of water',
    'bubble.evening': 'Chirp… {count} things done today',
    'bubble.dataError': 'Chirp… the task data looks broken',
    'bubble.clipboard': 'Chirp — prompt copied, paste it into the composer to send',
    'prompt.morning': 'Show today\'s todos and schedule',
    'prompt.reminder': 'Handle the reminder: {task}',
    'prompt.missed': 'Show me the reminders I just missed',
    'prompt.focus': 'Show the pomodoro status',
    'prompt.break': 'How long was this focus round? Time for a break',
    'prompt.schedule': 'Show this week\'s schedule',
    'prompt.evening': 'Help me review what got done today',
    'panel.title.pomodoro': 'Robin · Pomodoro',
    'panel.title': 'Robin · Settings',
    'panel.size': 'Size',
    'panel.motion': 'Motion',
    'panel.pomodoro': 'Pomodoro',
    'panel.preview': 'Preview schedule',
    'panel.hide': 'Hide',
    'panel.guide': 'How to use',
    'pomodoro.quick.prompt': 'Start a pomodoro: {work} minutes of work, {break} minutes of break',
    'tomato.aria': 'Pomodoro: click to start the timer, click again to stop',
    'pomodoro.work': 'Work minutes',
    'pomodoro.break': 'Break minutes',
    'pomodoro.fill': 'Fill settings',
    'pomodoro.start': 'Start',
    'pomodoro.stop': 'Stop',
    'pomodoro.fill.prompt': 'Set the pomodoro to {work} minutes of work and {break} minutes of break',
    'pomodoro.start.prompt': 'Start a pomodoro',
    'pomodoro.stop.prompt': 'Stop the pomodoro',
    'confirm.body': 'Confirming fills the main composer with this prompt and replaces whatever is in the box now.',
    'confirm.cancel': 'Cancel',
    'confirm.accept': 'Fill the composer',
    'guide.prompt': 'Open the task pet tutorial: show the fixed guide/index.html shipped with the plugin, do not regenerate it',
    'action.restore': 'Bring the robin back',
    'agenda.title': 'Agenda',
    'agenda.upcoming': 'Upcoming',
    'agenda.empty': 'Nothing on the list',
    'agenda.preview': 'Details',
    'agenda.prompt': 'Give me the whole picture: what is coming up first, then what happened over the past month',
    'agenda.more': '{count} more not listed',
    'agenda.kind.task': 'Todo',
    'agenda.kind.schedule': 'Event',
    'aria.pet': 'Task pet: click to fill the composer with the current scene prompt',
    'aria.badge': '{count} open items — click to view the list',
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
