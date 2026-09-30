# dsh-task-pet · 知更鸟桌宠「知知」

一只常驻在 DeepSeek Harness（DSH）窗口里的小知更鸟「知知」，按当天节奏陪你规划、提醒、专注与复盘。

> 这是窗口内插件，不是独立的系统级桌面悬浮窗。所有交互走 DSH 主对话框：点击桌宠会把对应场景的提示词注入输入框（不自动发送）。

## 功能

- **六场景自动切换**：晨间规划、任务提醒、专注陪伴、休息提醒、日程预览（默认）、晚间复盘。
- **提醒与番茄钟**：`remind_at` 到期触发「任务提醒」场景（优先级最高）；`settings.pomodoro` 驱动专注/休息倒计时。
- **数据单一真相源**：桌宠只读 `data/tasks.json`，唯一写入方是 DSH agent（通过 `task_pet_read` / `task_pet_write` 工具或对 schema 的直接文件写入）。
- **提示词注入**：点击桌宠把场景提示词写入 DSH 输入框草稿，不自动发送。
- 拖拽 / 缩放 / 隐藏，中英双语，亮暗主题，减少动效支持。

## Quickstart

1. 把本目录安装进一个全新 profile（首次使用会初始化 `@deepseek-ai/dsh-base`）：

```sh
dsh plugin --profile demo add /path/to/dsh-task-pet
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
- 完成重复任务时由 agent 自行创建下一个实例（`status: "completed"` + `completed_at`）。
- `settings.pomodoro.running_since`（ISO 时间戳）启动番茄钟，`null` 停止。
- `settings.evening_time`（`HH:mm`，默认 `18:30`）调度晚间复盘。

完整 schema 见 [data/tasks.schema.json](data/tasks.schema.json)，示例见 [data/tasks.example.json](data/tasks.example.json)。

## 六场景

| 场景 | 触发 | 点击注入的提示词 |
|---|---|---|
| 晨间规划 | 早起至晚间前，有今日任务数 | 列出今日任务并规划优先级 |
| 任务提醒 | `remind_at` 到期（优先级最高） | 处理该提醒任务 |
| 专注陪伴 | 番茄钟 work 阶段 | 开始专注 |
| 休息提醒 | 番茄钟 break 阶段 | 休息一下 |
| 日程预览 | 默认 | 预览今日日程 |
| 晚间复盘 | `evening_time` 之后 | 复盘今日完成情况 |

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

## 环境要求

- Node.js 22+ 与 npm（开发 / 构建）。
- `dsh` CLI ≥ `0.1.7-rc.1`（安装与启动；本包已在 `0.2.0-rc.2` 上跑通安装式验收）。
- 启动无需 API key；工具行为的模型级验证需已配置模型。
- npm 包内容：`lib/`（构建产物）、`src/`（源码）、`images/*.png`（六张场景图）、`data/`（契约与示例）、`cordis.patch.yml`、`README.md`、`LICENSE`。仓库里的 `images/_original/`（原图）不入包。
