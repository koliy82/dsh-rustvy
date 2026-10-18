> **Регистрация на Rustvy по реферальной ссылке автора:** <https://rustvy.xyz/r/Z6LJC8FH>
> Скидка 10% и бонусные токены при регистрации по этой ссылке.
> Подробные условия: <https://rustvy.xyz/dashboard/referral>

# Rustvy (`dsh-rustvy`)

[Русский](README.md) | English

Vendor marks in the DeepSeek Harness model picker, and a model list that stays as
current as the provider's own — one plugin, one mirror, no restarts.

## What it does

It has two jobs, and they share one mirror of the provider's public catalog.

**Marks.** One monochrome vendor mark before every model row in the picker, drawn
the way the provider's own dashboard draws it: a CSS mask filled by
`currentColor`, so a single file per vendor serves both palettes and every row
state — hover, selected, disabled — with no colour variants.

| Surface | What appears |
|---|---|
| Composer model menu | one 16 px monochrome mark before every model row |
| Composer model button | the selected model's mark before its name (14 px) |
| `/model` command popup | the same mark on every row |
| A skin that redraws the picker (`dsh-claude-style`) | the same mark, and the skin's own lockup is hidden in that row so two never meet |

**The model list.** A profile reaches a third-party provider through a
hand-declared `@deepseek-ai/dsh-llm-pi-ai` route, and that route's `models` list
decides what the GUI may select — the harness offers a model only when the route
serves it. A hand-written list goes stale the day the provider ships a model: the
new one is invisible, and a retired one stays selectable and fails at request
time. This plugin reads what the route's own endpoint serves, turns it into that
adapter's exact entry shape, shows the difference against what is installed, and
writes it back through `ctx.configEditor` when asked.

## Why you would want it

Because the two failure modes of a hand-maintained provider route are both
silent. A model the provider added does not appear, and nothing tells you why —
there is no error, just an absence. A model the provider retired still appears,
and selecting it produces a transport failure that reads like a network problem
rather than like a stale line in a YAML file.

Both are fixed by reading the provider instead of transcribing it. The list this
plugin writes carries the real context window, output cap, input modalities and
reasoning levels, so a model that gained image input or a new thinking level is
described correctly the same day, rather than inheriting a fallback somebody
guessed at.

And because the marks come from the same mirror, a brand-new model arrives with
its vendor's own mark already cached — the mirror re-reads the catalog the moment
the endpoint names a model it has never seen, which is exactly when a release
lands.

Nothing here is specific to one provider. The origin, the route and the profile
row are all settings; `https://rustvy.xyz` and `rustvy` are defaults.

## Install

From npm, once published:

```sh
dsh plugin --profile web add dsh-rustvy
```

From a checkout of this repository:

```powershell
pwsh -File .\install.ps1
```

`install.ps1` copies the package into `<profile>\node_modules\dsh-rustvy` as
a real directory and appends the name to `dsh.profile.bundles` in the profile
manifest. A running harness picks the row up from the manifest change.

Then restart the harness once, or refresh the page: the marks and the settings
page arrive live, and the loader row is read at composition.

### The route the model list is written into

The marks work with nothing else installed. The model-list half needs a
`@deepseek-ai/dsh-llm-pi-ai` route to write to — add this to the profile's
`cordis.patch.yml`, or edit it in **Settings → Plugins → Plugin configuration**:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      rustvy:
        displayName: rustvy
        apiKeyEnv: RUSTVY_API_KEY
        api: openai-completions
        baseURL: https://rustvy.xyz/v1
        models:
          - id: placeholder
            name: placeholder
```

The `models` list only has to parse: this plugin replaces it. Every other field
is carried through untouched by a regeneration, because a wire-compatibility
switch or a credential reference is knowledge about your deployment that no
catalog can supply.

`apiKeyEnv` names where the route's key comes from, resolved per request through
the harness credential seam — the inherited process environment, then
`$DSH_HOME/.credentials.yaml`, then a `.env` in the invocation directory or in
`$DSH_HOME`. The key never enters a configuration file. This plugin's own listing
read attaches a key only when the process environment already carries one under
that name; the endpoint it was written against answers without one.

To make a model the default:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: rustvy
    model: claude-opus-5-5
    reasoningEffort: high
```

