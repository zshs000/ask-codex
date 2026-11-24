# ask-codex

让 Claude Code 把任务交给你已经打开的 Codex 桌面对话，等它答完，把最终回复拿回来。

**[看动画演示 →](https://zshs000.github.io/ask-codex/)**

- **两端都不用装东西**：Claude Code 不注册 MCP、不配 hook、不装 skill；Codex 不装插件、不改配置。
- **没有常驻进程**：一条命令，一个约 500 行的单文件，零第三方依赖。
- **用的是真实的桌面对话**：上下文保留，你能在 Codex 界面里看着它工作，随时接手。
- **不用盯着**：等待交给 Claude Code 的后台任务。Claude 可以继续干别的，也可以停下来；Codex 答完时它会被自动唤醒。

## 为什么做这个

你在 Codex 桌面应用里有一个对话，已经读过代码、积累了上下文。现在想让 Claude Code 去问它一件事，再根据回答继续工作。

常见做法各有代价：

- 另起一个 `codex exec` 会话：之前的上下文用不上，过程也不在桌面界面里。
- 接入桥接工具：通常要在一端或两端注册 MCP、安装插件，或启动后台服务。
- 靠 Codex 主动回信：还要求它记得回。

ask-codex 只做一件事：把一个已有的 Codex 桌面对话，变成 Claude Code 可以调用、等待、纠偏和停止的任务端点。

## 快速开始

需要 Windows、Node.js 20 或更高版本，以及正在运行的 Codex 桌面应用。无需 `npm install`。

```bash
node ask-codex.cjs --check
node ask-codex.cjs <threadId> "请检查上传接口，并说明发现的问题。"
```

`<threadId>` 是 Codex 对话链接 `codex://threads/<threadId>` 中的 ID。先在桌面应用中创建或打开目标对话。同一个 ID 可以反复调用，上下文一直保留。

想要全局命令：

```bash
npm install -g .
ask-codex <threadId> "请继续检查刚才的问题。"
```

Git Bash 也可以执行 `bash ./ask-codex`，Windows 终端可以用 `ask-codex.cmd`。

## 配合 Claude Code

对 Claude 说一句话就够了，例如：

> 用后台 Bash 运行 `node <项目路径>/ask-codex.cjs <threadId> "检查上传接口的并发问题"`，Codex 回复后告诉我结论。

经常用的话，把这条命令写进项目的 `CLAUDE.md`。

Claude 以 `run_in_background=true` 启动命令后就不再被占用：

- **stdout** 只输出最终回复。
- **stderr** 输出请求编号、状态和 Codex 的中间回复。Claude 可以在任务结束前读取，判断方向对不对。
- **进程退出**时，Claude Code 的后台任务系统通知 Claude。Claude 正在忙或已经停下来，都能收到。每条新增日志不会唤醒 Claude，只有进程结束才会。

一次调用的输出大致如下（示例）：

```text
[ask-codex] request=ask-codex-7f3a1c52-…
[ask-codex] resume: ask-codex --resume ask-codex-7f3a1c52-…
[ask-codex] progress: ask-codex --status ask-codex-7f3a1c52-…
[ask-codex] Sent to 019a2b7e-…; waiting for reply
[ask-codex] Matched turn=<turnId>
[ask-codex] Codex commentary: 我先看上传接口的处理函数。
[ask-codex] Completed
上传接口有两处并发问题：……
```

最后一行来自 stdout，其余来自 stderr。

## 和其他做法的区别

| 做法 | 用已有的桌面对话 | 两端要装什么 | 常驻进程 | 结果怎么回来 |
|---|---|---|---|---|
| 直接调用 `codex exec` | 否，另起会话 | 无 | 无 | 进程输出 |
| MCP 或插件桥接 | 多数是工具自己管理的会话 | 注册 MCP 或安装插件 | 通常有随会话运行的服务进程 | 工具返回值或任务查询 |
| 消息代理 | 部分支持，常需先注册会话 | 通常两端都要装 | 多数需要 | 依赖对方主动回信 |
| 界面自动化 | 是 | 通常要注册 MCP | 视实现而定 | 读取本地会话记录 |
| **ask-codex** | **是** | **无** | **无** | **按轮次状态自动取回最终回复** |

上表按常见技术路线归纳，具体项目各有差异。

ask-codex 不是多 agent 编排框架，没有工作流、模型路由或新的界面。它只负责 Claude Code 到 Codex 桌面对话这一个方向的任务调用。

## 它是怎么做到的

**借 Codex 自带的通道。** Codex 桌面应用自带 app-tools 插件，里面有 `read_thread` 和 `send_message_to_thread` 两个工具。ask-codex 把这个插件作为子进程启动，用它收发消息，自己不实现任何通信协议，也不往 Codex 里装东西。

**借 Claude Code 的后台任务。** 等待由一个普通的 Node 进程承担。进程退出就是完成信号，通知和唤醒都由 Claude Code 完成，ask-codex 没有写任何回调或唤醒逻辑。

**用请求编号找到那一轮。** 发送接口不返回轮次 ID。ask-codex 给每次派发生成唯一编号，写进消息正文，再从对话历史里按编号反查出对应轮次，并把轮次 ID 固定下来。之后只看这一轮：

- 状态变为 `completed` 才算完成。
- 只提取标记为最终答案的消息，中间回复不进入结果。
- 没有最终答案，或最终答案被截断，直接报错，不返回残缺内容。

完成判断不需要 Codex 配合。它不用主动回信，也不用输出约定的结束标记。

**不重发。** 请求状态每一步都先落盘。派发结果不明时只按编号查找，找不到就报错，不会自动再发一次。

## 命令参考

| 命令 | 作用 |
|---|---|
| `ask-codex <threadId> <message>` | 派发任务，等待并输出最终回复 |
| `ask-codex <threadId> --message-file <file>` | 从 UTF-8 文件读取消息 |
| `ask-codex <threadId> --stdin` | 从 stdin 读取消息 |
| `ask-codex --status <requestId>` | 查看轮次状态和中间回复，输出 JSON |
| `ask-codex --steer <requestId> <message>` | 向正在运行的轮次补充要求 |
| `ask-codex --stop <threadId>` | 停止目标对话的当前轮次 |
| `ask-codex --resume <requestId>` | 恢复等待一个已派发的请求 |
| `ask-codex --check` | 检查与 Codex 的连接 |

| 选项 | 作用 |
|---|---|
| `--json` | 输出 `requestId`、`threadId`、`turnId` 和 `reply` |
| `--timeout-seconds <n>` | 本次等待上限，默认 0 表示不限 |
| `--poll-seconds <n>` | 读取间隔，默认 3 秒 |
| `--source-thread <id>` | 消息来源的 Codex 对话 ID，默认为目标对话自身 |
| `--config <file>` | 指定配置文件 |

成功退出码为 0，异常或被中断为 1。

### 长消息

消息包含引号、换行或篇幅较长时，用文件或 stdin。以下 stdin 示例适用于 Git Bash：

```bash
node ask-codex.cjs <threadId> --stdin <<'MESSAGE'
请检查这个问题。
这里可以包含 "引号"、换行和字面量 $HOME。
MESSAGE
```

### 查看进度、纠偏和停止

派发后，stderr 会给出 `ask-codex-...` 请求编号。

```bash
ask-codex --status <requestId>
ask-codex --steer <requestId> "先检查上传接口，暂停修改搜索代码。"
ask-codex --stop <threadId>
```

- `--steer` 不等目标空闲，直接发给该请求的活动轮次。调用返回表示消息已发送，实际调整看后续回复。
- `--stop` 走桌面应用停止按钮的同一条路径，并带上当前轮次 ID，不会误停随后启动的另一轮。确认状态变为 `interrupted` 后返回 `stopped:true`，空闲对话返回 `stopped:false`。已完成的文件修改保留。
- 停掉后台 Bash 或让本程序超时退出，只结束等待，Codex 继续工作。要停止 Codex，用 `--stop`。

### 等待和恢复

```bash
ask-codex --resume <requestId>
ask-codex --resume <requestId> --json
```

- 恢复只读取原任务，不重发。已完成的请求在 Codex 关闭时也能从本地缓存返回。
- 单次 MCP 调用最多等待 60 秒。连接中断会自动重连；目标不存在、协议参数错误等确定错误直接退出。
- 被停止的请求以非零退出码结束。要继续工作，用目标对话 ID 发一个新任务。
- 同一对话的调用通过进程锁串行执行。目标已有活动轮次时，新任务等它结束再派发；想在执行中补充要求，用 `--steer`。
- Codex 需要人工批准或补充输入时，在桌面应用里处理。

## 配置和本地数据

请求记录默认保存在 `~/.ask-codex/`，包含任务正文、中间回复、最终回复和锁文件，都是明文。上传日志前先检查内容。

`config.json` 的默认设置：

```json
{
  "pollSeconds": 3,
  "historySearchLimit": 1000
}
```

`historySearchLimit` 是按编号反查轮次时最多翻阅的轮数，对话历史更长时可以调大。

| 配置字段 | 环境变量或参数 | 作用 |
|---|---|---|
| `stateDir` | `ASK_CODEX_STATE_DIR` | 记录目录，默认 `~/.ask-codex`；相对路径相对于配置文件目录 |
| `codexHome` | `CODEX_HOME` | Codex 配置目录，默认 `~/.codex` |
| `serverPath` | `CODEX_APP_SERVER_PATH` | 本机 app-tools 的 `server.mjs` 路径 |
| `nodePath` | `CODEX_MCP_NODE_PATH` | 启动插件的 Node 路径 |
| `pipePath` | `CODEX_APP_TOOLS_PIPE_PATH` | 指定 Codex 管道 |
| `sourceThreadId` | `--source-thread <id>` | 消息来源的 Codex 对话 ID |

程序自动发现当前的 Windows 管道和已安装的插件。同时运行多个 Codex 实例时，用 `CODEX_APP_TOOLS_PIPE_PATH` 指定目标。

早期版本把记录放在聊天目录的 `work/ask-codex-state`，要读取旧请求，把 `ASK_CODEX_STATE_DIR` 指向原目录即可。

## 开发

```bash
npm test
npm run check
```

回归测试使用本地模拟 MCP，不依赖 Codex 或模型服务。覆盖并发恢复、永久错误退出、临时连接恢复、离线缓存、停止后重新发送、历史翻页、读取大小上限和 UTF-8 输出。

## 兼容范围

- 仅支持 Windows。WSL 里的 Linux Node 访问不了 Windows 命名管道，需要用 Windows Node 运行。
- 这是实验工具，依赖 Codex 桌面应用自带的 app-tools 插件和内部 IPC，它们不是公开接口，应用更新后可能需要适配。
- 已在 Codex app-tools `26.1111.21308`、Windows Node 和 Git Bash 环境验证消息回传、执行中补充和停止。停止功能使用内部 IPC 的 `thread-owner-discovery` 与 `thread-follower-interrupt-turn`，协议版本为 4。

本项目不包含 Codex 应用或插件的源码。

## 许可证

[MIT](LICENSE)
