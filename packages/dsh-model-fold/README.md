# dsh-model-fold

Collapsible provider groups for the DeepSeek Harness composer model picker.

The stock picker lists every model of every provider in one long scroll. This
plugin folds each provider down to a single header row, so the menu opens as a
short list of provider names; clicking a provider name reveals that provider's
models, and clicking it again folds them away.

```
┌──────────────────────────────────┐
│  ⌕ 搜索模型…                      │
├──────────────────────────────────┤
│  推理等级   Default  Low  Medium  High │
├──────────────────────────────────┤
│  › DeepSeek 账号              2  │   ← folded
│  ⌄ command                    2  │   ← open (clicked)
│      GPT-6.1 Sol              ✓  │
│      GPT-6 Luna                  │
│  › shuai                      1  │   ← folded
└──────────────────────────────────┘
```

## Behaviour

- **Folded on open.** Every provider starts collapsed, so the menu shows only
  provider names and each provider's model count.
- **Click a provider name to unfold it.** Clicking the open provider folds it
  back. One provider is open at a time.
- **Search unfolds matches.** Typing a query overrides the folded state and
  shows every provider that still has a match, so results are never hidden
  behind a closed header. Clearing the query restores the folded layout.
- **Effort stays put.** Reasoning-effort chips belong to the *currently selected*
  model, not to a provider's list, so they sit above the provider list and stay
  visible while providers fold and unfold.
- **A single-provider catalog opens itself.** With only one provider there is
  nothing to fold, so it starts expanded.
- **Everything else is unchanged.** The trigger, the current-model label with its
  effort caption, the busy spinner, the locked state, the search threshold (more
  than four models), keyboard navigation, the load/error strips and the
  selection toast all behave as before, and switching a model here is what the
  `/model` command and every other surface shows next.

## How it works

The composer's model seat is the `conversation.input.model` slot, declared by
`@deepseek-ai/dsh-client-ui-conversation` and occupied by
`@deepseek-ai/dsh-client-ui-model-selection`. That slot is a `single` slot, and
the slot registry refuses a second registration at the same priority — so this
plugin registers at `priority: -1`, the lowest priority, which is the entry the
renderer elects. The shipped component is never patched, wrapped, or mutated;
disabling this plugin hands the seat straight back to it.

Both entries render the same per-session directory owned by
`ctx.modelDirectories`, so a model switch made here is immediately visible
everywhere else. The plugin reads the directory snapshot verbatim
(`current`, `groups`, `failures`, `status`, `pending`, `error`) and submits the
same `{ provider, model, reasoningEffort? }` selection payload.

The browser half is a hand-authored bundle with no build step: markup is
`React.createElement`, and the stylesheet is one injected `<style>` element built
from the harness's own design tokens. It honours the two
`--dsh-composer-model-*` display variables, so the seat still collapses to an
icon-only trigger when the composer tool row runs out of width.

## Install

The plugin is a DSH profile bundle. It needs a host half mounted in the profile
(which is what makes the browser half reachable), and the `dsh.client`
declaration in `package.json` is what gets it served to the page.

### From GitHub (one command)

```sh
dsh plugin --profile desktop add github:LimiChan-2026/dsh-plugins#path:/packages/dsh-model-fold
```

The package's `cordis.patch.yml` is its `dsh.bundle.patch` layer, so the CLI
appends `dsh-model-fold` to `dsh.profile.bundles` and the row mounts itself — no
hand-editing of `cordis.patch.yml`. Swap `desktop` for another profile name if
you are not using the desktop app.

Then **fully quit and reopen DeepSeek Harness**, and reload the page: the client
bundle is loaded into the browser when the host starts.

> `dsh` is not always on `PATH`. The Windows desktop app ships it at
> `<install dir>\resources\runtime\cli\bin\dsh.cmd`.

### Uninstall

```sh
dsh plugin --profile desktop remove dsh-model-fold
```

Then quit and reopen. The stock picker returns unchanged.

### Other install sources

```sh
dsh plugin --profile desktop add ./dsh-model-fold-1.0.0.tgz   # local tarball: copies files in
dsh plugin --profile desktop add ./dsh-model-fold             # local directory: link: to this folder
```

A **directory** installs as a `link:` dependency (a symlink back to the source
folder, so your edits are live but the folder must stay put), while a **tarball**
copies the files into the profile's `node_modules`. `pnpm pack` in this directory
produces a self-contained tarball (13 KB, no build step, no dependencies).

### Option — mount by absolute path (no install step)

Add a row to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: model-fold
      name: 'C:/path/to/dsh-model-fold/index.js'
```

The profile is watched, so an already-running Harness picks the row up live;
otherwise restart. Then reload the page.

**Never combine this with a package install** — the plugin would be mounted
twice and the second registration on the single model seat throws at boot. If
you are switching from this route to the GitHub one, delete the row first.

## Tests

`test/` mounts the real `client.js` in jsdom with real React 18 and drives it
with real DOM events. Only `@deepseek-ai/dsh-client-ui-primitives` is stubbed,
because its own dependency graph (shiki, katex, simple-icons) cannot load outside
the browser bundle; the stub keeps the same public shapes for the members this
plugin consumes.

Test dependencies live at the repository root, so the plugin itself stays
dependency-free:

```sh
pnpm install          # at the repository root
pnpm run test         # runs the suite
```

62 checks cover the registration contract (seat name, shadow priority, inject
face), the folded-on-open layout, expanding and collapsing by clicking a provider
name, search overriding the fold, model and effort selection payloads, keyboard
navigation, and the subagent/busy/locked/error/empty states.

## Layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host half. Empty `apply` — its only job is to be a mounted row so the browser half is served. |
| `client.js` | Browser half. The shadowing seat registration and the accordion picker. |
| `cordis.patch.yml` | `dsh.bundle.patch` layer, for the CLI install route. |
| `test/` | jsdom behaviour tests. |

## Notes and limits

- **Provider names come from the Host catalog.** `deepseek-account` is rendered
  with a localized label; every other provider shows the name the Host reports
  (`command`, `shuai`, …), falling back to the provider id.
- **The fold state is not persisted.** Every open starts folded. It is
  deliberately not remembered per session, because a stale fold would hide the
  model a user is looking for.
- **Provider failures still surface.** A provider whose catalog failed to load
  appears as a warning strip above the list, exactly as before — it is not
  foldable, because it has no models to fold.
- **`/model` is untouched.** The command popup keeps its own flat,
  provider-grouped list; only the composer seat is folded.
