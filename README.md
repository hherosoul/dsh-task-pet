# dsh-task-pet · 知更鸟桌宠「知知」

一只常驻在 DeepSeek Harness（DSH）窗口里的小知更鸟「知知」，按当天节奏陪你规划、提醒、专注与复盘。

> 这是窗口内插件，不是独立的系统级桌面悬浮窗。所有交互走 DSH 主对话框：点击桌宠会把对应场景的提示词注入输入框（不自动发送）。

**新手先读 → [使用教程 TUTORIAL.md](TUTORIAL.md)**：安装、六场景、提醒规则、两个数字的口径、右键面板、番茄钟、数据契约与写法建议、排错、隐私边界。

## 功能

- **六场景自动切换**：晨间规划、任务提醒、专注陪伴、休息提醒、日程预览（默认）、晚间复盘。
- **提醒与番茄钟**：`remind_at` 到期触发「任务提醒」场景（优先级最高）；`settings.pomodoro` 驱动专注/休息倒计时。
- **数据单一真相源**：`data/tasks.json` 由 DSH agent 写入（`task_pet_read` / `task_pet_write` 或按 schema 直接写文件）。唯一的例外是番茄钟的运行状态：你在桌宠上点番茄时，host 走一条窄写入路径只改 `settings.pomodoro`，其余字段原样保留。
- **提示词注入**：点击桌宠把场景提示词写入 DSH 输入框草稿，不自动发送。
- 拖拽 / 缩放 / 隐藏，中英双语，亮暗主题，减少动效支持。

## Quickstart

1. 把本仓库安装进一个全新 profile（首次使用会初始化 `@deepseek-ai/dsh-base`）。两种方式任选：

```sh
dsh plugin --profile demo add github:hherosoul/dsh-task-pet   # 直接从 GitHub 安装
dsh plugin --profile demo add /path/to/dsh-task-pet           # 或克隆后从本地目录安装
```

2. 不启动地确认层存在（期望出现 `# == dsh-task-pet` 层）：

```sh
dsh --profile demo --dump-config
```

3. 用 **Web 应用**启动并确认桌宠出现：

```sh
dsh web --profile demo --no-open      # 去掉 --no-open 让浏览器自动打开
```

> 桌宠是窗口内 UI：本插件 `inject = ['agents', 'tools', 'webServer']`，只在含 Web 应用的 profile（`web`、桌面应用）里激活。若 profile 只有 `@deepseek-ai/dsh-base`（纯 CLI），该行会停在
> `task-pet (dsh-task-pet): pending (waiting for service: webServer)`——这是声明式依赖的正常表现，不是加载失败。

移除：`dsh plugin --profile demo remove dsh-task-pet`。

## 配置

可调参数全部走插件行 `config`，由 schema 校验并把默认值写在 schema 里；取值非法会在加载期**直接报错**，不会静默回退默认值：

| 字段 | 默认 | 范围 / 说明 |
|---|---|---|
| `dataDir` | `''`（= `$DSH_HOME/task-pet`） | tasks.json 所在目录；相对路径按进程 cwd 解析 |
| `pollIntervalMs` | `30000` | tasks.json mtime 轮询间隔，1000–3600000 |
| `bridgeQueueLimit` | `128` | 每个浏览器客户端缓存的桥帧上限，2–1024 |

在 profile 的 `cordis.patch.yml`（或 `--patch` 覆盖层）里覆盖时**整行重述**：

```yaml
- insert:
    - id: task-pet
      name: dsh-task-pet
      config:
        dataDir: /path/to/tasks-dir
        pollIntervalMs: 15000
```

（层序铁律：后应用的层按行整体替换，不深合并——覆盖时要写全该行需要的每个键。）

## 数据契约（data/tasks.json）

数据文件默认位于 `$DSH_HOME/task-pet/tasks.json`（可用插件配置 `dataDir` 覆盖）。**唯一写入方是 DSH agent**：先 `task_pet_read` 读全量文档，改完再 `task_pet_write` 写回完整文档。插件主机侧只读，默认 30 秒 mtime 轮询（`pollIntervalMs`）；文件损坏时保留上一份有效快照并在气泡中提示错误。

- 时间一律 ISO 8601 且带时区；`task.remind_at` 驱动提醒场景（`status === "pending"` 时在 30s 内触发）。
- 过时判定只看条目**自己的那个时刻**：任务 `due`（会议＝开始时刻）、日程 `start`；日程写了 `end` 才当**明确的 deadline**，那时按 `end` 判。过时后不再提醒、不上角标，只在「详情」预览里以「过期」出现。
- 完成重复任务时由 agent 自行创建下一个实例（`status: "completed"` + `completed_at`）。
- `settings.pomodoro.running_since`（ISO 时间戳）启动番茄钟，`null` 停止。
- `settings.evening_time`（`HH:mm`，默认 `18:30`）调度晚间复盘。

