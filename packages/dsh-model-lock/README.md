# dsh-model-lock

模型锁池：把不想用的模型从选择器里锁掉，可以只锁一段时间，到期自动解锁。

```
┌─ 插件 → dsh-model-lock ─────────────────────────────┐
│  锁掉的模型会从模型选择器和 /model 弹窗里消失；      │
│  已经在用该模型的会话不受影响。                      │
│                                                      │
│  WorkBuddy AI                                        │
│    Deepseek-V4.1-Flash   [锁到手动解锁 ▾]  [ 锁定 ]  │
│    GPT-6-Astra           剩余 1h 59m        [ 解锁 ]  │
│  command                                             │
│    GPT-6.1 Sol           [2 小时 ▾]         [ 锁定 ]  │
└──────────────────────────────────────────────────────┘
```

## 行为

- **锁掉的模型从两个入口同时消失**：输入框旁的模型选择器，以及 `/model` 弹窗。
- **可以设时长**：手动解锁 / 30 分钟 / 2 小时 / 8 小时 / 24 小时 / 7 天 / 30 天。到期自动解锁，不需要重新加载页面。
- **软锁**：锁定只是把模型从选择器里藏起来。已经在用该模型的会话**继续正常工作**，正在跑的回合不会被打断。
- **按供应商 + 模型**：锁的是 `供应商/模型` 这一对，所以国内版（`workbuddy`）和国际版（`workbuddy-ai`）各自独立，同名的模型互不影响。
- **整组锁完就整组消失**：把某个供应商的模型全部锁掉，那个分组在选择器里也不再出现。
- **锁池是配置档级别的**：存在 `$DSH_HOME/.dsh-model-lock.json`，桌面 App 和指向同一配置档的远程 Web UI 共用同一份；在其中一个窗口改，另一个窗口重新获得焦点时同步。

## 安装

插件是一个 DSH 配置档 bundle，需要宿主半（`index.js`）挂进配置档，浏览器半（`client.js`）才会被送到页面。

### 方式 A —— 按绝对路径挂载（无需安装步骤）

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: model-lock
      name: 'C:/path/to/dsh-model-lock/index.js'
```

配置档是被监视的，已经在运行的 Harness 会实时拾取这一行；否则重启。然后刷新页面。

### 方式 B —— 作为包安装

```sh
dsh plugin --profile desktop add ./dsh-model-lock                 # link：跟随这个目录
dsh plugin --profile desktop add ./dsh-model-lock-1.0.0.tgz       # 把文件复制进去
```

包的 `cordis.patch.yml` 就是它的 `dsh.bundle.patch` 层，所以 CLI 会把 `dsh-model-lock` 追加到 `dsh.profile.bundles`，这一行会自己挂上。

> **注意**：`desktop` 配置档由桌面 App 独占管理，CLI 的 `add` 会被拒绝（报 `profile "desktop" is managed exclusively by the Electron application`）。桌面版请在 App 内置的插件管理界面安装，或改走方式 A。

**不要同时使用方式 A 和方式 B** —— 插件会被挂载两次。

### 卸载

删掉那一行（方式 A），或 `dsh plugin --profile <profile> remove dsh-model-lock`（方式 B），然后刷新页面。模型选择器恢复原样。

## 实现

### 为什么是「拦截数据」而不是「顶掉座位」

输入框旁的模型座位（`conversation.input.model`）是一个 `single` 槽位，而 `dsh-model-fold` 已经以 `priority: -1` 占着它——同一优先级再注册会抛错。更重要的是，顶掉座位只能改输入框旁那一个入口，**管不到 `/model` 弹窗**。

两个入口其实读的是同一个对象：`@deepseek-ai/dsh-client-ui-model-selection` 注册了 `modelDirectories` 服务，`/model` 弹窗通过 `models.directoryFor(sessionId)` 拿选项，输入框座位拿到的也是同一个实例。所以包装这**一个**方法就同时覆盖了两个入口。

```js
const resolver = scope.modelDirectories
const original = resolver.directoryFor
resolver.directoryFor = (sessionId) => filter(original.call(resolver, sessionId))
```

### 软锁是怎么保证的

- `select()` 原样转发，锁定的模型仍然可以被程序化选中。
- `routable` **原样透传**，不按过滤后的分组重算。它回答的是「这个会话当前选的模型还能不能路由」，过滤后重算会让「正在用被锁模型」的会话报告自己不可路由——那正是软锁不能造成的打断。
- 已到期的条目在读取时就不生效，`untilMs` 一过即放行。

### 已知边界

- **这是对外来状态的修改**：`directoryFor` 属于另一个插件，Cordis 不会替我们撤销。插件在自己的 `ctx.effect` 清理函数里还原原方法，并且把补丁放在 `ctx.inject(['modelDirectories'], …)` 里，服务重载时会重新应用。
- **只影响模型选择器，不是权限控制**：锁定不阻止请求执行。要真正拦住调用，得在宿主侧做，那是另一件事。
- **锁池不跟随账号**：键是 `供应商/模型`。如果你希望同一个模型在不同账号下有不同的锁，目前需要手动切换。

## 测试

```sh
cd packages/dsh-model-lock/test
node run-tests.mjs ../client.js      # 54 项：浏览器半
node host-tests.mjs ../index.js      # 38 项：宿主半（真实 HTTP + 真实文件）
```

浏览器半用 jsdom + 真实 React 加载真实 bundle，覆盖拦截契约、软锁语义、快照标识稳定性、到期自动解锁、以及**定时器 32 位溢出**（超过 `2^31-1` 毫秒的延迟会被运行时压成 1ms，30 天的锁会瞬间解开）。宿主半跑真实 HTTP 服务器与真实文件，覆盖原子写入、写入时的过期清理、loopback 防护、以及外部写入者的可见性。

两处修复都用变异测试验证过：去掉修复，对应断言确实会失败。

## 目录

| 路径 | 用途 |
| --- | --- |
| `index.js` | 宿主半。锁表、两条 loopback 路由、模型目录。 |
| `client.js` | 浏览器半。`directoryFor` 拦截、锁池卡片、倒计时与到期定时器。 |
| `cordis.patch.yml` | `dsh.bundle.patch` 层，供 CLI 安装路线使用。 |
| `test/` | 两套测试。 |

## 许可证

MIT