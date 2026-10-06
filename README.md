# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

## Plugins

| Plugin | Description |
| --- | --- |
| [`dsh-model-fold`](packages/dsh-model-fold) | Collapsible provider groups in the composer model picker — every provider folds to one header row and expands when its name is clicked. |

## Install

Each plugin is a DSH profile bundle that declares its own `dsh.bundle.patch`, so
one command installs and mounts it — no hand-editing of `cordis.patch.yml`.

```sh
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-model-fold
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