完整 schema 见 [data/tasks.schema.json](data/tasks.schema.json)，示例见 [data/tasks.example.json](data/tasks.example.json)。

## 番茄钟

- 小鸟**右下角的番茄图标**：点一下直接用当前设置开始计时（默认 45 / 10 分钟），正在计时时点一下停止。
- 这是插件唯一的写入路径，且是**窄写入**：只改 `settings.pomodoro`（`POST /task-pet/pomodoro`，仅回环 + 自定义请求头），其余字段原样保留；数据语义的写入方仍然是 agent。
- 改时长有两条路：右键 →「番茄设置」→ 填好分钟数后点**「开始」**直接生效（窄写入，立即应用你填的数字）；或点**「填入设置」**把提示词交给 agent 落盘（顺带把新时长写进默认设置）。

## 使用教程页（固定文档）

`guide/index.html` 是随包发布的**固定教程页**：自包含（六张场景缩略图已内联，无网络依赖），由 `src/guide.html` + `images/thumb/*.png` 在 `npm run build` 时生成。

- 桌宠右键 →「使用教程」会把提示词 `打开知更鸟桌宠的使用教程：直接展示插件里固定的 guide/index.html，不要重新生成` 填入主对话框，用户发送后由 agent **直接展示这个文件**。
- **不要每次重新生成它**：内容只随插件功能变化而修改——改 `src/guide.html`（或 `images/thumb/`），然后重新构建即可。

## 六场景

| 场景 | 触发 | 点击注入的提示词 |
|---|---|---|
| 晨间规划 | 当天第一次启动/交互，且在 **上午 10:00 前** | `看看今天的待办和日程` |
| 任务提醒 | `remind_at` 到期（优先级最高） | `处理刚才的提醒：{任务名}` |
| 专注陪伴 | DSH 会话执行中，或番茄钟工作段 | `看看番茄钟状态` |
| 休息提醒 | 番茄钟休息段，或连续专注满 50 分钟 | `本轮专注了多久？休息一会儿` |
| 日程预览 | 默认待机 | `看看本周的日程安排` |
| 晚间复盘 | 默认 18:30 之后，或 17:00 后当天会话都结束 | `帮我复盘今天的完成情况` |

> 两个数字口径不同：早间「今天有 {N} 件事」数的是**日程**（未过时、且自己的时刻落在今天）；晚间「今天做完了 {K} 件事」数的是**你今天在 DSH 完成的对话轮数**。详见教程第 07 节。

## 开发与本地预览

需要 Node.js 22+。

```sh
npm install
npm run build
npm test
```

构建会重新生成 bridge 契约、客户端 bundle 和离线预览。用浏览器直接打开本地生成文件（无需 web 服务器）：

```text
preview/index.html
```

预览不连接 DSH、不调用模型，六张场景 PNG 以 base64 data URL 内联（避免 canvas CORS 污染）。

## 质量检查

优先使用 dsh-plugins-builder 提供的 `plugin_validate` 工具；CLI 回退（用 dsh-plugins-builder 安装目录）：

```sh
node <dsh-plugins-builder 安装目录>/scripts/validate_plugin.js <本插件目录>
node <dsh-plugins-builder 安装目录>/scripts/verify_plugin.js <本插件目录>
```

运行时层（L3/L5）需要 `dsh` CLI；缺失时诚实降级（exit 3，未达可发布标准）。

## 隐私与运行边界

- 不修改 DSH 本身、不发送模型消息、不新增模型调用、不代你确认任何操作。
- 复用 DSH 现有的已认证连接；不额外监听端口、无遥测、无运行时字体/CDN 请求。
- 会话桥只投射必要的会话身份与轮次边界元数据，不投射聊天内容。
- 偏好存于客户端本地存储。测试全部使用合成数据；仓库不含任何用户 profile、会话记录或提取的 DSH 实现代码。
- 公开发布只含别人下载后能直接用的东西（源码、构建产物、schema、合成示例、文档、场景图）；本机验收证据 `qa/` 与开发覆盖层 `dev/` 不入库（见 `.gitignore`）。

## 环境要求

- Node.js 22+ 与 npm（开发 / 构建）。
- `dsh` CLI ≥ `0.1.7-rc.1`（安装与启动；本包已在 `0.2.0-rc.2` 上跑通安装式验收）。
- 启动无需 API key；工具行为的模型级验证需已配置模型。
- npm 包内容：`lib/`（构建产物）、`src/`（源码）、`images/*.png`（六张场景图）、`data/`（契约与示例）、`cordis.patch.yml`、`README.md`、`LICENSE`。仓库里的 `images/_original/`（原图）不入包。
