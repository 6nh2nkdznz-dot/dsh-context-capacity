# dsh-context-capacity

Tells the model how much of its context window is already in use, before each model request.

A DeepSeek Harness host bundle: no UI, no dependencies, one injected reading per turn.

## Install

```sh
git clone https://github.com/6nh2nkdznz-dot/dsh-context-capacity.git
```

Then install that directory as a profile bundle: `plugin_manager`, action `install_bundle`, `target` set to the absolute clone path. The bundle activates through HMR and survives restarts. After editing `index.js` in the clone, toggle the plugin once (disable, then enable) so the running process loads the new module generation; replacing the package without a toggle needs a DSH restart.

## What the model sees

Before an admitted step, the plugin appends one user message to that step's messages:

```
Context capacity sampled before turn 3, step 1 (estimated for the pending request): 48,120 of 131,072 tokens used (37%), 82,952 remaining.
```

The message source is a `snapshot` (`{ kind: 'context-capacity', form: 'snapshot', sections: [...] }`). The transcript captions it as superseding earlier snapshots, but DSH does not drop the older messages from the request, so every reading stays in history and keeps costing tokens — see [Cadence](#cadence).

The numbers come from the `tokenMeter` service:

| Figure | Source |
| --- | --- |
| used | `ctx.tokenMeter.measure(session).totalTokens` — the next request's estimated occupancy |
| window | `ctx.tokenMeter.contextPressure(session).contextWindow` (last recorded `request/context`) → `ctx.llm.resolveModelInfo(provider, model).context.contextWindow` → `windowTokens` config |
| remaining | `window - used`, floored at 0 |

The first step of a session has no recorded request, so `used` is unknown rather than zero: the reading then reports only the window and says no request has been recorded yet. The window itself comes from the model catalog through `llm.resolveModelInfo`, cached per `provider/model` for the life of the activation. When no source reports a window, the reading says so instead of inventing one.

`used` is an estimate: it counts committed messages plus the current prompt surface, not the tokens the model will write back.

## Cadence

Every reading stays in the transcript, so repeated readings cost tokens in every later request. The plugin therefore reads once per turn, on its first step, and re-reads mid-turn only after the used share grew by `refreshPercent` points since the last reading.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `locale` | `en` | `en` or `zh` for the reading text and its section label |
| `refreshPercent` | `10` | Mid-turn re-read threshold in percentage points; `0` reads on every step |
| `warnPercent` | `80` | Above this share the reading adds a one-line warning about the limit |
| `windowTokens` | unset | Fixed window size, overriding whatever the route reports |

The bundle's own `cordis.patch.yml` inserts the plugin with `locale: zh`; override any key in the profile's `cordis.patch.yml` by `id: dsh-context-capacity`.

## Why there are no imports

A bundle linked from a local directory is loaded by its real path, so its specifiers resolve from that directory's `node_modules` chain, where the harness packages are absent. The injected message and the config schema are therefore written by hand: a plain user message with a `randomUUID()` id, and a zero-dependency standard-schema object for `Config`. Only `node:crypto` is imported.