### Using it

Open **Settings → Rustvy**. The page shows what the mirror holds, what the
provider serves, and the exact drift between them. **Обновить каталог и иконки**
refreshes both halves; **Записать список моделей** writes the generated list.
Nothing is written without one of those, unless you ask for it in the settings.

## Settings

**Settings → Rustvy**

Marks:

| Control | Default | Meaning |
|---|---|---|
| Показывать иконки моделей | on | master switch for the marks; off removes every mark and leaves the model list alone |
| Иконка в кнопке выбранной модели | on | also mark the composer's model button, not just the menu rows |
| Прятать логотипы других скинов | on | hide a skin's own lockup in a row this plugin marked |
| Размер значка, px | 16 | 10–32 |

Model list:

| Control | Default | Meaning |
|---|---|---|
| Держать список моделей маршрута актуальным | on | master switch; off leaves the route's YAML untouched |
| Записывать список | при нажатии «Обновить» | `только отдельной кнопкой` never writes on its own · `при нажатии «Обновить»` writes when the refresh button is pressed · `сам, при каждом обновлении` also writes on the daily background refresh |
| Название модели | как на сайте провайдера | the provider's display name, or the raw id |
| Предлагать уровень «без рассуждений» | on | add an `off` level to a reasoning model that does not declare one |
| Оставлять модели, которые провайдер больше не отдаёт | off | keep an installed model the endpoint no longer serves, for a listing that is momentarily wrong rather than genuinely retired |
| Маршрут провайдера | `rustvy` | which key under `providers` to write |
| Строка профиля | `llm-pi-ai` | which loader row holds it |
| Сайт провайдера | `https://rustvy.xyz` | where the catalog and the logos are read from |

The default write mode is deliberately the middle one: a button press is a
decision, a background expiry is not, and rewriting a live profile's loader
config while nobody asked is worth an opt-in.

Every address and file the plugin touches is on the page — the site, the catalog
page and the models endpoint as links that open in a new tab, and the mirror,
settings, backup and profile-patch paths as copyable text. **Показать блок для
ручной правки** renders the exact YAML the automatic write would produce, so
anyone who would rather paste it into `cordis.patch.yml` themselves is not
transcribing a summary.

One field has no control because it belongs in a profile's YAML rather than a
form: `modelZones` (default `["standard"]`), the catalog zones admitted when the
endpoint is unreachable and the mirror decides membership instead.

Stored in `<profile>\.dsh-rustvy\config.json`. Two environment variables
override it, for a deployment that points the mirror elsewhere or wants the
plugin mounted but inert: `DSH_RUSTVY_ORIGIN` and
`DSH_RUSTVY_DISABLED=1`.

## Where the pictures come from

Nothing is embedded in this package. The host half mirrors two public things from
the provider's site into the profile, and the browser half reads them from
loopback:

1. **the model catalog** — the site renders its model table from a JSON island in
   its own page (`<script id="rustvy-catalog">`), so an unauthenticated reader is
   handed exactly the data the dashboard shows. Mirrored to
   `<profile>\.dsh-rustvy\catalog.json`.
