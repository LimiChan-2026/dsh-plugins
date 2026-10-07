# dsh-task-notify

DSH 的「任务完成提醒」插件：回合结束时播放一声轻提示音、在窗口右下角弹出一张完成卡片，
可选同时发一条 Windows 系统通知。卡片点击即可回到对应会话。

属于 [dsh-plugins](https://github.com/LimiChan-2026/dsh-plugins) monorepo。

| | |
| --- | --- |
| 安装 | `dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-task-notify` |
| 提示音 | 两声上行「叮咚」，Web Audio 合成，不带音频文件 |
| 卡片 | 右下角，显示会话标题 / 用时 / 时间，点击跳回该会话，悬停暂停自动关闭 |
| 系统通知 | 浏览器 `Notification` → Windows 通知中心，权限被拒时静默降级 |
| 设置 | 设置 → 任务提醒（音效开关与音量、卡片停留时长、子代理是否也提醒、三个试听按钮） |

## 它怎么工作

```
api-session/status (host 事件: running ⇄ idle)
        │
        ▼
   host 半  index.js        事件环形缓冲 + 单调游标
        │  ├─ GET  /api/task-notify/stream   SSE 实时推送
        │  ├─ POST /api/task-notify/poll     断线/刷新后的补齐
        │  └─ POST /api/task-notify/ack      浏览器回执（黑匣子用）
        ▼
   client 半  client.js      音效 · 右下角卡片 · 系统通知 · 设置项
```

**为什么需要 host 半**：浏览器看不到其它会话的 Agent 运行状态，而轮询会话快照既漏掉后台会话，
又会撞上浏览器对后台标签的定时器降频——而「完成提醒」恰恰是为你不看窗口的那几分钟准备的。
Host 端 `api-session/status` 是权威来源，所以由 host 监听、通过 SSE 即时推给页面。

**为什么用 SSE 而不是轮询**：窗口最小化时 Chromium 会把 `setTimeout` 降频到分钟级，
轮询的通知会迟到；网络事件不受同样限制。轮询退化为「修复通道」：页面刚打开时补一次、
流断开时兜底。

## 触发与过滤

- 每个回合结束（Agent `running → idle`）提醒一次。
- **子代理默认不提醒**（可在设置里打开）：一次任务派生出多个子代理时，只有你自己发起的回合会响。
  host 依据 `SessionSummary.origin === 'subagent'`（或存在 `parentSessionId`）标记，客户端据此过滤。
- **启动时空转不误报**：Host 启动时枚举空闲会话产生的 `running: false` 不会变成通知。
- 重启 DSH 时正在跑的回合，结束时仍会提醒（但没有可信的时长，卡片不显示用时）。
- 页面刷新/断线后只补发 20 秒内的完成事件，不会把一小时前的任务重新弹一遍。

## 设置

设置 →「任务提醒」：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 提示音 | 开 | 两声上行「叮咚」，Web Audio 合成，不带音频文件 |
| 音量 | 55% | 拖动即生效，松手试听 |
| 右下角卡片通知 | 开 | 停留 4/8/15 秒或不自动关闭；悬停暂停计时 |
| 子代理完成也提醒 | 关 | 打开后子代理回合也响 |
| Windows 系统通知 | 开 | 需要系统通知权限；被拒绝时不影响应用内提醒 |

设置存在浏览器 `localStorage`（`dsh-task-notify:settings:v1`），所以调整音量无需重启、无需 host 往返。
面板里还有「试听 / 试一张卡片 / 试一条系统通知」三个按钮。

若提示音第一次没声音：Chromium 要求先有用户手势才能启动音频。本插件在页面上第一次点击或按键时
就创建并解锁 AudioContext，并且**在调度音符之前等待 `resume()` 完成**——这是实测踩出来的一个坑：
对处于 `suspended` 的上下文调度音符会被静默丢弃，症状是「上下文状态正常、音频图正确、就是没声音」。

排查这类问题不必靠耳朵：点「试听 · 提示音」时，插件会把两条诊断写进黑匣子——
`test:chime:start` 证明点击处理真的执行了，`test:chime:end` 带 `peak=`，即声音离开音频图时的实际
波形峰值。`peak` 正常却听不到 ⇒ 问题在系统或应用的音量；`peak=0` ⇒ 问题在这段合成代码里。

## 黑匣子（排查用）

host 半把观测到的一切写到：

```
~/.dsh/dsh-task-notify-state/status.json
```

内容包含：当前游标、每个会话的 `title / cwd / subagent / error / startedAt`、最近 50 条完成事件、
SSE 连接次数与活跃数（`streamConnects` / `streamActive`），以及浏览器最后一次回执
（`lastAck`：收到多少条、当时音效与系统通知是否开启、通知权限状态）。
「到底响了没有、页面收到没有」都可以在这个文件里得到答案，不需要盯着窗口角落录屏。

## 安装

这是一个 DSH profile bundle，自带 `dsh.bundle.patch`，所以一条命令就能装上并挂载（不需要手工改
`cordis.patch.yml`）：

```sh
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-task-notify
```

把 `desktop` 换成你实际用的 profile 名（`web` …）。装完**完全退出并重新打开 DeepSeek Harness**，
再刷新页面——client bundle 是在 host 启动时加载进浏览器的，所以新装的插件要到那时才会出现。

> `dsh` 不一定在 `PATH` 上。Windows 桌面版自带：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`。

卸载：

```sh
dsh plugin --profile desktop remove dsh-task-notify
```

然后退出并重开。

## 改动生效方式

| 改动文件 | 生效方式 |
| --- | --- |
| `client.js` | 刷新页面即可（client bundle 由 webserver 每次请求从磁盘读取） |
| `index.js` | 需要重启 DSH：Node 按模块 URL 缓存，插件管理器热应用也不会重新导入 |

自测（不需要运行中的 DSH，也不会碰到真实状态文件——测试用临时 `DSH_HOME`）：

```sh
node packages/dsh-task-notify/test/run-tests.mjs
# 或者在仓库根目录：pnpm test
```

测试台用桩上下文驱动 host 半，覆盖：标题与工作区读取、子代理标记、启动时空转不误报、
继承回合不虚报时长、错误标记、poll 游标语义、方法不匹配拒绝。

## 设计取舍

- **不带 `dependencies`、`scripts`、`peerDependencies`**：与仓库约定一致。`require('react')` 由 DSH
  的 web 模块加载器提供，而不是靠 node_modules 解析；没有构建脚本，pnpm 的构建门禁就不会拦下安装。
- **host 监听 `api-session/*` 而不是让页面轮询**：浏览器看不到后台会话的运行状态，而且后台标签的
  定时器会被降频——完成提醒恰恰是为「你没在看窗口」的那几分钟准备的。
- **提醒内容与呈现分离**：host 只发 `{seq, sessionId, title, workspace, subagent, error, endedAt,
  durationText}` 这样的事实，音色、卡片样式、过滤策略全在 client 半，改口味不需要重启。

## 已知边界

- 只监听 `api-session/*`（侧栏可见的会话）。子代理会话也会出现在这个流里，因此需要上面的过滤。
- 卡片点击依赖可选服务 `uiWorkspace`；没有该服务的 profile 里卡片照常显示，只是点击不跳转。
- 系统通知走浏览器 `Notification` API（Electron 会转成 Windows 通知），权限被拒时静默降级。
