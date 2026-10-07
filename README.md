# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

## Plugins

| Plugin | Description |
| --- | --- |
| [`dsh-model-fold`](packages/dsh-model-fold) | 把模型选择器按供应商折叠起来 —— 每个供应商只占一行，点名称才展开它的模型。 |
| [`dsh-commandcode-quota`](packages/dsh-commandcode-quota) | Command Code 套餐额度面板（[上游](https://github.com/Jovan1666/commandcode-usage)的**最小化 UI 改进版**）—— 默认折叠成小芯片，点击展开。 |
| [`dsh-task-notify`](packages/dsh-task-notify) | 回合完成提醒 —— 一声轻提示音 + 右下角完成卡片（点击回到该会话）+ 可选 Windows 系统通知。 |

## Install

Each plugin is a DSH profile bundle that declares its own `dsh.bundle.patch`, so
one command installs and mounts it — no hand-editing of `cordis.patch.yml`.

```sh
# 模型选择器折叠
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-model-fold

# Command Code 额度面板（最小化 UI 版）
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-commandcode-quota

# 回合完成提醒（提示音 + 右下角卡片 + 系统通知）
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-task-notify
```

Swap `desktop` for another profile name (`web`, …) if you are not using the
desktop app.

Then **fully quit and reopen DeepSeek Harness**, and reload the page. The client
bundle is loaded into the browser when the host starts, so a newly installed
plugin does not appear until then.

> `dsh` is not always on `PATH`. The Windows desktop app ships it at
> `<install dir>\resources\runtime\cli\bin\dsh.cmd`.

### Uninstall

```sh
dsh plugin --profile desktop remove dsh-model-fold
```

Then quit and reopen.

## Layout

```
packages/
  dsh-model-fold/          one plugin per directory
    index.js               host half
    client.js              browser half
    cordis.patch.yml       dsh.bundle.patch layer
    package.json           declares dsh.bundle + dsh.client
    test/                  jsdom behaviour tests
```

## Notes on the git install form

`github:<owner>/<repo>#path:/<subdir>` is what makes a monorepo work: pnpm clones
the repository and installs the package from that subdirectory. The `path:` must
point at the directory holding the plugin's `package.json`.

These plugins deliberately carry **no `scripts`, no `dependencies`, and no
`peerDependencies`**. That keeps the git install frictionless:

- No `prepare`/`build` script, so pnpm's build-script gate never blocks the
  install (a git-hosted plugin that builds on install needs its key added under
  `allowBuilds` in the profile's `pnpm-workspace.yaml` first).
- No DSH peer range, so no version-compatibility exemption is required.

## License

MIT
