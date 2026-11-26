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
| used | `ctx.tokenMeter.measure(session).totalTokens` — the next request's estimated occupancy — or, when that estimate could not be anchored on a provider sample, `ctx.tokenMeter.contextPressure(session).pressureTokens`: the prompt size the provider actually reported |
| window | `ctx.tokenMeter.contextPressure(session).contextWindow` (last recorded `request/context`) → `ctx.llm.resolveModelInfo(provider, model).context.contextWindow` → `windowTokens` config |
| remaining | `window - used`, floored at 0 |

The first step of a session has no recorded request, so `used` is unknown rather than zero: the reading then reports only the window and says no request has been recorded yet. The window itself comes from the model catalog through `llm.resolveModelInfo`, cached per `provider/model` for the life of the activation. When no source reports a window, the reading says so instead of inventing one.

`used` is an estimate: it counts committed messages plus the current prompt surface, not the tokens the model will write back.

## Why a reading can exceed 100%

The meter has two ways to price a request. With a usage anchor it reports the sample plus the surface moved since that sample, and the reading says `estimated for the pending request`. Without a usable anchor it reprices the whole session surface from scratch — every message the session ever committed.

That second path is wrong whenever something between the session and the provider rewrites requests, because the surface then holds history the request never carries. The meter refuses a sample smaller than its own surface price, which is exactly what a compression layer produces, so the fallback engages and the estimate grows with the transcript: a 1395-turn session reads around 9.1M tokens against a 1M window, or 910%.

`pressureTokens` is the sample the provider reported for the most recent request, measured before any rewriting is invisible to it, so this plugin prefers it whenever the meter fell back. The reading then says `measured on the most recent request` and, once per session, names the surface estimate it discarded:

```
Context capacity sampled before turn 1395, step 1 (measured on the most recent request): 237,064 of 1,000,000 tokens used (24%), 762,936 remaining.
(discarded a 9,100,061-token surface reprice; the measurement wins.)
```

A reading above 100% after that fallback means the provider really did receive a prompt larger than the window this route reports — either the route allows overshoot, or the window was recorded by an earlier route — and the reading says which.

## Cadence

Every reading stays in the transcript, so repeated readings cost tokens in every later request. The plugin therefore reads once per turn, on its first step, and re-reads mid-turn only after the used share grew by `refreshPercent` points since the last reading.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `locale` | `en` | `en` or `zh` for the reading text and its section label |
| `refreshPercent` | `10` | Mid-turn re-read threshold in percentage points; `0` reads on every step |
| `warnPercent` | `80` | Above this share the reading adds a one-line warning about the limit |
| `surfaceNote` | `once` | When the reading discarded a surface reprice: `once` explains it on the first reading of a session, `always` on every reading, `never` not at all |
| `windowTokens` | unset | Fixed window size, overriding whatever the route reports |

The bundle's own `cordis.patch.yml` inserts the plugin with `locale: zh`; override any key in the profile's `cordis.patch.yml` by `id: dsh-context-capacity`.

## Why there are no imports

A bundle linked from a local directory is loaded by its real path, so its specifiers resolve from that directory's `node_modules` chain, where the harness packages are absent. The injected message and the config schema are therefore written by hand: a plain user message with a `randomUUID()` id, and a zero-dependency standard-schema object for `Config`. Only `node:crypto` is imported.