2. **the logo files** (`/logos/<name>.svg`) — copied into
   `<profile>\.dsh-rustvy\logos\` on first use.

Both are read on the process's own outbound route (`lib/net.js`): the live global
dispatcher first, so a proxy installed by `dsh-proxy-gui` — or any other route the
process has — is followed, and a connector built here from `HTTPS_PROXY` /
`ALL_PROXY` / `HTTP_PROXY` second, for the case where no dispatcher is installed.
`NO_PROXY` is honoured on both. The page itself never leaves the machine: the
browser asks `127.0.0.1` for a mark, which is what makes this work on a machine
whose browser cannot reach the origin at all.

The catalog refreshes once every 24 hours and on demand; a cold mirror is waited
for up to 6 seconds, and a stale one refreshes in the background while the rows
keep the marks they have. When the origin is unreachable, the cache on disk still
serves everything it holds.

## Where the model list comes from

Two sources, in this order, because they answer different questions:

1. **the route's own endpoint** (`GET {baseURL}/models`) — the authoritative
   *membership* list: exactly the models a request may name, each with its
   `context_k`, `max_output_tokens`, `modalities` and `reasoning_levels`. This is
   the same endpoint the adapter's own discovery interrogates.
2. **the mirrored catalog island** — the labels and the fallback. It is the only
   source that carries a display name, a vendor and a logo file name, so it is
   joined onto the served list by id. When the endpoint does not answer, the
   island's own `enabled` and `zone` fields decide membership instead, so a route
   stays current through an outage rather than freezing at its last successful
   read. On a healthy origin the two agree exactly.

A model the endpoint serves and the mirror has never seen is the signal that the
island is behind the wire — which is precisely when a release lands — so the
island is re-read then, bounded by the same short wait a cold mirror uses.

### What gets written

Each generated entry carries only fields the adapter's config schema declares,
because a route profile's `models` list *replaces* the route's catalog and an
unknown field would be dropped at best:

| Field | Taken from |
|---|---|
| `id` | the served model's id — what a request must name |
| `name` | the island's display name, or the id when there is none |
| `contextWindow` | `context_k` × 1000 |
| `maxTokens` | `max_output_tokens` |
| `input` | `modalities`, filtered to `text`/`image` |
| `reasoningEfforts` | `reasoning_levels` mapped onto the adapter's levels, or `false` for a non-reasoning model |
| `compat` | **never generated** — an existing one is always carried forward |

A field nobody speaks for is *omitted* rather than defaulted, so the adapter's own
fallback stays in charge and a hand-written value is not silently pinned.
`compat` is the one thing carried forward untouched: a wire-compatibility switch
is knowledge about the gateway that no catalog can supply.

Reasoning levels are mapped onto the adapter's vocabulary (`off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`); a level it does not know is dropped and
reported as a note rather than refusing the whole write. Undeclared levels are
pinned unsupported by the adapter, and a declared `off` with no wire value means
"offered, send nothing" — which is why that option is on by default.

### What is refused

An empty list is never written: the only way to get one is a failed read, and a
route with no models serves nothing. An up-to-date list is not written either,
because `configEditor.edit()` reconciles the whole loader and spending one on a
no-op would reload a live profile for nothing. Every write keeps the previous
document in `<profile>\.dsh-rustvy\models-backup.json`, and
**Откатить к предыдущему** puts it back — the state a revert displaces becomes the
next backup, so a revert is itself revertible.

## Matching a row to a mark

Rows are matched by their visible name, in this order:

1. the mirrored catalog's model id (`claude-opus-5-5`, `abyss/glm-5.3`, …);
2. its display name (`OPUS 5.5`);
3. an id the label *starts* with — a skin can leave its own description line in
   the same element, so the name is often a prefix rather than the whole string,
   and the longest matching id wins so `claude-opus-5-5` is never claimed by
   `claude-opus-5`;
4. the shape of the id, for a model the mirror has never seen: `claude-*` →
   Anthropic, `gpt-*`/`o1…o9` → OpenAI, `glm-*` → Zhipu, `kimi-*`/`k3` →
   Moonshot, `qwen-*` → Alibaba Qwen, `deepseek-*` → DeepSeek, `ahmia-*` → Ahmia,
   `mimo-*` → Xiaomi, `fable-*` → Anthropic, `gemini-*` → Google, `grok-*` → xAI.

A model that matches nothing gets no mark at all — an invented icon would be a
wrong answer rather than a missing one. A model that matches but whose logo the
mirror could not fetch gets a monogram chip (the vendor's first letters) instead
of a blank box: a mask whose URL 404s would otherwise paint a solid square.

Effort rows, provider headings, the menu's root cells, the search field and
catalog-failure rows are matched by nothing and stay bare.

## Routes

One prefix registration on the harness's own web server. Plugin routes are not
seen by the host's request fence, so every one of them checks the peer itself:
loopback only, a loopback `Host`, a same-origin `Sec-Fetch-Site` and a matching
`Origin`.

| Route | Method | Answer |
|---|---|---|
| `/dsh-rustvy/catalog.json` | GET | the mirrored catalog plus the settings the browser half draws with |
| `/dsh-rustvy/logo/<name>.svg` | GET, HEAD | one cached logo, fetched from the origin on first ask; `404` when the origin has no such mark, `400` for any name that is not `[A-Za-z0-9._-]+.svg` |
| `/dsh-rustvy/models.json` | GET | the generated model list and its drift against the installed one; `?cached=1` reports the last computed plan instead of reading the endpoint again |
| `/dsh-rustvy/models.yaml` | GET, HEAD | the same list as a paste-ready `cordis.patch.yml` row; `?cached=1` as above |
| `/dsh-rustvy/state` | GET | mirror status: version, model count, cached logos, route, proxy (credentials masked), every file path, last error, and the last computed drift. Never makes a request of its own |
| `/dsh-rustvy/refresh` | POST | re-read the catalog, re-warm every logo it names, and report — or, when the write mode allows it, apply — the model list |
| `/dsh-rustvy/apply-models` | POST | write the generated list into the route profile through `ctx.configEditor` |
| `/dsh-rustvy/revert-models` | POST | put the backed-up route profile back |
| `/dsh-rustvy/config` | POST | write settings; never touches the network |

## No restarts

The host half reloads itself, the same way `dsh-proxy-gui` does: the loader row
names this package, whose entry imports the implementation through a
cache-busting `?rev=` query, and a one-second poll of the `lib` directory disposes
the previous revision and starts the next one once a changed fingerprint repeats.
`lib/host.js`, `lib/models.js` and `lib/net.js` therefore reload live; only an
edit to the entry bootstrap itself needs a restart. The browser half arrives in an
open page through the harness's own live plugin composition; a page refresh works
too.

The plugins-menu title, description and icon are read from the package at
composition time, so a change to `locale/*.json` or `assets/icon.svg` needs a
restart to show.

## Requirements and degradation

Verified against dsh `0.2.0-rc.2`. The package declares no `engines.dsh` and no
peer dependency, because it imports no `@deepseek-ai/*` module at all — it has
zero runtime dependencies, and a host requirement it has not tested would only
produce false incompatibility warnings in the market.

Each capability degrades on its own:

| Missing | Effect |
|---|---|
| `configEditor` | the drift is still computed and shown; the write and revert buttons explain that the host offers no editor |
| a `dsh-llm-pi-ai` route | marks still work; the model-list half reports that no route was found |
| the origin | the on-disk cache serves every mark and every model it holds |
| the endpoint, catalog present | the island decides membership, and the page says so |

## Layout

| File | Role |
|---|---|
| `lib/index.js` | stable loader entry; owns the reload loop |
| `lib/host.js` | routes, catalog mirror, logo cache, model sync, settings |
| `lib/models.js` | pure mapping: what an origin publishes → one route-profile entry, the drift between two lists, and the YAML for a manual edit |
| `lib/net.js` | one outbound GET on the process's route, then the environment's proxy |
| `client/client.js` | hand-authored browser bundle: the decorator and the settings page |
| `locale/en.json`, `ru.json`, `zh.json` | the plugins-menu title and description |
| `assets/icon.svg` | the plugins-menu icon |
| `cordis.patch.yml` | the loader row the profile's bundle list pulls in |
| `install.ps1` | install into a profile |
| `scripts/prepublish-check.mjs` | the publish gate: everything that can install fine and still be wrong |
| `tests/` | the mapping, the YAML emitter, and the host and browser halves |

`lib/models.js` is deliberately pure — no network, no filesystem, no Cordis — so
the mapping can be checked against a real origin's answer without mounting
anything. `lib/host.js` owns everything with a lifetime, and is what a reload
replaces.

## Tests

```powershell
node tests\models-check.mjs              # pure mapping: live origin -> entries, drift, schema audit
node tests\yaml-roundtrip-test.mjs       # emitter vs two real YAML parsers, against a real route row
node tests\model-sync-host-test.mjs      # host: fake webServer + configEditor, real origin fetch
node tests\model-sync-client-test.mjs    # browser: mini-React + stubbed DOM, fixture /state
node scripts\prepublish-check.mjs        # the publish gate
```

The two parser-dependent tests borrow `js-yaml` and `yaml` from an installed dsh
profile rather than vendoring them — that is the parser `configEditor` writes with,
so the emitter is checked against what will actually read its output. Where no
profile is present they print a visible `skip` and fall back to a synthetic row of
the same shape, rather than reporting a pass they did not earn.

`models-check.mjs` reads the origin's endpoint and catalog island, generates the
list, and audits every entry against the adapter's schema: only declared fields,
positive-integer capacities, known modalities, and a reasoning dict that offers a
level beyond `off` while giving a wire value to every level except `off`. It also
asserts the island fallback selects exactly the models the endpoint serves, which
is what makes the fallback safe to write.

`yaml-roundtrip-test.mjs` parses the profile's real `cordis.patch.yml` row,
re-emits it through this package's emitter, and checks that two independent
parsers — `js-yaml` and `yaml` — both read it back identically, that every
connection field survives, that substituting the row leaves its neighbours
byte-identical, and that scalar quoting round-trips: reserved words, numerics,
leading indicators, trailing space and embedded quotes.

The host test drives the registered routes with fake request/response pairs and a
fake `configEditor` seeded with a route as a profile really has it, and asserts:
the plan reads the endpoint; a model the mirror has never seen still gets its real
display name rather than its id; a hand-written `compat` survives regeneration and
is never invented for another model; `/models.yaml` emits a patch row that keeps
the connection fields and drops the list it replaces; the write keeps
`displayName`, `apiKeyEnv`, `api` and `baseURL` and replaces only `models`; a
backup lands on disk; a second apply is a no-op that does not touch the config;
`/state` stops reporting the drift a write just resolved; a revert restores the
retired models and their `compat`; and `403` for a non-loopback peer, `405` for a
wrong method.

The client test renders the settings page with a mini-React whose hook cells are
keyed per component instance, and asserts: the section is named Rustvy; the three
outbound addresses are real links that open outside the app; every file path is
shown with a copy button; the route, the profile row, the origin and the mark size
are editable and save on blur; both dropdowns save on change; the manual-edit panel
fetches and shows the block; the drift names the new, retired and changed models;
the write button is enabled while drift exists, disabled once current, and disabled
when the host offers no editor; revert stays disabled until a backup exists; and
each mutation posts to the right route and reports what actually moved.

The mark-drawing half is **not** covered by an automated suite in this repository,
and that is worth knowing up front. It works on the DOM of an already-open page, so
it is checked by eye: which rows get a mark and which icon each gets, that effort
rows, provider headings and the search field stay bare, that a model whose logo
could not be fetched gets a monogram chip instead of a blank box, that a row added
later gets marked too, that a second pass duplicates nothing, and that an unload
removes what was added. `model-sync-client-test.mjs` covers the settings page, not
the decoration.

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for the step-by-step: repository, npm, a
GitHub Release tarball, and the one-file pull request that gets it listed in the
community catalog and therefore in the in-app plugin market.

## License

MIT — see [LICENSE](LICENSE).
