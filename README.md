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
Context capacity sampled before turn 3, step 1 (measured on the most recent request): 48,120 of 131,072 tokens used (37%), 82,952 remaining.
```

The message source is a `snapshot` (`{ kind: 'context-capacity', form: 'snapshot', sections: [...] }`). The transcript captions it as superseding earlier snapshots, but DSH does not drop the older messages from the request, so every reading stays in history and keeps costing tokens — see [Cadence](#cadence).

The numbers come from the `tokenMeter` service:

| Figure | Source |
| --- | --- |
| used | `ctx.tokenMeter.contextPressure(session).pressureTokens` — the prompt size the provider reported for the most recent request |
| window | `ctx.tokenMeter.contextPressure(session).contextWindow` (last recorded `request/context`) → `ctx.llm.resolveModelInfo(provider, model).context.contextWindow` → `windowTokens` config |
| remaining | `window - used`, floored at 0 |

The first step of a session has no recorded request, so `used` is unknown rather than zero: the reading then reports only the window and says no request has been recorded yet. The window itself comes from the model catalog through `llm.resolveModelInfo`, cached per `provider/model` for the life of the activation. When no source reports a window, the reading says so instead of inventing one.

`used` counts the prompt the provider received, not the tokens the model will write back, so the next request is normally a little larger than the reading.

## Why the reading is the provider's prompt size

The meter can price a request two ways, and they disagree as soon as anything rewrites requests between the session and the provider — a compression layer, for instance. Its own repricing walks the whole session surface, which then holds history the request never carries. The meter also refuses a provider sample smaller than that surface price, so the fallback engages on every request and its price grows with the transcript: a 1395-turn session repriced to 9.1M tokens against a 1M window, or 910% of it.

`pressureTokens` is the opposite: the prompt size the provider itself reported for the request it just served. It cannot overstate, it is what the window is actually measured against, and it is the only figure that survives a rewriting pipeline. This bundle reports that figure and nothing else — no surface estimate is computed, printed, or compared against.

A reading above 100% therefore means the provider really did receive a prompt larger than the window this route reports: either the route allows overshoot, or the window came from an earlier route. The reading says so when it happens.

## Cadence

Every reading stays in the transcript, so repeated readings cost tokens in every later request. The plugin therefore reads once per turn, on its first step, and re-reads mid-turn only after the used share grew by `refreshPercent` points since the last reading. Because the figure is a completed request's prompt size, a mid-turn reading lags the step that triggers it by one request — that is the point: every number the model sees was actually billed.

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
