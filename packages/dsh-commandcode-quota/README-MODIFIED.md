# dsh-commandcode-quota · 最小化 UI 补丁说明

这是插件 `dsh-commandcode-quota`（v0.1.0，上游 `github:Jovan1666/commandcode-usage#path:/plugins/dsh`）
的**改进版**。上游原版未被改动，本仓库仅发布这一个文件的改动。

- **上游仓库**：<https://github.com/Jovan1666/commandcode-usage>
- **本改进版**：<https://github.com/LimiChan-2026/dsh-plugins/tree/main/packages/dsh-commandcode-quota>
- **改动范围**：仅 `client.js` 一个文件（已逐字节校验其余文件与上游一致）
- **许可证**：MIT（沿用上游）

## 本次 UI 改动（只改了 client.js，共 5 处）

1. **默认最小化**：宽侧栏下，卡片启动后只显示一个 28px 高的紧凑芯片
   （`.ccq-pill`）：沙漏图标 + 最紧张窗口的整百分比（沿用红/黄/绿分级色）。
   **宽度按内容自适应**（`flex:none` + `inline-flex`，不再 `width:100%`），
   所以它只占「图标 + 数字」的宽度，右侧不再留一条空条。套餐名与各窗口精确
   读数移到悬停 tooltip 里（tooltip 第一行就是套餐名）。
2. **点击展开**：点击图标条展开为原来的完整面板（窗口行、进度条、重置倒计时、
   明细、账单链接），行为与原版一致。
3. **再收回去**：面板头部新增一个「–」按钮（`Command Code` · 套餐签 · [–] [▾]），
   点击收起为图标；按 Esc 也可以收起；`▾` 的明细展开/收起行为保持原样。
4. **错误可见性**：读取失败且没有可用报告时，图标条显示红色「!」和红色沙漏，
   tooltip 带错误摘要，点击展开后能看到原有的错误卡片。
5. 其余不变：折叠侧栏（rail）的 36px 圆形徽章、设置面板里的「模型调用次数」
   章节、数据轮询节奏、`/quota` 命令、host 端（index.js / quota.mjs）完全未动。

## 生效方式

`client.js` 由 DSH webserver **每次请求直接从磁盘读取**（插件 README「troubleshooting」
一节有说明），所以：

- 刷新浏览器页面（必要时 Ctrl+F5 强制刷新）即可看到新 UI；
- host 端代码没有改动，**理论上无需重启 DeepSeek Harness**；
- 若刷新后仍无变化（缓存极少数情况下会缓存），完全退出并重启应用即可。

## 预览截图

- `preview\shot-minimized.png` — 默认最小化态（浅色宽侧栏 / 折叠 rail / 深色宽侧栏）
- `preview\shot-expanded.png` — 点击图标条后的完整面板（含新「–」收起按钮）
- `preview\shot-error.png` — 读取失败时的图标条（红色「!」）

重新渲染截图：

```powershell
$env:DSH_THEME_BUNDLE = "$PWD\tools\asar-out\dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js"
D:\"...(node 路径)"/node.exe preview\build.mjs
# 然后用 Edge headless --screenshot 打开 preview\index.html（或 index-open.html / index-error.html）
```

## 安装

```sh
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-commandcode-quota
```

装完**完全退出并重开** DeepSeek Harness，然后刷新页面。

## 回滚到上游原版

```sh
dsh plugin --profile desktop add github:Jovan1666/commandcode-usage#path:/plugins/dsh
```

## 注意

- 本包是**上游的修改版**：`client.js` 与上游不同，其余文件逐字节一致（已校验）。
  升级上游时请重新比对本文件，避免改动被覆盖。
- 如果你用插件管理器重装本插件，`client.js` 会以本仓库的版本为准 —— 改动不会丢，
  这正是把它放进自己仓库的原因。
- 本目录**不含** `tools\`、`.devdeps\` 与 `preview\` 的生成产物（那些是本地开发用的，
  体积大且非运行时必需）。上游 `preview\build.mjs` 在本地开发时曾放宽 mock 侧栏的
  `.footerActions>*{width:100%}` 规则以便预览自适应宽度的芯片；该改动**只影响预览**，
  与部署无关，因此未收录。
- 截图见 [`docs/`](docs)：默认最小化态、展开态、读取失败态。
