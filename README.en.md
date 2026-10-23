> **Регистрация на Rustvy по реферальной ссылке автора:** <https://rustvy.xyz/r/Z6LJC8FH>
> Скидка 10% и бонусные токены при регистрации по этой ссылке.
> Подробные условия: <https://rustvy.xyz/dashboard/referral>

# Rustvy (`dsh-rustvy`)

[Русский](README.md) | English

[![npm](https://img.shields.io/npm/v/dsh-rustvy)](https://www.npmjs.com/package/dsh-rustvy)
[![downloads](https://img.shields.io/npm/dm/dsh-rustvy)](https://www.npmjs.com/package/dsh-rustvy)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blueviolet)](https://github.com/topics/dsh-plugin)

Vendor marks in the DeepSeek Harness model picker, a model list that stays as
current as the provider's own, and several provider keys in one profile — each
chat sending its requests with the one its user picked. One plugin, one mirror, no
restarts.

## What it does

It has three jobs. The first two share one mirror of the provider's public catalog;
the third needs no mirror at all, only the profile's route.

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

**Keys.** Several provider keys in one profile, and a key of its own for any one
chat — chosen in the composer's tool row, right after the access-mode dropdown. A
key is added inside the plugin, with a **«+»** button: no `.env`, no
`cordis.patch.yml` and no trip to the Models page, and the choice survives a
restart. The built-in DeepSeek account is untouched: the substitution only ever
applies to this plugin's own routes.

| Surface | What appears |
|---|---|
| **Settings → Rustvy** | an «API-ключи» section: the key list, a **«+»** button, and per key — replace the value, rename, test, make default, delete |
| The composer, right after the access-mode dropdown | a compact switch for this chat's key, with a menu and a **«+ Добавить ключ»** row |

There is no key section in the model menu or in the `/model` popup: the choice lives
in one place. What the model menu gets instead is the removal of the provider groups
that turn out to be this ring's route clones — otherwise the same model list would be
repeated once per key.

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

The third job answers a different kind of quiet. A provider key is its own limit
and its own billing, and a profile is one, so "a key per chat" without the plugin
means either a second profile or a second row in YAML that somebody has to maintain
by hand. A hand-maintained clone of a route goes stale on exactly the same schedule
as a hand-written model list — the day of a release. The ring writes its clones
itself, in the same pass that writes the model list, so a key's route cannot lag
behind the profile's route and a chat sending with another key sees the same choice
of models as its neighbour.

Nothing here is specific to one provider. The origin, the route and the profile
row are all settings; `https://rustvy.xyz` and `rustvy` are defaults.

## Install

```sh
dsh plugin --profile web add dsh-rustvy
```

Or straight from GitHub, if you want the latest revision rather than the published
version:

```sh
dsh plugin --profile web add github:koliy82/dsh-rustvy
```

A bare `koliy82/dsh-rustvy` without a scheme is not accepted: the install-spec
parser knows a registry name, a git spec, a tarball and an absolute local path, and
a git spec needs either a scheme or the `github:` shorthand.

Neither route asks for build approval, because the package has no install script and
no dependencies — there is nothing for pnpm to build.

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

The **«API-ключи»** section on the same page holds the ring: the **«+»** button
opens an inline "label + value" form, and each key's row offers a value
replacement, a rename, making it the default, a test and a delete. None of that is
required, though — the switch in the composer's tool row does the same thing for
whichever chat is open, without leaving the conversation.

## Settings

**Settings → Rustvy**

Top to bottom the page runs: the switches and fields, then the **«Аптайм моделей»** box,
**«Модели провайдера»**, **«Ключи на несколько чатов»**, **«Сбор ошибок Rustvy»** and, at
the very bottom, **«Зеркало каталога»** with its addresses and files. Uptime comes first
because it is the only block that answers the question the page is opened with — is the
model about to be picked alive — and the mirror comes last, next to the warning about a
failed catalog read that only it is the subject of.

Marks:

| Control | Default | Meaning |
|---|---|---|
| Показывать иконки моделей | on | master switch for the marks; off removes every mark and leaves the model list alone |
| Иконка в кнопке выбранной модели | on | also mark the composer's model button, not just the menu rows; it also takes the uptime badge off that button |
| Прятать логотипы других скинов | on | hide a skin's own lockup in a row this plugin marked |
| Показывать аптайм моделей | on | the «Аптайм моделей» box on this page and the state badge in the model picker and on the selected-model button; off reads the collector's mirror at all |
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

Keys:

| Control | Default | Meaning |
|---|---|---|
| Ключи на несколько чатов | on | master switch for the ring; off applies no substitution at all, and every request goes out on the profile's route |

Turning it off deletes nothing: the key routes stay in the profile's
configuration, the values stay in the credential store and the chats' picks stay in
their own file, so turning it back on resumes exactly where it left off. The switch
lives in the «API-ключи» section rather than beside the mark and model-list
switches, because it belongs to the ring — and that section is also where the page
says why adding a key is unavailable, when the host offers no service to add one
with.

Error collection:

| Control | Default | Meaning |
|---|---|---|
| Собирать ошибки rustvy | on | master switch for the collector: one line per infrastructure fault of the provider goes to the uptime collector. Off sends nothing, and the queue already on disk stays on disk |

The switch has a block of its own, «Сбор ошибок Rustvy», because it is the only setting
on the page that sends anything off the machine — one line per failure of the provider
goes to the monitor's collector. The block itself is a caption and a switch and nothing
more: no explanation under the switch, no counters and no send buttons on the page. What
leaves, what never does and when collection fires is written in
[Error collection and uptime](#error-collection-and-uptime) below and in
`docs/error-report.md` — the disclosure did not disappear with the text on the page, it
moved somewhere it can be read in full. The state of the collection — the collector's
address, the anonymous identifier, the sent, queued and dropped counters, the last answer,
the last send error and the failures by kind — is still served by the host's own loopback
routes, `/dsh-rustvy/state` and `/dsh-rustvy/errors`, and that is where it is read, not
in the interface. The address — `uptimeEndpoint`,
`http://185.75.189.247:3789/api/report` by default — has no field of its own: it is
repointed without a release by the `DSH_RUSTVY_UPTIME_ENDPOINT` environment variable or
by hand in `<profile>\.dsh-rustvy\config.json`.

Stored in `<profile>\.dsh-rustvy\config.json`. Five environment variables
override it, for a deployment that points the mirror and the collector elsewhere or
wants the plugin mounted but inert, mounted but silent, or mounted without the uptime
panel: `DSH_RUSTVY_ORIGIN` and `DSH_RUSTVY_DISABLED=1`, `DSH_RUSTVY_UPTIME_ENDPOINT`,
`DSH_RUSTVY_NO_ERRORS=1` and `DSH_RUSTVY_NO_UPTIME=1`.
The first repoints the provider's site, the second disables the plugin whole. The third
repoints the uptime collector and overrides both the default and `config.json`: only an
address that parses as `http`/`https` is accepted, trailing slashes are stripped, and an
unusable value is ignored, leaving the setting in force. The fourth and the fifth, each
set to `1` or `true`, force error collection and the uptime view off regardless of the
setting — the same device by which `DSH_RUSTVY_DISABLED` silences the marks.

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
no-op would reload a live profile for nothing. Up to date means more than the base
route, though: a write is spent when the base is current but one of the key ring's
clones has fallen behind, because otherwise a chat sending with another key would
see fewer models than its neighbour. Every write keeps the previous
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

## The API-key ring

Several provider keys in one profile, and each chat sending its requests with the
one its user picked. The choice lives in the composer's tool row — beside the
access-mode dropdown rather than in the model menu — applies to a single chat, and
survives a restart. The built-in DeepSeek account is untouched by anything in this
section.

### Why one key is one route

`@deepseek-ai/dsh-llm-pi-ai` takes its key from `profile.apiKeyEnv` — a *name*, not
a value — and resolves it through the harness credential service on every request,
caching nothing. Neither the call configuration (`LlmCallConfig`) nor the generate
options (`GenerateOptions`) has a field for a key, and `baseURL` and the headers are
baked into the profile snapshot. There is no way to hand the adapter a key "for this
request", so the only honest way to give a chat another key is another route: a clone
with the same `api`, the same `baseURL` and the same `models`, and its own
`apiKeyEnv`.

Everything else follows. Adding a key writes the value into the credential store
under a new reference, clones the profile's route through `ctx.configEditor`, and
records an entry in the ring. A chat's pick is applied on the `agent/request`
waterfall by renaming the provider in the call configuration — the same device, on
the same seam, that the harness uses to apply a per-chat model choice, so it works
wherever the model choice already works and opens no second path to a request.

| Key | Credential reference | Route | Route display name |
|---|---|---|---|
| first (primary) | `RUSTVY_API_KEY` — as the profile declares it | `rustvy` — as the profile declares it | `rustvy` |
| second | `RUSTVY_API_KEY_2` | `rustvy-k2` | `rustvy · <the key's label>` |
| n-th | `RUSTVY_API_KEY_<n>` | `rustvy-k<n>` | `rustvy · <the key's label>` |

The names are built from the route in the settings rather than hard-coded: with
`modelRoute: rustvy` the second key gets `rustvy-k2`, and with another route name it
gets that route's suffixes. A clone copies the route profile whole and changes only
`apiKeyEnv` and the display name, so a hand-written wire-compatibility switch — and
everything else the profile author knows about their gateway — carries into every
key instead of being lost the first time one is added.

The limit is 12 keys: this is a ring, not a registry. A new key takes the first
ordinal whose credential reference and route are both free, so a removed key's
reference is never reused and a foreign row that happens to sit on such a name is
never overwritten.

### The primary key

The ring's first key is not an entry somebody added but the route the profile
already declares: it inherits that route's `apiKeyEnv` and its name, and it stays
primary always. A profile that worked before this feature keeps working unchanged —
a ring of one key renames nothing and writes nowhere. The primary key cannot be
deleted: it belongs to the profile's route, and removing it would not remove a key,
it would break the provider for every chat, including the ones that never used the
ring. The refusal says exactly that and offers a value replacement instead, which
every key has and which touches no configuration, because the reference name does
not move.

### Where things live

| What | Where |
|---|---|
| Key values | `$DSH_HOME\.credentials.yaml`, `refs` — the same store the harness Models page writes and the same one the adapter reads |
| The ring's metadata | `<profile>\.dsh-rustvy\keys.json` — `id`, label, credential reference, route, primary flag, ordinal, creation date, and `defaultKeyId` |
| Per-chat picks | `<profile>\.dsh-rustvy\session-keys.json` — `sessionId → keyId` |
| The install's anonymous identifier | `<profile>\.dsh-rustvy\install.json` — a random UUID and a creation date; it belongs to error collection rather than to the ring, and lives beside the plugin's other files |
| Undelivered error reports | `<profile>\.dsh-rustvy\errors-queue.json` — the queue of reports the uptime collector has not accepted yet |
| The monitor's last view | `<profile>\.dsh-rustvy\uptime.json` — the cached collector answer the panel shows with a `stale` note when the collector is unreachable; it belongs to the uptime view rather than to the ring |

No file of this plugin ever holds a key value: not `keys.json`, not
`session-keys.json`, not the settings, not the profile backup a revert reads, not the
queue of error reports. The
loopback routes answer with a mask — the first three and the last two characters —
and an eight-character SHA-256 fingerprint, which is enough to recognise a key in a
list and to notice two entries holding the same one, and not enough to use it. The
value itself travels in the body of the single request that adds or replaces it, and
never in a query string: a URL is logged, cached and kept in a browser's history,
and a secret is none of those things' business.

The picks live on disk rather than in the session log: this is a routing preference
of the plugin's own, and a plugin that wrote its events into a durable log would
leave them behind in every session it was ever mounted in. Only deviations from the
default key are stored, so a chat created before the default changed follows the new
one instead of holding on to the old.

### What the interface shows

Two surfaces: one manages the ring, the other picks a key for its own chat. The
switch appears only when there is something to choose — with one key it is not drawn
at all, because one key is not a choice.

**Settings → Rustvy → «API-ключи».** The key list: label, mask, credential
reference, route, how many models that route serves, and how many chats picked it.
The **«+»** button in the section's header row opens an inline "label + value" form
with a masked field and a show/hide toggle. Each row offers a value replacement, a
rename (committed on blur), making it the default, a test and a two-step delete; the
primary key has no delete button, and its row says why. Below is a «Маршруты
ключей» block: the profile row and its package, the listing address, the
"requests through the substitution" counter, the number of chats with a pick of
their own, the missing and stale route lists, copyable paths to both files, and a
**«Починить маршруты»** button that appears only when some key's route really has
gone.

**The composer.** A compact button in the tool row, right after the access-mode
dropdown — a registration in the `conversation.input.left` slot: the active key's
label, or "ключ по умолчанию" when the chat has no pick of its own. Its menu holds one
row per key with a tick on the active one, a "По умолчанию" row, and a **«+ Добавить
ключ»** row with the same inline form; a key added from inside a conversation is
chosen for that conversation straight away, because adding one from there is done in
order to send with it. The button renders nothing until the slot has handed it a
`sessionId`: the choice belongs to a chat, and a switch that saved it for the wrong
one is worse than no switch.

**The model menu and the `/model` popup.** No key section here — no rows and no
header: the choice lives in the composer, and a second copy of the same list in the
menu would only double the places to get it wrong. What the decorator does here is
the opposite: it hides the provider groups the host names in `hiddenGroups`, which
are this ring's route clones, so one model list is not repeated once per key. The
host cannot simply not declare them — a clone needs its own model list, or a request
whose route was just renamed would find no model in it. The hiding is structural and
deliberately cautious: a group header is recognised by its shape rather than by a
class name, because the host's primitives classes are neither readable here nor
stable across versions, and what gets hidden is either the smallest element that
encloses the group or the header together with the siblings after it up to the next
header. When nothing can be identified with confidence, nothing is hidden: a model
row hidden by mistake is a choice taken away, while a duplicate group left in the
list is only a repetition.

### What adding a key does

The order is deliberate. The value goes into the credential store first: a route
whose reference resolves to nothing fails every request that names it. The
configuration write comes second, and if it fails the value is taken back out, so a
failed add leaves nothing behind. The ring document is written last, once both exist.

That configuration write is a real and supported one: it goes through
`ctx.configEditor`, which reconciles the profile, and it is exactly what the harness
Models page does when a provider is added. `configEditor.edit()` reconciles the whole
loader, so the ring's writes are queued: two keys added at once are two edits in
turn, never two edits against a document the other had just replaced. And when the
provider map already matches the ring, no write happens at all — spending a
reconciliation on a no-op is the same thing this plugin refuses to do with the model
list.

A key can be tested without sending a request with it: the test does a
`GET {baseURL}/models` with that key alone and reports the status, the number of
models served, and the provider's own error text as it came.

### How narrow the substitution is

It changes exactly one field of the call configuration — the route name — and only
when all of the following hold:

1. the feature is on (`apiKeys`);
2. the request carries a session id — with none there is no chat to choose for;
3. the ring holds two keys or more;
4. the key in force for that chat — its own pick, or the default when it has none —
   is not the primary one;
5. the request was already going to one of this ring's own routes (`rustvy`,
   `rustvy-k*`);
6. the target route is installed in the profile;
7. the target route serves the requested model.

Otherwise the configuration is returned as it came. `deepseek-account` and any other
provider — a second gateway, a neighbouring row, somebody's hand-written route with a
key — is never renamed: condition five asks whether the route belongs to the ring,
not whether it looks like one.

A clone that has gone or that does not serve the model does not fail the step: the
request goes out on the profile's route and the reason is written down. It is in the
`fallback` field of `GET /keys` — the settings page draws it as a warning above the
key list — and in a log line that does not repeat while the reason stays the same.
The reasoning is that a key route which is not ready is a configuration problem, and
the right answer to it is a request that succeeded plus a visible reason, not a step
that failed with nothing said about why. An exception inside the substitution itself
is caught, and the request goes on as it was going.

The model list is written in one pass over every route the ring owns — the base and
each clone the ring can see in the profile — so a clone cannot lag behind the base,
and the pasteable block (`/models.yaml`) carries the clones with their credential
references, so whoever would rather put the row into `cordis.patch.yml` by hand is
not reconstructing them from a description.

Two counters on `GET /keys` answer the question that would otherwise present as
"the keys do not work": `routing.seen` is how many requests the harness put through
the `agent/request` waterfall at all, and `routing.applied` how many of them were
renamed to a key's route. A zero under live traffic means the waterfall never
reaches the plugin, and that is visible at once.

## Error collection and uptime

The monitor exists because "the provider's site is down" is knowledge that today
belongs only to the people who just ran into it, and to each of them separately. A
failed request looks like a local problem: the user retries the step, switches model or
walks away, and nobody — the provider included — learns that four hundred other
installs were catching `upstream_502` at the same moment.

Collecting it by polling is not an option. A probe request is a real request to a model,
it costs the tokens of whoever's key it goes out on, and one "alive" mark per model per
minute burns exactly what the user is paying for. So uptime here is derived from passive
error reports: a request that happened anyway either succeeded or failed, the host half
knows which either way, but only a failure ever leaves the machine. There are no
additional requests at all, and the monitor judges a model's health by the absence of
errors in a window — while knowing the one thing a probe can never show: how many
*people* a fault reached.

### What one report carries

One report is one request: a flat JSON object, with no envelope and no array of events.
The collector takes it on `POST /api/report`; `meta` is the only object in it, and
everything else sits at the top level, because a great many of these are stored and read
back grouped by model and hour.

The default address is `http://185.75.189.247:3789/api/report`: the monitor's public
collector, on bare HTTP over a bare IP deliberately for now. It is
repointed without a release, through the `uptimeEndpoint` field in
`<profile>\.dsh-rustvy\config.json` or the `DSH_RUSTVY_UPTIME_ENDPOINT` environment
variable.

| Request field | What it carries |
|---|---|
| `plugin` | `dsh-rustvy` |
| `version` | the package version |
| `provider` | the name of the route the request went out on |
| `model` | the model's id |
| `code` | the kind of fault, from this plugin's own vocabulary: `upstream_502`, `connect_timeout`, `dns`, … |
| `status` | the HTTP status, and only when there is one: with no connection the field is absent rather than holding a `0` |
| `message` | the provider's own error text, scrubbed and cut to 2000 characters |
| `ts` | the moment of the failure in milliseconds; the collector stamps its own `serverTs` regardless |
| `meta` | an object of at most 8 KB: `id` — the install's anonymous identifier, `ms` — how long the attempt took, `n` — how many events are folded (only when more than one), `harnessCode` — the harness's own verdict as it named it, and `t` |

Each concept gets exactly one of the aliases the collector accepts: `code` rather than
`type` or `kind`; `message` rather than `error` or `detail`; `ts` rather than
`timestamp`. The anonymous identifier lives in `meta.id`, because the API has no
top-level field for it — and without it the monitor could not answer "how many people".

Never sent: prompts, message and chat content, file contents and paths, API keys, the
session id, and anything at all that names the user or their machine. That is the
construction rather than a promise: the report has no field such a thing could be put in,
and the one free-form field — `message` — goes through a scrubber that erases `sk-…`
keys, `Bearer` tokens, credential headers, named secrets, Windows paths (whole, spaces
included) and POSIX paths — both replaced by `<path>` — and long opaque runs.

### Which failures count as an outage

One rule: what broke at the provider is reported, and what happened to the user never
is. The verdict is read from the harness code, the status and the message text, and the
user's own situation is checked first — a quota message does not become an outage just
because a number resembling a status appears in it.

| Counts as an outage | Does not |
|---|---|
| `upstream_502`, `upstream_503`, `upstream_400`, `upstream_404` — any `upstream_*` except 401, 402, 403 and 429 | an ended subscription, a blocked account, an exhausted quota or balance |
| `http_5xx`, `http_404`, `http_408` | a rate limit, `429` included |
| `dns`, `refused`, `unreachable`, `tls` | an invalid, missing or revoked key |
| `connect_timeout`, `timeout`, `reset`, `server`, `transport` | a context window exceeded, an unknown model, a malformed request |
| | the user pressing stop |

`upstream_400` and `upstream_404` are reported while a bare `400` and a bare `404` are
not: the prefix means the provider's gateway named what its own origin answered, so what
broke is over there, and not in the request you composed.

### Successes go nowhere

The collector receives failures only: a report about a request that succeeded is never
sent. Successes are still observed locally, for one thing — settling a model's
still-folding failure the moment a request goes through again, so that report reaches the
collector at the instant of recovery rather than at the end of a folding window; the gap
between the two timestamps is the length of the outage. The counters successes move are
still served by the host in `errorReport`, but the settings page draws none of them, as
it draws no part of the collection summary.

The consequence is worth stating plainly: uptime on the monitor is the absence of errors
in a window, not a ratio of two kinds of report. A model nobody asked about looks the
same there as a model that is up.

### The anonymous identifier and the two files

The identifier is a random UUID and nothing else: no hardware id, no account name, no
path. It exists so the monitor can count people rather than requests — a thousand
reports from one install is one person retrying, a thousand reports from three hundred
installs is an outage. In a report it lives in `meta.id`. Resetting it is deleting
`<profile>\.dsh-rustvy\install.json`: the next send creates a new one, and this install
becomes somebody else as far as the monitor is concerned.

| What | Where |
|---|---|
| The anonymous identifier | `<profile>\.dsh-rustvy\install.json` |
| Undelivered reports | `<profile>\.dsh-rustvy\errors-queue.json` |

The queue on disk is part of the meaning rather than a cache: a report that could not be
delivered stays in the file with its real timestamp and leaves when the site answers, so
an outage reaches the monitor with the times it happened at rather than with the moment
connectivity came back. It is written at most once every 5 seconds and once more on
unload, so a restart during an outage loses nothing.

### Folding and ceilings

Without them, an install in a retry loop would send the collector thousands of reports
about one and the same outage:

| What | Value |
|---|---|
| Failure folding window | 60 seconds per model-and-kind pair: `ts` stays at the first failure, `meta.ms` is taken from the last, and the number of events grows in `meta.n` |
| Queue delivery | every 15 seconds, up to 10 reports per flush — each in a request of its own, because that is what the collector asks for |
| Per-minute ceiling | 20 reports per install — the direct counterpart of the collector's own 60 reports a minute per IP |
| Per-install allowance | 240 reports an hour; beyond it they are dropped rather than accumulated |
| Queue ceiling | 500 reports; on overflow the oldest are dropped |
| Retry after a refusal | 15 seconds, doubling up to 10 minutes |
| One send's timeout | 10 seconds |
| Writing the queue to disk | at most once every 5 seconds, and once more on unload |

The collector's answers are read by meaning rather than by one rule over every `4xx`.
`200 { ok: true }` means the report was accepted. `400` means it carried neither a
`message` nor a `code`: such a report is dropped as unusable, because a collector that
refused it once will refuse it again. `429` and any `5xx` — including the `503` of a
storage backend that is unavailable — keep the report queued and postpone the next
attempt, and a `Retry-After` header on a `429` is honoured as the floor of that backoff.
A transport failure keeps the report queued in exactly the same way, which is how an
outage reaches the collector after the site has answered, and reaches it with its
original timestamps.

`429` is kept apart from `400` deliberately: it means "busy", not "bad report", and a
report dropped on somebody else's rate limit would be a real failure lost. That limit is
60 reports a minute per IP, and this plugin's own stream stays below it by construction
rather than by agreement: identical failures of one model fold into a single report per 60
seconds, one flush carries at most 10 reports, the per-minute ceiling is 20 against their
60, the hourly allowance is 240, and the queue does not grow past 500. This plugin is not
why anybody gets a `429`.

Every install shares one collector address, which is what the per-minute ceiling is
really protecting: an outage on one machine does not consume the whole share of the
collector's 60 reports a minute that a shared NAT has between everyone behind it.

### Turning it off

With the **Собирать ошибки rustvy** switch in **Settings → Rustvy**, with
`collectErrors: false` in `<profile>\.dsh-rustvy\config.json`, or with the
`DSH_RUSTVY_NO_ERRORS=1` environment variable, which forces silence regardless of the
setting: that one is for a deployment that wants the plugin mounted but silent and would
rather not edit a profile file. Collection that is off sends nothing and queues nothing
new; it has no effect on the requests to the provider themselves, in any state. The
report shape, the kind vocabulary and the collector's contract are described in
[`docs/error-report.md`](docs/error-report.md).

## Model uptime

The same collector that takes the error reports hands back the monitor's view: which
models are answering, how many people they are failing, and how long they have been
failing. The plugin shows that view inside DSH — as a box on the settings page and as an
uptime badge in the model picker — so choosing a model does not mean opening a browser to
look for a line that is already visible here.

Every number in the box is the collector's own. The plugin recomputes nothing: a verdict
worked out locally would disagree with the monitor's web page, and two answers to "is this
model up" is worse than one.

### There is no percentage any more

The plugin reports errors only: it sees no successful requests and no traffic volume, so a
"percent available" has no denominator in principle. The number that used to be drawn on
the badge was the share of buckets with no errors in them, and it had three bad
properties: it moved with the window for the very same stream of events, it saturated — 47
errors in a bucket and one error contributed the same — and it was blind to breadth, so
one person's outage and a provider's looked identical.

What is measured well is something else: how many distinct installs reported errors, how
long ago the last one came, and how many there were. That is why the headline is now a
state rather than a percentage. The only share left on screen is **«затронуто N%
установок»** — distinct installs that reported errors in the window over distinct installs
that reported anything over 30 days. Its denominator is real, and it means reach rather
than availability; it is never called uptime anywhere.

### Where it is read from

The host half mirrors the collector's answer onto its own loopback route,
`GET /dsh-rustvy/uptime.json?range=1h|24h|7d|30d`, and the panel reads the mirror rather
than the collector: the request stays inside the machine, and the mirror holds the last
good answer, so an unreachable collector shows a cached picture with an explicit note
rather than an empty box. It refreshes every 30 seconds while the settings page is open
— the monitor's own page waits the same — and stops asking the moment the page is closed.

### The four states

| State | The collector's rule | Word | Colour |
|---|---|---|---|
| `ok` | no errors in the window | Без ошибок | `#22c55e` |
| `single` | errors, from one install | Локальный сбой | `#f59e0b` |
| `issues` | errors, from two installs or more | Сбои | `#ef4444` |
| `down` | three installs or more, last error within five minutes | Лежит | `#ef4444` |

The rule and its thresholds live in the collector, not here: the plugin takes the finished
`status` and turns it into a word and a colour. `single` is amber while `issues` and
`down` are red on purpose — one install reporting is most often that install's own
network, key or region, and painting that red would cry wolf on every bad evening. The
words and the colours come from the monitor's page, so the plugin and the site do not tell
different stories about the same model; every surface behind them is still an ordinary
`--dsw-alias-*` theme token, because the monitor's page has one dark theme and this one has
two.

A collector older than v2 answers `up | slow | down`. Those are translated as `up → ok`,
`slow → issues`, `down → down`, and `single` simply never arrives from it: until the
server is updated, a local fault is indistinguishable from a provider outage. An
unrecognised word is taken as `ok` — a model nothing was reported about in the window is a
model nobody complained about, not a fifth category the wire never mentioned.

### Windows and strips

The window switch — 1 hour, 24 hours, 7 days, 30 days, a day by default — is the panel's
own state rather than a setting: it is not written to `config.json`, so one glance at last
month does not become a preference every other surface inherits. The answer carries as
many buckets as the collector sent: 60 one-minute ones for an hour and 48 for every longer
window, so a bucket's width changes with the window — a minute over an hour, half an hour
over a day, three and a half over a week, fifteen over a month. The strip carries its
width as a label («1 столбик = 30 мин»), because unlabelled a week of bars reads exactly
like an hour of them. Bars are scaled by `max(1, …counts)`, which is what makes a single
error visible.

### The model row

The state word, «ошибок N от M установок», «последняя X назад», the bucket strip with its
width label, and «затронуто N% установок» when there is a denominator; underneath, the
last error with its time, its code and the provider's own text.

Some reports arrive with no usable `meta.id`, and those cannot be counted against anybody.
Then «ошибок 3 от 1 установки» quietly promises a breadth that was never measured — and
that is exactly the number a person acts on when deciding whether to trust a model. So a
caveat goes next to it: «(все анонимные)» when every error was anonymous, «(2 из 3
анонимных)» when some were. When none were, which is the common case, nothing is written.

An answer from a collector older than v2 carries no `installs`, no `affectedPct` and no
`minutesSinceLast`. The row then shows the error count without «от M установок», shows no
share at all, and takes «последняя X назад» from `lastError`; the header drops its
breadth clause. The panel comes out poorer but not wrong: neither «от 0 установок» nor
«затронуто 0%» ever appears on it.

The box's header: «моделей N · без ошибок N · локально N · сбои N · лежат N · ошибок за
период N · затронуто M из K установок». There is no percentage in the header on any
window, and that is not an omission: over 30 days the window and the reference period
coincide, so numerator and denominator are the same set of installs, and «затронуто 100%
установок» would read as a verdict while meaning only that the share was measured against
itself. The collector answers such a window with `summary.affectedPct: null`, and the
header shows the counts themselves — «затронуто 47 из 47 установок» — which stay honest
numbers and say the same thing without a false precision. Each model's own share is real
on every window including the month, because its denominator is the whole install base and
its numerator one model's installs; «затронуто 4,3% установок» stays meaningful in a row
where the same figure in the header would be a tautology.

### A collector that does not know the hour

The badges read the `1h` window, and a first-version collector does not have one and
answers it with an error. The plugin is updated before the collector is deployed, so that
interval is an ordinary state rather than an incident: the host half serves a `502`
carrying no models, every badge disappears — in the picker and on the selected-model
button alike — the vendor marks stay where they are, and the panel on a day keeps working
exactly as it did. An absent badge is more honest here than any number: a window the
collector cannot answer is a window in which it named no model. Switching the panel to an
hour says so in words and names the window — «Коллектор не ответил за период «1h»: …» —
because "the collector did not answer" and "the collector does not know this window" call
for different actions. A transport failure takes the badges away in the same way: unlike
the panel, which can hold a cached picture and label it with the moment it is from, a
badge has no way to say "this is what we knew a while ago".

### An empty answer is a normal one

The collector's aggregation is still being written, and it answers `total: 0` with no
errors and empty buckets on every window. The panel draws that as a finding rather than as
a failure: «ошибок нет» is an answer, and it is written in words instead of empty bars.
When the aggregation starts working, the same rows will show real outages and the page will
not need changing for it. That is a property of the collector, not of the plugin.

### The uptime badges in the model picker and on the selected-model button

A row the collector named gets a state badge in the model picker — at the row's right
edge, where the harness draws a pill of its own, and beside that pill rather than on top
of it. There is no percentage on it: `ok` is a quiet green dot with no number, `single` an
amber pill carrying the error count, `issues` and `down` a red pill carrying it. An error
count and a colour read faster than 97,9%, which meant nothing.

A row the collector did not name gets nothing at all — which is precisely why `ok` is a dot
rather than an empty space: "the collector said nothing about this model" and "it is fine"
have to look different. The tooltip carries the rest — «3 ошибки от 2 установок за
последний час · последняя 4 мин назад», with the same caveat about anonymous reports — and
for `ok` it says «ошибок не было за последний час».

The same badge is drawn on the selected-model button too — between the model's name and
its reasoning indicator when the build renders one, and right after the name when it does
not. The button is the one place where the model changes *under* the badge, so there is
one rule: when the selected model changes, the badge is either rewritten or removed, and
the previous model's state never stays in the button. Its states, colours and window are
exactly the picker's, and the **Иконка в кнопке выбранной модели** switch takes both the
vendor mark and the uptime badge off that button — it is the user's word on whether this
plugin writes into the button at all.

The badge describes the last hour and only that: the panel's window does not move it, or
its tooltip would lie about the number it is explaining. The badges are drawn by the same
pass that draws the vendor marks, so the marks' master switch takes them too, while
«Показывать аптайм моделей» takes only them.

This is a rule about drawing, not a new meaning for a state: the badge and the panel render
the same collector `status`, the badge saying it in colour and a count and the panel in a
word, a count and a strip.

### Turning it off

With the **Показывать аптайм моделей** switch in **Settings → Rustvy** (on by default),
with `uptimeView: false` in `<profile>\.dsh-rustvy\config.json`, or with the
`DSH_RUSTVY_NO_UPTIME=1` environment variable, which hides the panel regardless of the
setting. A view that is off
reads nothing: neither the panel nor the picker's uptime badges appear, and no request
goes to the mirror at all. The collector's answer shape, its fields and the mirror's
contract are described
in [`docs/uptime-view.md`](docs/uptime-view.md).

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
| `/dsh-rustvy/state` | GET | mirror status: version, model count, cached logos, route, proxy (credentials masked), every file path — `install`, `errorsQueue` and `uptime` among them — last error, the last computed drift, a key-ring summary, and an `errorReport` block: whether collection is on, the collector's address, the anonymous identifier, the sent, queued and dropped counters, the last answer, the last send error and the failures by kind. Never makes a request of its own; the ring summary is synchronous and reads no credential, so it carries counters and routes rather than masks. The settings page draws no part of the `errorReport` block — it is for whoever reads the route by hand — and a host half older than error collection sends neither it nor the two new paths |
| `/dsh-rustvy/refresh` | POST | re-read the catalog, re-warm every logo it names, and report — or, when the write mode allows it, apply — the model list |
| `/dsh-rustvy/apply-models` | POST | write the generated list into the route profile through `ctx.configEditor` |
| `/dsh-rustvy/revert-models` | POST | put the backed-up route profile back |
| `/dsh-rustvy/config` | POST | write settings; never touches the network |
| `/dsh-rustvy/errors` | GET, POST | loopback diagnostics for error collection, which the interface no longer surfaces: neither a button nor a status row on the settings page leads here. GET: the collection summary — the same `errorReport` block `/state` carries. POST `{ action: 'test' }` queues one synthetic event and flushes it immediately, `{ action: 'flush' }` sends what has accumulated; both answer with the fresh summary. A refusal is HTTP 200 with `{ ok: false, error }`, the way a disabled feature answers on `/apply-models`. The route keeps working: it is how delivery is checked by hand, when nobody wants to look at a screen for it |
| `/dsh-rustvy/uptime.json` | GET | the mirror of the monitor's view: `?range=1h\|24h\|7d\|30d` (`24h` by default) and the collector's answer as it came — `summary`, `installs`, `models` with their `status`, `errors`, `installs`, `anonymous`, `firstAt`, `lastAt`, `minutesSinceLast`, `affectedPct`, `buckets`, `events` and `lastError`, `byCode`, `generatedAt`, `storage` and `monitorUrl`; the deprecated `uptime` and `summary.slow` come from an older collector and are not shown by the plugin. When the collector is unreachable it serves the last good answer with `stale: true`, a `fetchedAt` and an `error`; with no cache at all, `502` and `{ ok: false, error }`. With the view switched off, `200` and `{ ok: false, error }`, the way every disabled feature answers |
| `/dsh-rustvy/keys` | GET, POST | GET: the whole ring — keys with a mask and a fingerprint, the default key, the hidden provider groups, the missing and stale routes, the substitution counters, the last refusal, both file paths, and whether `credentials` and `configEditor` are available. POST: one action on the ring (`add`, `set`, `rename`, `default`, `remove`, `repair`, `test`); a success answers with a fresh GET plus the action's own field, so one POST repaints everything. A refusal is `409` with `{ ok: false, error }`, an unknown action `400`. A key value is accepted in the body only |
| `/dsh-rustvy/session-key` | GET, POST | GET with `?sessionId=`: which key this chat sends its requests with (`keyId`), whether the choice is its own (`picked`), and the whole `GET /keys` answer besides; `400` without an id. POST `{ sessionId, keyId }` records the choice and answers with the same payload; `keyId: null` returns the chat to the default key |

## No restarts

The host half reloads itself, the same way `dsh-proxy-gui` does: the loader row
names this package, whose entry imports the implementation through a
cache-busting `?rev=` query, and a one-second poll of the `lib` directory disposes
the previous revision and starts the next one once a changed fingerprint repeats.
`lib/host.js`, `lib/models.js`, `lib/keys.js`, `lib/errors.js`, `lib/uptime.js` and
`lib/net.js` therefore reload
live; only an edit to the entry bootstrap itself needs a restart. The browser half arrives in an
open page through the harness's own live plugin composition; a page refresh works
too.

The plugins-menu title, description and icon are read from the package at
composition time, so a change to `locale/*.json` or `assets/icon.svg` needs a
restart to show.

## Requirements and degradation

Verified against dsh `0.2.1-rc.2`. The package declares no `engines.dsh` and no
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
| `credentials` | there is nowhere to put a key value: the ring stays at its one primary key, adding is unavailable, and the «API-ключи» section names the reason instead of showing a form that would fail |
| `configEditor` — for the ring | an existing key's value can still be replaced, but a new key's route cannot be added: the add form is disabled and the section says why |
| a key route lost to a hand edit of `cordis.patch.yml` or to a model-list revert | the key stays in the ring, its route is listed under `routes.missing`, that chat's requests go out on the profile's route with a visible reason, and **«Починить маршруты»** (`{ action: 'repair' }`) writes the ring's routes again |
| the uptime collector | reports stay queued on disk and leave when the site answers, so an outage still reaches the monitor with its real timestamps; requests to the provider are unaffected either way, and the backlog and the last send error are served by the loopback routes `/dsh-rustvy/state` and `/dsh-rustvy/errors` — the settings page shows neither |
| a host half older than error collection | `/state` arrives without the `errorReport` block and without the two new paths: the settings page draws the switch identically either way, because it draws no part of the collection summary, and the file paths appear only when the host names them |
| the monitor's view at the collector | the mirror serves the last good answer with `stale: true`, and the panel shows that cached picture with the moment it is from; with no cache at all it is a `502`, and the panel names the reason instead of spinning. The picker's uptime badges go with the data while the vendor marks stay: requests to the provider are unaffected either way |
| a collector older than v2, with no `1h` window | every badge disappears — in the picker and on the selected-model button — the vendor marks stay, and the panel on a day works as before, naming the window it could not read if it is switched to an hour. This is the state between the plugin updating and the collector being deployed, and an absent badge is more honest in it than a number |
| a collector older than v2, with no breadth fields | the panel translates the old state words, shows the error count without «от M установок», shows no share at all and takes the recency from `lastError`; the header drops its breadth clause. Neither «от 0 установок» nor «затронуто 0%» ever appears on it |

## Layout

| File | Role |
|---|---|
| `lib/index.js` | stable loader entry; owns the reload loop |
| `lib/host.js` | routes, catalog mirror, logo cache, model sync, the key ring and its `agent/request` substitution, settings |
| `lib/models.js` | pure mapping: what an origin publishes → one route-profile entry, the drift between two lists, and the YAML for a manual edit |
| `lib/keys.js` | pure ring arithmetic: labels, credential-reference and route names, the ring and pick documents, and reconciling a provider map with the ring |
| `lib/errors.js` | classifying a failure as infrastructure or as the user's own, scrubbing secrets and paths out of its text, the install's anonymous identifier, and the folding report queue with its file on disk |
| `lib/uptime.js` | the pure shape of the monitor's view: the ranges it accepts, coercing the collector's answer into the fields the panel draws, cutting strings and clamping percentages. It reads no network and keeps no cache — `lib/host.js` owns both |
| `lib/net.js` | one outbound GET on the process's route, then the environment's proxy |
| `client/client.js` | hand-authored browser bundle: the decorator, the settings page, the composer's key switch, and the hiding of clone groups in the model menu |
| `locale/en.json`, `ru.json`, `zh.json` | the plugins-menu title and description |
| `assets/icon.svg` | the plugins-menu icon |
| `cordis.patch.yml` | the loader row the profile's bundle list pulls in |
| `install.ps1` | install into a profile |
| `scripts/prepublish-check.mjs` | the publish gate: everything that can install fine and still be wrong |
| `tests/` | the mapping, the YAML emitter, the key ring, and the host and browser halves |

`lib/models.js`, `lib/keys.js` and `lib/uptime.js` are deliberately pure — no network, no
filesystem, no Cordis — so the mapping can be checked against a real origin's
answer, the ring arithmetic against an invented profile, and the shape of the monitor's
view against a collector's answer, without mounting
anything. `lib/errors.js` touches no network either: its sender is injected, precisely
because a queue whose transport is imported cannot be reasoned about at the moment the
site it reports on is the thing that is down. That module does read and write its own two
files — an install identity that could only be created inside a mounted host would be
nothing to build on. `lib/host.js` owns everything with a lifetime, including the reading
of the monitor's view and the cache of its last good answer, and is what a reload
replaces.

## Tests

```powershell
node tests\models-check.mjs              # pure mapping: live origin -> entries, drift, schema audit
node tests\yaml-roundtrip-test.mjs       # emitter vs two real YAML parsers, against a real route row
node tests\model-sync-host-test.mjs      # host: fake webServer + configEditor, real origin fetch
node tests\api-keys-host-test.mjs        # the key ring: fake credentials, configEditor and event bus, no network
node tests\error-report-host-test.mjs    # error collection: classification, folding and delivery to a local collector
node tests\uptime-host-test.mjs          # the monitor's view: the mirror, the cached answer and its stale note
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

`api-keys-host-test.mjs` is 84 assertions over the same host half, with a fake
credential store, a fake `configEditor` and a fake event bus, and no network at all:
the route's endpoint points at a closed port, so both the model-listing read and a
key test fail deterministically, and the mirrored island decides membership instead.
It asserts the substitution: a picked key renames the route while the model, the
reasoning effort and the output cap survive unchanged; a chat with no pick keeps the
profile's route; `deepseek-account` and a neighbouring route with somebody else's key
are never renamed; a request with no session is left alone; a model the clone does not
serve keeps the request on the base route and lands in `fallback`; a chat with no pick
follows the default key, and `keyId: null` returns it there. It asserts the refusals:
an empty key, a key with a space, an unknown action (`400`), removal of the primary
key (`409`). It asserts a removal: the clone route goes, the neighbour and the base
route survive, the stored value is unset, the picks of that key are dropped, and the
chat keeps using the base route afterwards. And it asserts the writes and the
counters: one add spends exactly one configuration edit, replacing a value spends
none, a model-list write covers the clone and keeps its own reference, the pasteable
block carries the clone, `repair` puts a lost route back, `keys.json` holds no secret,
a dispose releases both the route and the listener, and with the feature off nothing
is renamed.

`error-report-host-test.mjs` is the host test for error collection: classifying failures
into infrastructure and the user's own, folding reports into their windows, and
delivering them — one per request — to a collector brought up on a loopback address. It
is the same host half the two previous host tests drive, so the `/dsh-rustvy/errors`
route, the `errorReport` block in `/state` and the queue on disk are checked together
with what actually ends up in a report that was sent.

`uptime-host-test.mjs` is the host test for the monitor's view: the mirror on
`/dsh-rustvy/uptime.json`, its three windows, the cache of the last good answer on disk,
and the `stale` note with its `fetchedAt` and reason when the collector is unreachable.
It also checks that the mirror recomputes nothing — the collector's answer is handed
over as it came — and that a switched-off view answers `{ ok: false }` without making a
request at all.

The client test renders the settings page with a mini-React whose hook cells are
keyed per component instance, and asserts: the section is named Rustvy; the three
outbound addresses are real links that open outside the app; every file path is
shown with a copy button; the route, the profile row, the origin and the mark size
are editable and save on blur; both dropdowns save on change; the manual-edit panel
fetches and shows the block; the drift names the new, retired and changed models;
the write button is enabled while drift exists, disabled once current, and disabled
when the host offers no editor; revert stays disabled until a backup exists; and
each mutation posts to the right route and reports what actually moved.

The same test draws the key ring: the «API-ключи» section with its list, masks,
rename-on-blur, inline **«+»** form, test, make-default and two-step delete; an
explanation for every refusal — no `credentials`, an out-of-date host half, the
feature switched off — and the capability coming back once the reason is gone; the
«Ключи на несколько чатов» switch, reading the host's answer and posting its own
field to `/config`; the «Маршруты ключей» block with the substitution counters, the
chats with a pick of their own, both file paths, the missing and stale routes and the
**«Починить маршруты»** button; the limit of 12 keys; the composer's switch, which
renders nothing without a `sessionId` and nothing at all with a single key, reads its
chat's choice, posts it to `/session-key` and offers to add a key; a model menu and a
`/model` popup that grow no key section and no key rows; what the reads cost — two
interactions in a row spend one key read, opening the switch always reads, and a
choice spends one POST with no follow-up read; and an unload that leaves nothing of
its own in the picker or the popup. Separately, it asserts that a key value appears
in no URL and is gone from the page once the add is done.

It also draws the error-collection block: the switch with its exact label — on by
default, including when the fixture `/state` knows nothing of a `collectErrors` field at
all. Absence is asserted separately, and not only of the summary: the fixture carries a
complete `errorReport`, and the page still shows neither the «Состояние сборщика» caption,
nor any of the eight summary rows, nor a single value of theirs — no anonymous identifier,
no breakdown by kind, no moment of the last delivery — nor either send button, and the
recorded requests contain no call to `/dsh-rustvy/errors` at all. The prose the page no
longer carries is checked the same way: nineteen sentences it used to render — the
introduction under the heading, the promise under the collection switch and the seven
paragraphs that closed the page — are looked for in the tree and not found, while the
features they described are still there. A removal nobody asserts is a removal that comes
back. The one line that survived the removal is checked positively: the «Каталог не
получен» warning renders when the fixture `/state` carries an `error` and renders nothing
when it does not, because it is not prose but the only place the page reports a catalog
read that failed. A host half older than the feature is checked too: without the
`errorReport` block the page draws exactly what it draws with one, and does not throw.

It draws the uptime box too, against four fixtures: the all-green answer the collector
gives most days; a populated one carrying all four states and both edge cases
(`affectedPct: null`, and a window whose reports are all anonymous); the hour the badges
take their numbers from — where the mirror answers any longer window with doubled counts,
so a badge repainted from the wrong window is visible at once; and an answer from a
collector older than v2, with its three old states, a percentage and not one breadth
field. Asserted: a header that counts states instead of a percentage, and rows carrying
the words «Лежит», «Сбои», «Локальный сбой» and «Без ошибок»; the window switch, which
offers all four windows, defaults to `24h`, asks the mirror for `?range=1h` and posts
nothing to `/config`, since it is the panel's state rather than a setting; the bucket
width labelled — 48 half-hour bars over a day, 60 minute bars over an hour; «ошибок 5 от 3
установок» and «затронуто 6,4% установок» as the collector's own numbers rather than a
recount; a share with no denominator drawn as «—» and never as 0%; a last error three
hours old reading as «3 ч назад» and never as «только что»; the anonymous caveat standing
next to the number it qualifies; a cached answer showing its `fetchedAt` and the warning
with its reason; and an unreachable collector naming the reason and keeping the «Обновить»
button instead of spinning forever. The old answer comes out poorer but not wrong: its
words are translated, its error count is shown without «от M установок», no share is shown
at all, and neither «от 0 установок» nor «затронуто 0%» ever appears. A fifth fixture is a
30-day window, where the header's share stops meaning anything: the header shows its
counts («затронуто 47 из 47 установок») and no percentage, while one model's own share
stays real on the same window («затронуто 6,4% установок»), and the strip says its bars
are fifteen hours wide.

The interval between the plugin updating and the collector being deployed is checked
separately, with a fixture whose `range=1h` answers a `502` carrying no models while a day
keeps working. What is asserted is the part that would otherwise stay an assumption — that
the badge path neither throws nor hangs on a read that never lands: every badge goes,
including the one on the selected-model button, no badge of the previous window is left on
screen, the vendor marks stay, the panel names the window it could not read, and on a day
it goes on drawing rows. A transport failure — a read that answers nothing at all — is
checked the same way: the badges go rather than freeze, because a badge, unlike the panel,
has no way to say what moment it is from.

The picker's uptime badges are checked separately, against the hour fixture with one model
in each state: `ok` is a quiet dot with no number, `single` an amber pill with its error
count, `issues` and `down` red pills with theirs, and all four colours are the monitor's;
the dot stays distinguishable from an empty space, so "the collector said nothing" and
"there were no errors" do not look alike; the tooltip names the window («за последний
час»), the error count, the install count and the recency; the badge sits inside the row
ahead of the row's own trailing control and keeps the vendor mark; a second pass draws no
second badge; a row that already carries a harness pill keeps both, ours as a sibling
rather than a child; switching the panel to 30 days does not repaint badges whose tooltips
say an hour; a switched-off view takes the badges and leaves the vendor marks; and an
unload takes the badges with it. The badge on the selected-model button is checked
separately: it carries the selected model's state and colour, stands between the name and
the reasoning indicator, and on a button with no indicator right after the name; the
button's own furniture — the indicator, «Default», the chevron, the stop button — and the
vendor mark are left untouched; when the selected model changes the badge is rewritten, a
quiet dot becoming a red pill, and on a model the collector did not name it disappears,
so the previous model's state never lingers in the button; and switching off «Иконка в
кнопке выбранной модели» takes the badge off that button while the picker rows keep
theirs. The uptime switch is checked the way every other one is — it posts its own field
to `/config`, and off means the panel explains itself in words and makes no request to the
mirror at all.

The mark-drawing half is **not** covered by an automated suite in this repository,
and that is worth knowing up front. It works on the DOM of an already-open page, so
it is checked by eye: which rows get a mark and which icon each gets, that effort
rows, provider headings and the search field stay bare, that a model whose logo
could not be fetched gets a monogram chip instead of a blank box, that a row added
later gets marked too, that a second pass duplicates nothing, and that an unload
removes what was added. `model-sync-client-test.mjs` covers the settings page and the
composer's key switch, not the drawing of marks; hiding the clone groups is the same
kind of work on an already-open page, and all the suite asserts there is that the
menu grows no key section and no key rows.

## License

MIT — see [LICENSE](LICENSE).
