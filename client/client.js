/**
 * dsh-rustvy — browser half.
 *
 * Draws one monochrome vendor mark in front of every model name in the model
 * picker, on the same three surfaces the harness and its skins use:
 *
 *   - the composer's model seat (its trigger and its menu rows),
 *   - the `/model` command popup,
 *   - a skin that redraws the picker itself (`dsh-claude-style`), when one is
 *     mounted and active.
 *
 * The marks are the provider's own: the host half mirrors the catalog and the
 * logo files from the provider's public site to a loopback route, and this half
 * paints them with a CSS mask filled by `currentColor`, which is how the
 * provider's dashboard paints them — so a mark follows the row's colour in the
 * light and the dark palette alike, and needs no colour variants of its own.
 *
 * A model the mirrored catalog does not know is matched by the shape of its id
 * (`claude-*`, `gpt-*`, `glm-*`, …). A model that matches nothing, and a logo
 * the mirror could not fetch, fall back to a small monogram chip, so a row is
 * never left with a blank box where a mark should be.
 *
 * This half also carries the *API key* a chat sends with, which is the only
 * honest way to change a key per chat: the provider adapter bakes `apiKeyEnv`
 * into a route snapshot, so one key means one route, and the host half writes a
 * route per key (`docs/api-keys.md`). The choice is offered in exactly one place
 * in a conversation — a compact selector in the composer's tool row, right after
 * the permission/mode dropdown — and managed on the settings page. It never sees
 * a key value except in the body of the one request that adds or replaces it, and
 * the DeepSeek account is untouched: the host only substitutes routes of this
 * plugin.
 *
 * This is a hand-authored bundle in the loader's factory-CJS protocol
 * (`window.__ModuleLoader__.load`), which is what the client module system
 * serves for a package declaring `dsh.client`. `react` comes from the frozen
 * platform module table and is used by the settings page and the composer
 * selector; the mark decoration itself is plain DOM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rustvy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Host-half API base, served by this package's own loopback routes. */
    const API = '/dsh-rustvy'

    /** Attribute this half leaves on a row it drew a mark into. */
    const ROW_FLAG = 'data-dmi-row'

    /** Class of one drawn mark. */
    const MARK = 'dmi-mark'

    /**
     * Class of one uptime dot this half drew into a picker row.
     *
     * Its own class rather than a second `dmi-mark`: the observer has to tell this
     * half's own writes from the host's, the unload has to take the dots with it,
     * and a dot is not a vendor mark — it says whether the model is answering, not
     * who makes it.
     */
    const DOT = 'dmi-uptime-dot'

    /** Range the picker's dots describe; the settings box picks its own. */
    const DOT_RANGE = '24h'

    /** How long the picker keeps its uptime read before an interaction re-reads it. */
    const UPTIME_TTL_MS = 30_000

    /** Body attribute that turns on "one mark per row" for competing skins. */
    const HIDE_FLAG = 'data-dmi-hide-other'

    /**
     * The containers this half treats as a model menu.
     *
     * One list, two consumers: `rowOf` uses it to decide where a mark may be drawn
     * and the clone-group hiding uses it to decide where a duplicate provider group
     * may be hidden. Sharing it is the point — a surface one pass decorates and the
     * other ignores is a menu where the marks are right and the list is still
     * doubled, which reads as a bug rather than as two features.
     */
    const MENU_SURFACE_SELECTOR = '[role="menu"], [role="listbox"], [class*="_menu"], [class*="_card"], [class*="_groups"], .dsh-claude-model-popover'

    /**
     * Class this half puts on a provider group it hid, and on the rows hidden with
     * it.
     *
     * A class rather than a style edit, so restoring a group means dropping the
     * class instead of remembering what `display` used to be: the host may have
     * changed it while this half was mounted, and writing a remembered value back
     * would then overwrite the host's own state.
     */
    const HIDDEN_GROUP = 'dmi-hidden-group'

    /**
     * Anything the host treats as a choice, and therefore never as a group header.
     *
     * The picker's rows are `button[role="menuitemradio"]` carrying `_option` and
     * `_modelOption`; both fragments are listed because a header must not be
     * confused with the copy inside a row either.
     */
    const INTERACTIVE_SELECTOR = 'button, [role="menuitemradio"], [role="option"], [class*="_option"], [class*="_row"]'

    /** The event both halves of this page use to agree on a changed setting. */
    const CHANGED = 'dsh-rustvy:changed'

    /** Theme tokens the settings page styles with, so it follows both palettes. */
    const C = {
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      /**
       * The collector's own three status colours, taken from its monitor page so the
       * plugin and the web monitor tell the same story. Accents only — dots, bars and
       * the status word: every surface behind them is `C.surface` and `C.border`,
       * because the collector's page has one dark theme and this one has two.
       */
      up: '#22c55e',
      slow: '#f59e0b',
      down: '#ef4444',
    }

    /** The three statuses the collector reports, and how each reads here. */
    const STATUSES = Object.freeze({
      up: { label: 'Operational', short: 'UP', color: C.up },
      slow: { label: 'Degraded', short: 'SLOW', color: C.slow },
      down: { label: 'Down', short: 'DOWN', color: C.down },
    })

    /**
     * One status word, resolved against the collector's own vocabulary.
     *
     * Anything it does not name falls back to `up` rather than to an error state: a
     * model with no reports in the window is a model nothing complained about, and
     * inventing a fourth status for an unknown string would say more than the wire
     * did.
     *
     * @param status - the collector's `status` field.
     * @returns `{ label, short, color }`.
     */
    function statusOf(status) {
      return STATUSES[typeof status === 'string' ? status : ''] ?? STATUSES.up
    }

    /** The one sans stack this half types with, shared by CSS rules and inline styles. */
    const SANS = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif'

    /** The one monospace stack this half uses for ids, paths and key masks. */
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const font = `13px/1.5 ${SANS}`

    /**
     * The mark's own styling.
     *
     * A mask — not an `<img>` — for the reason the provider's dashboard has one:
     * the logo files are single-colour shapes, and a mask paints them in
     * `currentColor`, so one file serves both palettes and every row state
     * (hover, disabled, selected) without a variant of its own.
     *
     * The monogram variant paints no background at all: a mask whose URL failed
     * to load would otherwise leave a solid square, so a row whose logo is
     * missing gets a letter in a box instead of a block of ink.
     *
     * The composer's key switch is styled here rather than inline because a hover
     * state cannot be written inline at all, and because its popup needs a stacking
     * context and a scroll box that a row of style objects would only spell worse.
     * Every colour is a theme token or a `color-mix` over `currentColor`, which is
     * what keeps one rule correct in both palettes.
     */
    const CSS = `
.${MARK}{--dmi-size:16px;flex:none;width:var(--dmi-size);height:var(--dmi-size);min-width:var(--dmi-size);display:inline-block;background-color:currentColor;opacity:.9;-webkit-mask:var(--dmi-src) center / contain no-repeat;mask:var(--dmi-src) center / contain no-repeat;pointer-events:none;vertical-align:middle}
.${MARK}[data-dmi-surface="trigger"]{opacity:.85}
.${MARK}[data-dmi-mono]{background-color:transparent;-webkit-mask:none;mask:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:4px;font-size:calc(var(--dmi-size) * .58);font-weight:700;line-height:1;letter-spacing:.01em;opacity:.7;box-sizing:border-box}
body[${HIDE_FLAG}] [${ROW_FLAG}] .dsh-claude-model-combine,body[${HIDE_FLAG}] [${ROW_FLAG}] svg[data-combine-word]{display:none!important}
.${HIDDEN_GROUP}{display:none!important}
.${DOT}{--dmi-dot:7px;flex:none;width:var(--dmi-dot);height:var(--dmi-dot);min-width:var(--dmi-dot);border-radius:50%;background:var(--dmi-dot-color,currentColor);opacity:.95;pointer-events:none;vertical-align:middle;margin-inline-end:5px}
.dmi-glyph{display:inline-flex;flex:none;align-items:center;justify-content:center}
.dmi-glyph svg{display:block;width:100%;height:100%}
.dmi-key-sep{height:1px;flex:none;margin:4px 8px;background:${C.border}}
.dmi-key-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmi-key-note{flex:none;font:400 10.5px/1.4 ${SANS};color:${C.labelSecondary}}
.dmi-key-check{width:12px;height:12px;color:${C.brand}}
.dmi-keywrap{position:relative;display:inline-flex}
.dmi-keybtn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;font:500 12px/1 ${SANS};color:${C.label};background:transparent;border:1px solid ${C.borderStrong};border-radius:7px;cursor:pointer;box-sizing:border-box}
.dmi-keybtn:hover{background:color-mix(in srgb, currentColor 8%, transparent)}
.dmi-keybtn[data-dmi-open="1"]{border-color:${C.brand};color:${C.brand}}
.dmi-keybtn .dmi-glyph{width:13px;height:13px}
.dmi-keybtn-label{max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmi-keypop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;display:flex;flex-direction:column;gap:1px;min-width:230px;max-width:320px;max-height:60vh;overflow:auto;padding:5px;font:400 12.5px/1.45 ${SANS};color:${C.label};background:${C.surface};border:1px solid ${C.borderStrong};border-radius:10px;box-shadow:0 8px 24px color-mix(in srgb, #000 22%, transparent)}
.dmi-keypop-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;font:inherit;color:inherit;text-align:left;background:transparent;border:0;border-radius:7px;cursor:pointer;box-sizing:border-box}
.dmi-keypop-row:hover{background:color-mix(in srgb, currentColor 8%, transparent)}
.dmi-keypop-row[data-dmi-active="1"]{color:${C.brand}}
.dmi-keypop-row[data-dmi-disabled="1"]{opacity:.55;cursor:default}
.dmi-keypop-form{display:flex;flex-direction:column;gap:6px;padding:7px 8px 4px}
.dmi-keypop-form input{font:400 12px/1.4 ${SANS};color:${C.label};background:transparent;border:1px solid ${C.borderStrong};border-radius:6px;padding:4px 7px;width:100%;box-sizing:border-box}
.dmi-keypop-form input::placeholder{color:${C.labelSecondary}}
.dmi-keypop-form input:focus{outline:none;border-color:${C.brand}}
.dmi-keypop-err{padding:0 8px 4px;font-size:11.5px;color:${C.bad}}
`

    /**
     * Vendors recognised by the shape of a model id, for a model the mirrored
     * catalog does not list. Order matters: the first rule that matches wins, so
     * the narrow families sit above the broad ones. Each rule names the logo file
     * the provider's own site uses for that vendor.
     */
    const VENDOR_RULES = [
      { match: /^abyss\//u, strip: true },
      { match: /^(claude|anthropic)([-.\/]|$)/u, icon: 'claude.svg', vendor: 'anthropic', label: 'Anthropic' },
      { match: /^fable([-./]|$)/u, icon: 'anthropic.svg', vendor: 'anthropic', label: 'Anthropic' },
      { match: /^(gpt|chatgpt|o[1-9]|codex|openai)([-.\/]|$)/u, icon: 'openai.svg', vendor: 'openai', label: 'OpenAI' },
      { match: /^(gemini|gemma|google)([-.\/]|$)/u, icon: 'googlegemini.svg', vendor: 'google', label: 'Google' },
      { match: /^(glm|zhipu|zai)([-.\/]|$)/u, icon: 'zhipu.svg', vendor: 'zhipu', label: 'Zhipu' },
      { match: /^(kimi|moonshot|k3)([-.\/]|$)/u, icon: 'kimi.svg', vendor: 'moonshot', label: 'Moonshot' },
      { match: /^(qwen|alibaba)([-.\/]|$)/u, icon: 'qwen.svg', vendor: 'qwen', label: 'Alibaba Qwen' },
      { match: /^deepseek([-.\/]|$)/u, icon: 'deepseek.svg', vendor: 'deepseek', label: 'DeepSeek' },
      { match: /^ahmia([-.\/]|$)/u, icon: 'ahmia.svg', vendor: 'ahmia', label: 'Ahmia' },
      { match: /^mimo([-.\/]|$)/u, icon: 'xiaomi.svg', vendor: 'xiaomi', label: 'Xiaomi' },
      { match: /^(grok|xai)([-.\/]|$)/u, icon: 'xai.svg', vendor: 'xai', label: 'xAI' },
    ]

    /** One decoration pass' worth of state, replaced wholesale on every load. */
    const state = {
      ready: false,
      enabled: true,
      size: 16,
      markTrigger: true,
      hideOtherMarks: true,
      /**
       * The collector's uptime view, as the picker's dots see it.
       *
       * Two maps over one list, for the same reason the catalog has `byId` and
       * `byName`: a row names a model by its display name as often as by its id, and
       * a dot that only matched one of the two would flicker between rows that mean
       * the same model. Only the range the dots claim to describe is absorbed — a
       * box switched to 30 days must not repaint the picker's «за 24 часа».
       */
      uptimeView: true,
      uptime: new Map(),
      uptimeByName: new Map(),
      uptimeLoadedAt: 0,
      uptimeRevision: 0,
      uptimeError: null,
      uptimeStale: false,
      /** The last answer, so a throttled caller can render without re-reading. */
      uptimePayload: null,
      byId: new Map(),
      byName: new Map(),
      records: [],
      available: new Set(),
      version: null,
      fetchedAt: null,
      error: null,
      /**
       * API keys, shared by both surfaces that draw them.
       *
       * One copy rather than one per surface, because the composer's selector and
       * the settings page must agree on which key is active the moment either of
       * them changes it. `keyId` is the choice for `sessionId`; `null` means "the
       * default", which is what the host answers with for a chat that never picked
       * one.
       */
      keys: [],
      keyId: null,
      defaultKeyId: null,
      sessionId: null,
      /**
       * The display names of the routes that are plumbing rather than choices.
       *
       * The host computes them as `<base> · <label>`, one per extra key. It cannot
       * leave them out of the profile — a clone has to keep its models so the call
       * still resolves once the swap has renamed the route — so the picker would
       * otherwise list every model once per key, and `hideProviderGroups` hides
       * exactly these groups to keep the list clean.
       */
      hiddenGroups: [],
      keysLoadedAt: null,
      /** How many keys the host will hold; the «+» form stops there. */
      maxKeys: 12,
      /** `missing` routes this half can offer to repair, `stale` ones it cannot. */
      routes: { missing: [], stale: [] },
      /** How many requests the substitution saw and how many it changed. */
      routing: { seen: 0, applied: 0 },
      /** The last request that could not use its key, and why. */
      fallback: null,
      /** How many chats carry a pick of their own. */
      picks: 0,
      /** Where the host keeps the key metadata, for the settings page's path rows. */
      keysPaths: {},
      packageName: null,
      modelsUrl: null,
      /** False when `/keys` 404s, i.e. the host half predates this feature. */
      keysAvailable: false,
      keysEnabled: true,
      keysCredentials: true,
      keysEditor: true,
      keysError: null,
      /** The last `/keys` answer, for the settings section to repaint from. */
      keysPayload: undefined,
      /** Bumped on every key-list load, so a caller can tell a read from a cache hit. */
      keysRevision: 0,
    }

    /** Style element this half owns; the loader inventories it, and so do we. */
    let styleElement = null

    /** True while this half is writing, so the observer ignores its own edits. */
    let suppress = false

    /** A pass is scheduled; coalesce mutations into one animation frame. */
    let scheduled = false

    /** The observer, when one is running. */
    let observer = null

    /** A key-list read is in flight; coalesces the burst a menu open causes. */
    let keysLoading = null

    /** An uptime read is in flight; coalesces the same burst for the same reason. */
    let uptimeLoading = null

    /**
     * How young a key-list read may be before an interaction re-reads it.
     *
     * Every `pointerdown` and `focusin` in the application reaches this half, and a
     * read is not free on the other side: the host resolves each key's credential to
     * build the answer. Two seconds keeps a menu open honest — a key added in
     * another window still shows up on the next click — without charging a round
     * trip per click in the GUI.
     */
    const KEYS_TTL_MS = 2000

    /** When the last read or mutation settled, and what it answered. */
    let keysFetchedAt = 0
    let keysLastAnswer = null

    /**
     * Mark the shared state as just read, so the throttle starts from now.
     *
     * A mutation's answer is a fresh list exactly like a read's, so it resets the
     * window too: the next interaction must not spend a round trip re-learning what
     * the POST already said.
     *
     * @param answer - the payload to hand a throttled caller next, `null` when
     *   there is no list to fall back on, or omitted to keep the one already held
     *   (a refused mutation leaves the list exactly as it was).
     */
    function markKeysRead(answer) {
      keysFetchedAt = Date.now()
      if (answer !== undefined) keysLastAnswer = answer ?? null
    }

    /**
     * Inject the stylesheet during materialization, which is the moment the
     * loader inventories a plugin's styles, so an unload takes the rules with it.
     */
    function mountStyles() {
      if (styleElement !== null) return
      const element = document.createElement('style')
      element.setAttribute('data-dsh-rustvy', 'styles')
      element.textContent = CSS
      ;(document.head ?? document.documentElement).appendChild(element)
      styleElement = element
    }

    /** Drop the stylesheet, if this half still holds it. */
    function unmountStyles() {
      if (styleElement === null) return
      styleElement.remove()
      styleElement = null
    }

    /**
     * Normalize a label the way a match needs it: case-folded, whitespace
     * collapsed, and free of the decorative punctuation a skin adds.
     *
     * @param text - the row's text.
     * @returns the normalized form.
     */
    function normalize(text) {
      return String(text ?? '').replace(/\u00A0/gu, ' ').trim().toLowerCase().replace(/\s+/gu, ' ')
    }

    /**
     * Drop one leading `something/` segment from a label.
     *
     * Two cases produce one: the catalog's own zone ids (`abyss/claude-opus-5-5`)
     * and the `provider/model` id the composer shows while a model is
     * unavailable. In both, the part after the slash is the model.
     *
     * @param value - the normalized label.
     * @returns the label without its first segment, or the label itself.
     */
    function stripPrefix(value) {
      const slash = value.indexOf('/')
      return slash === -1 ? value : value.slice(slash + 1)
    }

    /**
     * Resolve one row's text to a catalog record.
     *
     * Four attempts, cheapest first: the model id, the catalog's display name, an
     * id that the text *starts* with (a skin can leave trailing copy in the same
     * element, so the name may be a prefix rather than the whole string), and
     * finally the vendor rules for a model the mirror has never seen. Each attempt
     * runs over the whole label and over its first token, because a label may read
     * "OPUS 5.5 — hybrid reasoning" as easily as "claude-opus-5-5".
     *
     * @param text - the row's visible name text.
     * @returns `{ icon, vendor, vendorLabel, from }`, or `undefined` for a row that
     *   is not a model (an effort row, a group heading, a failure row).
     */
    function resolve(text) {
      const raw = normalize(text)
      if (raw === '') return undefined
      const candidates = []
      /** Add one candidate form, without duplicates. */
      const add = value => {
        for (const form of [value, stripPrefix(value)]) {
          if (form !== '' && !candidates.includes(form)) candidates.push(form)
        }
      }
      add(raw)
      add(raw.split(/\s+/u)[0])

      for (const candidate of candidates) {
        const byId = state.byId.get(candidate)
        if (byId !== undefined) return entryOf(byId, 'catalog')
        const byName = state.byName.get(candidate)
        if (byName !== undefined) return entryOf(byName, 'catalog')
      }

      // A prefix match, longest id first, so `claude-opus-5-5` is never claimed by
      // the shorter `claude-opus-5` entry.
      let best
      for (const record of state.records) {
        const id = normalize(record.id)
        if (id.length < 3) continue
        for (const candidate of candidates) {
          if (!candidate.startsWith(id)) continue
          const next = candidate.charAt(id.length)
          if (next !== '' && /\w/u.test(next)) continue
          if (best === undefined || id.length > normalize(best.id).length) best = record
        }
      }
      if (best !== undefined) return entryOf(best, 'catalog')

      for (const candidate of candidates) {
        for (const rule of VENDOR_RULES) {
          if (rule.strip === true || !rule.match.test(candidate)) continue
          return { icon: rule.icon, vendor: rule.vendor, vendorLabel: rule.label, from: 'rule' }
        }
      }
      return undefined
    }

    /**
     * One record as a mark descriptor.
     * @param record - the mirrored catalog record.
     * @param from - where the match came from, for diagnostics.
     * @returns the descriptor the mark builder consumes.
     */
    function entryOf(record, from) {
      return {
        icon: record.icon === '' ? undefined : record.icon,
        vendor: record.vendor,
        vendorLabel: record.vendorLabel || record.vendor,
        displayName: record.displayName,
        from,
      }
    }

    /**
     * The letter a monogram chip shows for one descriptor.
     * @param entry - the mark descriptor.
     * @returns one or two uppercase letters.
     */
    function monogram(entry) {
      const label = String(entry.vendorLabel ?? entry.vendor ?? entry.displayName ?? '?').trim()
      if (label === '') return '?'
      const words = label.split(/[\s./-]+/u).filter(word => word !== '')
      if (words.length >= 2) return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase()
      return label.slice(0, 2).toUpperCase()
    }

    /**
     * Build one mark.
     *
     * @param entry - the resolved descriptor.
     * @param surface - `'row'` or `'trigger'`, which sets the mark's size.
     * @returns the element to insert.
     */
    function buildMark(entry, surface) {
      const span = document.createElement('span')
      span.className = MARK
      span.setAttribute('aria-hidden', 'true')
      span.dataset.dmiSurface = surface
      span.dataset.dmiVendor = entry.vendor ?? ''
      span.dataset.dmiKey = entry.icon ?? `mono:${entry.vendor ?? '?'}`
      span.dataset.dmiFrom = entry.from ?? ''
      // The trigger is a 28px control with 13px text, so its mark sits one step
      // below the row size; both follow the user's `size` setting.
      span.style.setProperty('--dmi-size', `${surface === 'trigger' ? Math.max(12, state.size - 2) : state.size}px`)
      const label = entry.vendorLabel ?? entry.vendor ?? ''
      if (label !== '') span.title = label
      if (entry.icon !== undefined && state.available.has(entry.icon)) {
        span.style.setProperty('--dmi-src', `url("${API}/logo/${encodeURIComponent(entry.icon)}")`)
      } else {
        span.dataset.dmiMono = ''
        span.textContent = monogram(entry)
      }
      return span
    }

    /**
     * The row that should carry a mark for one name node.
     *
     * A name node is either a trigger's label (the mark goes into the trigger
     * button, so the icon is visible without opening the menu) or a row's name
     * (the mark goes into the row). Rows are accepted only inside a menu, a
     * popup card or a skin popover: `[class*="_row"]` on its own would match
     * unrelated tables elsewhere in the application.
     *
     * @param node - the element whose text names a model.
     * @returns `{ row, surface }`, or `undefined` when the node is not in a
     *   surface this half decorates.
     */
    function rowOf(node) {
      if (node.matches('[class*="_triggerLabel"], .dsh-claude-model-btn-label')) {
        const trigger = node.closest('button')
        if (trigger === null) return undefined
        const seat = trigger.closest('[data-slot="conversation.input.model"], .dsh-claude-model-popover, [data-composer-card]')
        if (seat === null) return undefined
        return { row: trigger, surface: 'trigger' }
      }
      const row = node.closest('[role="menuitemradio"], [role="option"], [class*="_row"], .dsh-claude-model-option')
      if (row === null) return undefined
      const surface = row.closest(MENU_SURFACE_SELECTOR)
      if (surface === null) return undefined
      return { row, surface: 'row' }
    }

    /**
     * The text a row is matched by: its own name node when the caller has one,
     * otherwise the first name-like descendant, otherwise its `title`.
     *
     * @param row - the row element.
     * @param node - the name node that led here, if any.
     * @returns the text to resolve.
     */
    function nameOf(row, node) {
      const source = node ?? row.querySelector('[class*="_modelName"], [class*="_labelText"], .dsh-claude-model-copy')
      if (source !== null && source !== undefined) return nameText(source)
      return row.getAttribute('title') ?? nameText(row)
    }

    /**
     * Class names a skin or the host puts on the *other* text in a row: the
     * description line, a detail, a badge. They are part of the same element's
     * subtree as the model name, so reading `textContent` alone would hand the
     * matcher "claude-opus-5-5Hybrid reasoning model" and no catalog entry would
     * ever match it.
     */
    const NOT_NAME = /(?:^|[\s_])(?:desc|description|detail|badge)(?:$|[\s_-])|dsh-claude-model-desc|dsh-claude-model-combine/u

    /**
     * Read one element's name text, skipping the parts of the row that are not
     * the name.
     *
     * @param node - the element to read.
     * @returns the concatenated name text.
     */
    function nameText(node) {
      let text = ''
      for (const child of Array.from(node.childNodes ?? [])) {
        if (child.nodeType === 3) {
          text += child.textContent ?? ''
          continue
        }
        if (child.nodeType !== 1) continue
        if (child.classList?.contains(MARK) === true) continue
        if (NOT_NAME.test(String(child.className ?? ''))) continue
        text += nameText(child)
      }
      return text
    }

    /**
     * The nodes whose text names a model, across every surface.
     *
     * The list is deliberately narrow: the host menu's `_modelName`, the command
     * popup's `_labelText`, the two triggers' labels, and the skin's own copy
     * element. A selector that grabbed every row in the application would decorate
     * settings tables and file lists too.
     *
     * @param root - the subtree to scan.
     * @returns the candidate name nodes.
     */
    function nameNodes(root) {
      return root.querySelectorAll(
        '[class*="_modelName"], [class*="_labelText"], [class*="_triggerLabel"], .dsh-claude-model-btn-label, .dsh-claude-model-copy',
      )
    }

    /**
     * The mark this half already drew into one row, if any.
     *
     * Read from `children` rather than from a `:scope >` selector so the row's
     * descendants are never matched: a nested row (a skin's sub-pane) owns its own
     * mark, and a parent must not mistake it for its own.
     *
     * @param row - the row or trigger element.
     * @returns the mark element, or `null`.
     */
    function ownMark(row) {
      for (const child of Array.from(row.children ?? [])) {
        if (child.classList?.contains(MARK) === true) return child
      }
      return null
    }

    /**
     * Draw one row's mark, replacing a stale one.
     *
     * @param row - the row or trigger element.
     * @param entry - the resolved descriptor.
     * @param surface - `'row'` or `'trigger'`.
     * @returns true when the DOM changed.
     */
    function decorateRow(row, entry, surface) {
      if (surface === 'trigger' && !state.markTrigger) return false
      const key = entry.icon ?? `mono:${entry.vendor ?? '?'}`
      const existing = ownMark(row)
      if (existing !== null) {
        if (existing.dataset.dmiKey === key && existing.dataset.dmiSurface === surface) return false
        existing.remove()
      }
      row.insertBefore(buildMark(entry, surface), row.firstChild)
      row.setAttribute(ROW_FLAG, surface)
      return true
    }

    /**
     * The dot this half already drew into one row, if any.
     *
     * Read from `children` for the reason `ownMark` reads from `children`: a nested
     * row owns its own dot, and a parent must not mistake it for its own.
     *
     * @param row - the row element.
     * @returns the dot element, or `null`.
     */
    function ownDot(row) {
      for (const child of Array.from(row.children ?? [])) {
        if (child.classList?.contains(DOT) === true) return child
      }
      return null
    }

    /**
     * The uptime record one row's text names, if the view knows that model.
     *
     * Tried by id and by display name, on the whole label and on its first token,
     * because a row says "OPUS 5.5" as readily as "claude-opus-5-5" — the same two
     * forms `resolve` tries for the catalog. A prefix match is last and longest wins,
     * so `claude-opus-5-5` is never claimed by `claude-opus-5`.
     *
     * @param text - the row's visible name text.
     * @returns the collector's model record, or `undefined`.
     */
    function uptimeFor(text) {
      const raw = normalize(text)
      if (raw === '') return undefined
      const first = raw.split(/\s+/u)[0]
      for (const candidate of [raw, stripPrefix(raw), first, stripPrefix(first)]) {
        if (candidate === '') continue
        const byId = state.uptime.get(candidate)
        if (byId !== undefined) return byId
        const byName = state.uptimeByName.get(candidate)
        if (byName !== undefined) return byName
      }
      let best
      let bestKey = ''
      for (const candidate of [raw, first]) {
        for (const key of state.uptime.keys()) {
          if (key.length < 3 || !candidate.startsWith(key)) continue
          const next = candidate.charAt(key.length)
          if (next !== '' && /\w/u.test(next)) continue
          if (key.length > bestKey.length) {
            best = state.uptime.get(key)
            bestKey = key
          }
        }
      }
      return best
    }

    /**
     * Build one uptime dot.
     *
     * @param model - the collector's record for it.
     * @param status - the resolved status word.
     * @param title - the text a hover explains it with.
     * @returns the element to insert.
     */
    function buildDot(model, status, title) {
      const span = document.createElement('span')
      span.className = DOT
      span.setAttribute('aria-hidden', 'true')
      span.dataset.dmiStatus = status
      span.dataset.dmiModel = normalize(model?.id)
      span.style.setProperty('--dmi-dot-color', statusOf(status).color)
      span.title = title
      return span
    }

    /**
     * Draw one row's uptime dot, replacing a stale one.
     *
     * Idempotent in exactly the way `decorateRow` is: a dot that already says what the
     * answer says is left alone, so the observer never feeds on this half's own writes
     * and a repaint costs no DOM at all. A row the view does not know loses any dot it
     * had, because a stale dot is a claim about a model the collector stopped naming.
     *
     * @param row - the row element.
     * @param text - the row's visible name text.
     * @param surface - `'row'` or `'trigger'`; only rows are dotted.
     * @returns true when the DOM changed.
     */
    function decorateDot(row, text, surface) {
      const existing = ownDot(row)
      const model = surface === 'row' && state.uptimeView ? uptimeFor(text) : undefined
      if (model === undefined) {
        if (existing === null) return false
        existing.remove()
        return true
      }
      const status = typeof model.status === 'string' ? model.status : 'up'
      const uptime = Number.isFinite(model.uptime) ? model.uptime : null
      const errors = Number.isFinite(model.errors) ? model.errors : null
      const title = `Аптайм ${uptime === null ? '—' : `${uptime}%`} · ошибок ${errors === null ? '—' : errors} · за 24 часа`
      const id = normalize(model.id)
      if (existing !== null) {
        if (existing.dataset.dmiStatus === status && existing.dataset.dmiModel === id && existing.title === title) {
          return false
        }
        existing.remove()
      }
      // After the vendor mark when the row has one, so the two read as one lead-in
      // rather than as a dot floating somewhere in the middle of the label.
      const mark = ownMark(row)
      row.insertBefore(buildDot(model, status, title), mark === null ? row.firstChild : mark.nextSibling)
      return true
    }

    /**
     * One decoration pass over a subtree.
     *
     * Idempotent: a row that already carries the right mark is left alone, which
     * is what keeps the observer from feeding on its own writes even when the
     * suppression flag misses one.
     *
     * @param root - the subtree to scan; the whole document by default.
     * @returns how many marks were drawn or replaced.
     */
    function decorate(root = document) {
      if (!state.ready || !state.enabled) return 0
      let drawn = 0
      suppress = true
      try {
        for (const node of nameNodes(root)) {
          const found = rowOf(node)
          if (found === undefined) continue
          const text = nameOf(found.row, node)
          const entry = resolve(text)
          if (entry !== undefined && decorateRow(found.row, entry, found.surface)) drawn += 1
          // Dotted whether or not the row earned a vendor mark: a model the mirrored
          // catalog does not list still has an uptime, and a row with a dot and no
          // mark is a row this half knows nothing about except that it is answering.
          if (decorateDot(found.row, text, found.surface)) drawn += 1
        }
      } finally {
        suppress = false
      }
      setHideFlag(state.hideOtherMarks)
      return drawn
    }

    /**
     * Publish the "one mark per row" switch on the body, where the stylesheet's
     * rule for competing skin marks can see it.
     *
     * @param on - true to hide another skin's lockup in a row this half claimed.
     */
    function setHideFlag(on) {
      const body = document.body
      if (body === null || body === undefined) return
      if (on) body.setAttribute(HIDE_FLAG, '')
      else body.removeAttribute(HIDE_FLAG)
    }

    /** Remove every mark and dot this half drew, on unload or when they are switched off. */
    function clearMarks() {
      suppress = true
      try {
        for (const mark of document.querySelectorAll(`.${MARK}`)) mark.remove()
        // The dots go with the marks: both are this half's own writing in the host's
        // menu, and an unload that left one behind would leave a claim about a model
        // with nothing on the page able to correct it.
        for (const dot of document.querySelectorAll(`.${DOT}`)) dot.remove()
        for (const row of document.querySelectorAll(`[${ROW_FLAG}]`)) row.removeAttribute(ROW_FLAG)
        // The provider groups this half hid are its doing too: an unload that left
        // the class behind would leave a whole provider's models invisible with
        // nothing on the page able to bring them back.
        for (const element of document.querySelectorAll(`.${HIDDEN_GROUP}`)) {
          element.classList.remove(HIDDEN_GROUP)
        }
      } finally {
        suppress = false
      }
      document.body?.removeAttribute(HIDE_FLAG)
    }

    /**
     * Every descendant of one node, in document order.
     *
     * @param node - the subtree root.
     * @param out - the accumulator.
     * @returns the descendants, parents before children.
     */
    function walkDown(node, out = []) {
      for (const child of Array.from(node.children ?? [])) {
        out.push(child)
        walkDown(child, out)
      }
      return out
    }

    /**
     * The model menus on the page, innermost first of any nested pair.
     *
     * The same containers `rowOf` accepts, so hiding and marking agree on what a
     * menu is. A `/model` portal can match twice — a wrapper around the model list
     * — and only the inner one is kept: the outer walk would cross pane boundaries,
     * and a clone header in the model pane must not sweep the effort pane that
     * happens to sit after it.
     *
     * @returns the menu elements, in document order.
     */
    function menuSurfaces() {
      if (typeof document?.querySelectorAll !== 'function') return []
      const found = Array.from(document.querySelectorAll(MENU_SURFACE_SELECTOR) ?? [])
      return found.filter(surface => !found.some(other => other !== surface && surface.contains?.(other) === true))
    }

    /**
     * The elements of one menu that carry a wanted provider-group header.
     *
     * Matched structurally rather than by class, and that is deliberate: the group
     * header comes from a primitives package that is a frozen platform module, so
     * its class names are neither readable here nor stable across versions. What is
     * stable is the shape — inside the model list, a header is the one
     * non-interactive element whose whole trimmed text is the provider's display
     * name, and the host hands this half exactly those names in `hiddenGroups`.
     *
     * Best effort, and biased towards doing nothing at all. A candidate has to match
     * a wanted name exactly, sit outside any row or button, and hold at most one
     * element child; the outermost such element wins, so a label nested in a header
     * is not counted twice. A duplicate group left in the list is cosmetic. Hiding
     * a model row removes a choice the user opened this menu to make, so anything
     * doubtful stays visible.
     *
     * @param surface - the model list to walk.
     * @param wanted - the normalized `hiddenGroups` names.
     * @returns the header elements, in document order.
     */
    function groupHeaderElements(surface, wanted) {
      const headers = []
      for (const element of walkDown(surface)) {
        if (element.closest?.(INTERACTIVE_SELECTOR) !== null) continue
        if (Array.from(element.children ?? []).length > 1) continue
        const text = normalize(element.textContent ?? '')
        if (text === '' || !wanted.has(text)) continue
        if (headers.some(known => known.contains?.(element) === true)) continue
        headers.push(element)
      }
      return headers
    }

    /**
     * True for an element that could be a group header, wanted or not.
     *
     * Used only to bound a walk: the rows that follow a hidden header belong to it
     * up to the next header, and the next header is usually a provider this half was
     * not asked to hide. The same structural test as above, without the name match —
     * so an unexpected element (a "nothing found" line, a divider with text in it)
     * stops the walk early, which hides less rather than more.
     *
     * @param element - the sibling to test.
     * @returns true when the walk should stop here.
     */
    function looksLikeHeader(element) {
      if (element === null || element === undefined || element.nodeType !== 1) return false
      if (element.closest?.(INTERACTIVE_SELECTOR) !== null) return false
      if (Array.from(element.children ?? []).length > 1) return false
      return normalize(element.textContent ?? '') !== ''
    }

    /**
     * Hide the per-key clone groups of one menu.
     *
     * Every extra key adds a route, and a route the profile lists shows up in the
     * picker as another copy of the same models. The host cannot drop them — a
     * clone has to keep its models so the call still resolves once the swap has
     * renamed the route — so the list is kept clean here, by hiding and never by
     * adding.
     *
     * Two shapes are covered. When the header sits in a group element of its own,
     * that element is the smallest thing that can be hidden and the whole group
     * goes. Otherwise the header is hidden with its following siblings up to the
     * next header, which is the same set of nodes in a flat list.
     *
     * Idempotent by class: a second pass over an already hidden group changes
     * nothing, so the observer does not feed on it and a host re-render that drops
     * the class is simply answered by the next pass.
     *
     * @param surface - the model list to walk.
     * @returns how many elements this pass hid or restored.
     */
    function hideProviderGroups(surface) {
      const wanted = new Set(
        (state.hiddenGroups ?? []).map(group => normalize(group)).filter(text => text !== ''),
      )
      const hide = new Set()
      for (const header of groupHeaderElements(surface, wanted)) {
        // The smallest enclosing group: a parent that is not the surface itself,
        // holds at least one row, and says more than the header alone.
        const parent = header.parentNode
        const enclosed = parent !== null && parent !== undefined && parent !== surface
          && parent.nodeType === 1
          && parent.querySelector?.(INTERACTIVE_SELECTOR) !== null
          && normalize(parent.textContent ?? '') !== normalize(header.textContent ?? '')
        if (enclosed) {
          hide.add(parent)
          continue
        }
        hide.add(header)
        for (let next = header.nextElementSibling; next !== null && next !== undefined; next = next.nextElementSibling) {
          if (looksLikeHeader(next)) break
          hide.add(next)
        }
      }

      let touched = 0
      for (const element of walkDown(surface)) {
        const should = hide.has(element)
        const has = element.classList?.contains(HIDDEN_GROUP) === true
        if (has === should) continue
        if (should) element.classList?.add(HIDDEN_GROUP)
        else element.classList?.remove(HIDDEN_GROUP)
        touched += 1
      }
      return touched
    }

    /**
     * Hide the clone provider groups of every menu on the page.
     *
     * Needs no session and no read of its own: it is a pure function of the menu
     * DOM and the `hiddenGroups` the last `/keys` answer carried, so it belongs in
     * the decorate pass and runs whenever the marks do.
     *
     * @returns how many elements changed.
     */
    function hideCloneGroups() {
      let touched = 0
      suppress = true
      try {
        for (const surface of menuSurfaces()) touched += hideProviderGroups(surface)
      } finally {
        suppress = false
      }
      return touched
    }

    /** Coalesce a burst of mutations into one pass on the next frame. */
    function scheduleDecorate() {
      if (scheduled || suppress) return
      scheduled = true
      const run = () => {
        scheduled = false
        if (suppress) return
        decorate(document)
        // Same surfaces, same pass: the marks are drawn into the rows that are
        // left visible, and a clone group the host re-rendered is hidden again.
        hideCloneGroups()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else setTimeout(run, 16)
    }

    /**
     * Read the mirror's catalog and probe which logos it actually holds.
     *
     * A logo is probed rather than assumed: the host fetches on demand and may
     * be offline, and a mask whose URL 404s would paint a solid square. The probe
     * also warms the host's cache, so the rows that follow load their marks from
     * memory.
     *
     * @returns a promise that settles once the state is usable.
     */
    async function loadCatalog() {
      const response = await fetch(`${API}/catalog.json`, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)

      state.enabled = payload.enabled !== false
      state.size = Number.isFinite(payload.config?.size) ? payload.config.size : 16
      state.markTrigger = payload.config?.markTrigger !== false
      state.hideOtherMarks = payload.config?.hideOtherMarks !== false
      state.uptimeView = payload.config?.uptimeView !== false
      state.version = payload.version ?? null
      state.fetchedAt = payload.fetchedAt ?? null
      state.error = payload.error ?? null
      state.records = Array.isArray(payload.records) ? payload.records : []
      state.byId = new Map()
      state.byName = new Map()
      for (const record of state.records) {
        const id = normalize(record.id)
        if (id !== '' && !state.byId.has(id)) state.byId.set(id, record)
        const displayName = normalize(record.displayName)
        if (displayName !== '' && !state.byName.has(displayName)) state.byName.set(displayName, record)
      }

      const icons = [...new Set(state.records.map(record => record.icon).filter(icon => typeof icon === 'string' && icon !== ''))]
      // A rule-matched model needs its logo probed too, so the fallbacks are
      // covered even before the catalog lists that vendor.
      for (const rule of VENDOR_RULES) {
        if (typeof rule.icon === 'string' && !icons.includes(rule.icon)) icons.push(rule.icon)
      }
      const present = new Set()
      await Promise.all(icons.map(async icon => {
        try {
          const probe = await fetch(`${API}/logo/${encodeURIComponent(icon)}`, { headers: { accept: 'image/svg+xml' } })
          if (probe.ok) present.add(icon)
        } catch {
          // An unreachable mirror leaves the set smaller; rows fall back to monograms.
        }
      }))
      state.available = present
      state.ready = true
      return { models: state.records.length, logos: present.size, version: state.version }
    }

    /**
     * Reload the catalog and repaint. Called on mount, after a settings change,
     * and by the settings page's own refresh button.
     *
     * @returns a promise of the load summary, or of `undefined` when it failed.
     */
    async function reload() {
      try {
        // Both reads at once: the catalog is what the marks need and the key list
        // is what the composer's selector and the clone-group hiding need, and
        // neither waits on the other. `loadKeys` never rejects, so a dead key route
        // cannot fail the marks.
        const [summary] = await Promise.all([loadCatalog(), loadKeys(state.sessionId)])
        clearMarks()
        decorate(document)
        hideCloneGroups()
        // The uptime read goes second because the catalog answer is what carries the
        // toggle: a switch that is off must cost no request at all, not even one that
        // is then ignored. What it brings back is one more pass over the same rows,
        // and only when it actually moved something.
        if (state.uptimeView) {
          const before = state.uptimeRevision
          await loadUptime(DOT_RANGE)
          if (state.uptimeRevision !== before) decorate(document)
        }
        return summary
      } catch (error) {
        state.ready = false
        state.error = error instanceof Error ? error.message : String(error)
        clearMarks()
        return undefined
      }
    }

    /* ----------------------------- model uptime ----------------------------- */
    /*
     * The collector's own numbers, mirrored by the host half onto a loopback route
     * and drawn twice: a panel on the settings page, and one dot per model row in the
     * picker. Nothing here is computed by this half — a percentage invented locally
     * would disagree with the monitor's own web page, and two answers to "is this
     * model up" is worse than one.
     *
     * The empty answer is the normal one today, and it is rendered as a state of its
     * own rather than as a failure: the collector's aggregation is still being
     * written, so "no errors in this window" is what an honest panel says, and a
     * spinner or a red line over it would be the lie.
     */

    /**
     * Fold one uptime answer into the state the picker's dots read.
     *
     * Only the range the dots claim to describe is absorbed, so a settings box
     * looking at 30 days cannot repaint a picker whose titles say «за 24 часа».
     *
     * @param payload - the mirror's answer.
     * @param range - the range it was asked for.
     * @returns the payload, so a caller can render from it directly.
     */
    function absorbUptime(payload, range) {
      const answer = typeof payload === 'object' && payload !== null ? payload : {}
      state.uptimeError = typeof answer.error === 'string' ? answer.error : null
      state.uptimeStale = answer.stale === true
      state.uptimePayload = answer
      state.uptimeLoadedAt = Date.now()
      state.uptimeRevision += 1
      if (range !== DOT_RANGE) return answer
      const byId = new Map()
      const byName = new Map()
      for (const model of Array.isArray(answer.models) ? answer.models : []) {
        if (typeof model !== 'object' || model === null) continue
        const id = normalize(model.id)
        const name = normalize(model.name)
        if (id !== '' && !byId.has(id)) byId.set(id, model)
        if (name !== '' && !byName.has(name)) byName.set(name, model)
      }
      // A refused answer (`ok: false`: the view is switched off, or there is no cache
      // to fall back on) carries no models, and the dots have to go with them rather
      // than keep describing a window nobody is asking about any more.
      state.uptime = answer.ok === false ? new Map() : byId
      state.uptimeByName = answer.ok === false ? new Map() : byName
      return answer
    }

    /**
     * Read the mirrored uptime view for one range.
     *
     * Never throws and never rejects: an unreachable collector is a state to render,
     * not an error to surface, and the picker must not lose its vendor marks because
     * the monitor is down. Concurrent calls for one range share a single request —
     * the settings page polling and an interaction arriving in the same tick want the
     * same answer — and sequential ones are throttled to the collector's own 30 s
     * cadence, so a burst of clicks costs at most one loopback read per half minute.
     *
     * @param range - `24h`, `7d` or `30d`; the picker's own range by default.
     * @param options - `{ force: true }` to bypass the throttle.
     * @returns a promise of the answer, or of `null` when there was none.
     */
    function loadUptime(range = DOT_RANGE, options) {
      const want = typeof range === 'string' && range !== '' ? range : DOT_RANGE
      if (uptimeLoading !== null && uptimeLoading.range === want) return uptimeLoading.promise
      if (options?.force !== true && Date.now() - state.uptimeLoadedAt < UPTIME_TTL_MS) {
        return Promise.resolve(state.uptimePayload)
      }
      const promise = (async () => {
        try {
          const response = await fetch(`${API}/uptime.json?range=${encodeURIComponent(want)}`, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            state.uptimeError = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`
            state.uptimeStale = false
            state.uptimePayload = null
            state.uptimeLoadedAt = Date.now()
            state.uptimeRevision += 1
            if (want === DOT_RANGE) {
              state.uptime = new Map()
              state.uptimeByName = new Map()
            }
            return null
          }
          return absorbUptime(payload, want)
        } catch (error) {
          state.uptimeError = error instanceof Error ? error.message : String(error)
          state.uptimeLoadedAt = Date.now()
          state.uptimeRevision += 1
          return null
        } finally {
          uptimeLoading = null
        }
      })()
      uptimeLoading = { range: want, promise }
      return promise
    }

    /* ------------------------------ API keys ------------------------------ */
    /*
     * One key per route, because `@deepseek-ai/dsh-llm-pi-ai` resolves `apiKeyEnv`
     * from a route snapshot: there is no per-request key to hand it. The host half
     * owns the credentials store, the route configuration and the `sessionId →
     * keyId` map; this half only draws the choice and posts it. It never receives a
     * key value — `GET /keys` answers with a mask and a fingerprint — and the only
     * value it ever sends is the one just typed, in the body of one POST.
     *
     * Two surfaces draw it: the composer's switch, which is where a chat picks the
     * key it sends with, and the settings page, which is where keys are added,
     * named, checked and removed. Both are React, so neither leaves a node in the
     * host's own menus. What this half does write into the picker is a mark per
     * model row, and a hidden class on the clone groups the extra routes would
     * otherwise add to the list — hiding, never adding.
     */

    /**
     * Tell every surface this half draws that the shared state moved.
     *
     * One event, one meaning: "repaint from the state". Listeners must not fetch,
     * because a mutation already carried the fresh list home in its answer — a
     * listener that reloaded would make every key click cost two round trips.
     *
     * @param keys - true when only keys changed, so the decorator's listener can
     *   skip the catalog read a full `reload()` makes.
     */
    function announce(keys = false) {
      if (typeof window?.dispatchEvent !== 'function') return
      const event = typeof CustomEvent === 'function'
        ? new CustomEvent(CHANGED, { detail: { keys } })
        : typeof Event === 'function'
          ? new Event(CHANGED)
          : null
      if (event === null) return
      try {
        window.dispatchEvent(event)
      } catch {
        // A listener that throws is its own problem; the state is already correct.
      }
    }

    /**
     * Publish the session the composer control rendered for.
     *
     * The switch is the only surface that is handed a `sessionId`, and the choice
     * it posts is per chat, so the id lives in the module state: `chooseKey` reads
     * it back as the default, and a background refresh knows which chat to ask
     * about. Nothing is published until a control has one, which is why an
     * interaction on a page with no conversation costs no read at all.
     *
     * @param sessionId - the session id; anything else is ignored.
     * @returns true when the published session changed.
     */
    function publishSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (state.sessionId === sessionId) return false
      state.sessionId = sessionId
      return true
    }

    /**
     * Fold one host answer into the shared key state.
     *
     * Fields an answer omits keep their previous value, because the two routes
     * report different subsets: `/session-key` is the only one that knows this
     * chat's choice, `/keys` the only one that reports `editor` and `defaultKeyId`.
     * Overwriting what an answer left out would make a composer refresh forget
     * what the settings page had just learned.
     *
     * @param payload - the host's answer.
     * @param viaSession - true when it came from `/session-key`.
     * @returns the payload, so a caller can keep it for its own rendering.
     */
    function absorbKeys(payload, viaSession) {
      state.keys = Array.isArray(payload.keys) ? payload.keys : []
      state.hiddenGroups = Array.isArray(payload.hiddenGroups) ? payload.hiddenGroups : state.hiddenGroups
      if (payload.defaultKeyId !== undefined) state.defaultKeyId = payload.defaultKeyId ?? null
      if (payload.enabled !== undefined) state.keysEnabled = payload.enabled !== false
      if (payload.credentials !== undefined) state.keysCredentials = payload.credentials !== false
      if (payload.editor !== undefined) state.keysEditor = payload.editor !== false
      if (Number.isFinite(payload.maxKeys)) state.maxKeys = payload.maxKeys
      if (payload.routes !== undefined && payload.routes !== null) state.routes = payload.routes
      if (payload.routing !== undefined && payload.routing !== null) state.routing = payload.routing
      if (payload.fallback !== undefined) state.fallback = payload.fallback ?? null
      if (Number.isFinite(payload.picks)) state.picks = payload.picks
      if (payload.packageName !== undefined) state.packageName = payload.packageName ?? null
      if (payload.modelsUrl !== undefined) state.modelsUrl = payload.modelsUrl ?? null
      if (payload.paths !== undefined && payload.paths !== null) state.keysPaths = payload.paths
      // A global read must not move a chat's choice: it does not know it.
      if (viaSession) state.keyId = payload.keyId ?? null
      else if (state.sessionId === null) state.keyId = payload.defaultKeyId ?? null
      state.keysError = typeof payload.error === 'string' ? payload.error : null
      state.keysAvailable = true
      state.keysLoadedAt = new Date().toISOString()
      state.keysRevision += 1
      if (!viaSession) state.keysPayload = payload
      markKeysRead(payload)
      return payload
    }

    /**
     * Refresh the shared key state from the host.
     *
     * Never throws, and never rejects: a host half without these routes answers
     * 404 with an empty body, and that is a state to degrade into rather than an
     * error to surface. `keysAvailable` goes false, the composer and the picker
     * render nothing, and the settings section says which half is out of date.
     *
     * Concurrent calls share one request, because a menu open fires a `pointerdown`
     * and a `focusin` for the same click and both want the same answer. Sequential
     * ones are throttled instead: a caller that merely noticed an interaction gets
     * the answer that is already in hand, while one that is deliberately opening
     * something passes `force` and always reaches the host.
     *
     * @param sessionId - the session whose choice to read, or `null` for the list alone.
     * @param options - `{ force: true }` to bypass the throttle.
     * @returns a promise of the host's answer, or of `null` when there was none.
     */
    function loadKeys(sessionId, options) {
      if (keysLoading !== null) return keysLoading
      if (options?.force !== true && Date.now() - keysFetchedAt < KEYS_TTL_MS) {
        return Promise.resolve(keysLastAnswer)
      }
      const viaSession = typeof sessionId === 'string' && sessionId !== ''
      keysLoading = (async () => {
        const path = viaSession
          ? `/session-key?sessionId=${encodeURIComponent(sessionId)}`
          : '/keys'
        try {
          const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) {
            state.keysAvailable = false
            state.keys = []
            state.keyId = null
            // Dropped as well, so no surface keeps rendering a list the host just
            // said it does not have.
            state.keysPayload = undefined
            state.keysRevision += 1
            // A 404 with no body is the signature of an older host half, and saying
            // so is what stops this from reading as a broken network.
            state.keysError = response.status === 404
              ? 'host-половина не отдаёт /keys'
              : typeof payload.error === 'string'
                ? payload.error
                : `HTTP ${response.status}`
            markKeysRead(null)
            return null
          }
          if (viaSession) publishSession(sessionId)
          return absorbKeys(payload, viaSession)
        } catch (error) {
          state.keysAvailable = false
          state.keysError = error instanceof Error ? error.message : String(error)
          state.keysRevision += 1
          markKeysRead(null)
          return null
        } finally {
          keysLoading = null
        }
      })()
      return keysLoading
    }

    /**
     * One key mutation, which the host answers with a fresh list.
     *
     * The answer carries the whole `GET /keys` shape plus its result field, so a
     * mutation never needs a second read — and a refusal arrives in the same
     * answer, which is how the primary key says why it cannot be deleted.
     *
     * @param body - `{ action, … }` per `docs/api-keys.md`.
     * @returns a promise of the answer, or of `null` when the request failed.
     */
    async function postKeys(body) {
      try {
        const response = await fetch(`${API}/keys`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => ({}))
        // `response.ok` as well as the body's own verdict: a 400 whose body is not
        // JSON parses to `{}`, and absorbing that would empty the key list rather
        // than report a failure.
        if (response.ok && payload.ok !== false) absorbKeys(payload, false)
        else {
          state.keysError = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
          state.keysRevision += 1
          markKeysRead()
        }
        return payload
      } catch (error) {
        state.keysError = error instanceof Error ? error.message : String(error)
        state.keysRevision += 1
        markKeysRead()
        return null
      }
    }

    /**
     * Point one chat at one key.
     *
     * Posted first and only then applied locally: the host is the half that knows
     * whether the route behind that key still exists, so an optimistic flip would
     * show a choice the next request cannot honour.
     *
     * @param keyId - the key to send with, or `null` for the default.
     * @param sessionId - the chat to change; the published one by default.
     * @returns a promise of the answer, or of `null` when nothing was posted.
     */
    async function chooseKey(keyId, sessionId = state.sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      try {
        const response = await fetch(`${API}/session-key`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, keyId }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          state.keysError = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
          state.keysRevision += 1
          markKeysRead()
          return null
        }
        const next = payload.keyId === undefined ? keyId ?? null : payload.keyId ?? null
        // The answer carries the list too, so the picker repaints from one request.
        if (Array.isArray(payload.keys)) absorbKeys({ ...payload, keyId: next }, true)
        else {
          state.keyId = next
          state.keysRevision += 1
          markKeysRead()
        }
        announce(true)
        return payload
      } catch (error) {
        state.keysError = error instanceof Error ? error.message : String(error)
        state.keysRevision += 1
        markKeysRead()
        return null
      }
    }

    /** The key the current chat sends with: its own choice, else the default. */
    function activeKey() {
      const id = state.keyId ?? state.defaultKeyId
      return state.keys.find(key => key.id === id) ?? null
    }

    /**
     * What a key is called on screen.
     *
     * A key added without a label still has to read as something, and its route
     * name is the one stable thing about it that is not its value.
     *
     * @param key - the key record.
     * @returns the label to show.
     */
    function keyName(key) {
      const label = String(key?.label ?? '').trim()
      if (label !== '') return label
      const route = String(key?.displayName ?? key?.route ?? '').trim()
      return route === '' ? String(key?.id ?? 'ключ') : route
    }

    /** The inline form's own answer to "may this be submitted". */
    function keyFormError(value) {
      if (String(value ?? '').trim() === '') return 'Введите значение ключа.'
      return undefined
    }

    /** One labelled status line on the settings page. */
    function Row(props) {
      return h('div', { style: { display: 'flex', gap: '8px', marginBottom: '3px' } },
        h('span', { style: { color: C.labelSecondary, minWidth: '150px', flex: 'none' } }, props.name),
        h('span', {
          style: {
            color: props.tone === undefined ? C.label : props.tone,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            wordBreak: 'break-all',
          },
        }, props.children))
    }

    /**
     * One button on the settings page.
     *
     * `variant` carries the weight, not a second component: `'primary'` is the one
     * action a block offers, `'small'` is a per-row action that must not compete
     * with it — the key rows have four of them each.
     */
    function Button(props) {
      const primary = props.variant === 'primary'
      const small = props.variant === 'small'
      return h('button', {
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        ...(props.title === undefined ? {} : { title: props.title }),
        style: {
          padding: small ? '3px 9px' : '7px 14px',
          font,
          fontSize: small ? '11.5px' : undefined,
          fontWeight: 500,
          cursor: props.disabled === true ? 'default' : 'pointer',
          opacity: props.disabled === true ? 0.55 : 1,
          borderRadius: small ? '5px' : '6px',
          color: primary ? '#fff' : C.label,
          background: primary ? C.brand : 'transparent',
          border: primary ? '1px solid transparent' : `1px solid ${C.borderStrong}`,
        },
      }, props.children)
    }

    /** One dropdown on the settings page. */
    function Select(props) {
      return h('select', {
        value: props.value,
        disabled: props.disabled === true,
        onChange: event => props.onChange(event.target.value),
        style: {
          font,
          fontSize: '12.5px',
          color: C.label,
          background: C.surface,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: '6px',
          padding: '4px 8px',
          cursor: props.disabled === true ? 'default' : 'pointer',
        },
      }, props.options.map(option => h('option', { key: option[0], value: option[0] }, option[1])))
    }

    /** A readable rendering of an id list, or the word for "none of them". */
    function listOf(ids) {
      return Array.isArray(ids) && ids.length > 0 ? ids.join(', ') : 'нет'
    }

    /** The ids of the models whose fields moved, with the fields that moved. */
    function changedList(changes) {
      if (!Array.isArray(changes) || changes.length === 0) return 'нет'
      return changes
        .map(change => `${change.id} (${(change.fields ?? []).map(field => field.field).join(', ')})`)
        .join('; ')
    }

    /** Where a generated list came from, in words. */
    function sourceLabel(source) {
      if (source === 'endpoint') return 'список моделей маршрута'
      if (source === 'catalog') return 'зеркало каталога (список маршрута не ответил)'
      if (source === 'mirror') return 'зеркало каталога (без обращения к сети)'
      return 'не определён'
    }

    /**
     * The one line the settings page shows after a mutation.
     *
     * Every answer carries enough to say what actually moved, because a count on
     * its own would hide the part worth reading: that the provider retired a
     * model, and that a row is about to disappear from the picker.
     *
     * @param path - the route that was called.
     * @param payload - the answer the host gave.
     * @returns `{ kind, text }`, where kind picks the colour.
     */
    function noticeFor(path, payload) {
      if (path === '/apply-models') {
        if (payload.ok === false) return { kind: 'bad', text: `Список моделей не записан: ${payload.error ?? 'причина не сообщена'}` }
        if (payload.upToDate === true) return { kind: 'ok', text: `Список моделей уже актуален: ${payload.count ?? 0}.` }
        const plan = payload.plan ?? {}
        return {
          kind: 'ok',
          text: `Записано ${payload.count} моделей. Новые: ${listOf(plan.added)}. Убраны: ${listOf(plan.removed)}. Изменены: ${changedList(plan.changed)}.`,
        }
      }
      if (path === '/revert-models') {
        if (payload.ok === false) return { kind: 'bad', text: `Откат не удался: ${payload.error ?? 'причина не сообщена'}` }
        const when = payload.from === null || payload.from === undefined ? 'предыдущей записи' : new Date(payload.from).toLocaleString()
        return { kind: 'ok', text: `Список моделей откачен к состоянию на ${when}.` }
      }
      if (path === '/refresh') {
        if (!(payload.count > 0)) {
          return {
            kind: 'bad',
            text: `Каталог не получен${payload.error === undefined || payload.error === null ? '' : `: ${payload.error}`}`,
          }
        }
        const base = `Каталог обновлён: ${payload.count} моделей, иконок в кэше ${payload.logos}.`
        const sync = payload.modelSync
        if (sync === undefined) return { kind: 'ok', text: base }
        if (sync.applied === true) return { kind: 'ok', text: `${base} Список моделей записан: ${sync.count}.` }
        if (sync.ok === false) return { kind: 'warn', text: `${base} Список моделей не записан: ${sync.error}` }
        if (sync.plan?.upToDate === true) return { kind: 'ok', text: `${base} Список моделей уже актуален.` }
        return {
          kind: 'warn',
          text: `${base} Список моделей устарел — новые: ${listOf(sync.plan?.added)}, убраны: ${listOf(sync.plan?.removed)}.`,
        }
      }
      return { kind: 'ok', text: 'Сохранено.' }
    }

    /**
     * The line the keys section shows after a mutation.
     *
     * Named for what actually moved rather than a bare "saved", because the part
     * worth reading differs per action: an add creates a route, a replace takes
     * effect only from the next request, and a delete moves every chat that used
     * the key back onto the primary one.
     *
     * @param body - the action that was posted.
     * @param payload - the host's answer, which already carries the fresh list.
     * @returns `{ kind, text }`, where kind picks the colour.
     */
    function keysNotice(body, payload) {
      const action = body?.action
      if (action === 'add') {
        const added = state.keys.find(key => key.id === payload.added)
        const name = keyName(added ?? { label: payload.added })
        return { kind: 'ok', text: `Ключ «${name}» добавлен, маршрут ${added?.route ?? '—'}.` }
      }
      if (action === 'set') return { kind: 'ok', text: 'Значение заменено; действует со следующего запроса.' }
      if (action === 'rename') return { kind: 'ok', text: 'Название сохранено.' }
      if (action === 'default') {
        const chosen = state.keys.find(key => key.id === (payload.defaultKeyId ?? body.id))
        return { kind: 'ok', text: `Ключ по умолчанию — «${keyName(chosen ?? { label: body.id })}».` }
      }
      if (action === 'remove') {
        const left = state.keys.length
        return {
          kind: 'ok',
          text: `Ключ удалён, его маршрут убран из конфигурации. Чаты, которые его выбрали, отправляют запросы основным; ключей осталось ${left}.`,
        }
      }
      if (action === 'repair') {
        const left = payload?.routes?.missing ?? []
        return left.length === 0
          ? { kind: 'ok', text: 'Маршруты ключей записаны в конфигурацию.' }
          : { kind: 'warn', text: `Не все маршруты удалось записать: ${listOf(left)}.` }
      }
      if (action === 'test') {
        const test = payload?.test
        if (test?.ok !== true) return { kind: 'bad', text: `Ключ не ответил: ${test?.error ?? 'причина не сообщена'}` }
        return { kind: 'ok', text: `Ключ отвечает: HTTP ${test.status ?? 200}, моделей ${test.models ?? 0}.` }
      }
      return { kind: 'ok', text: 'Сохранено.' }
    }

    /**
     * Copy one string, on whichever route the page allows.
     *
     * The async clipboard API needs a secure context and a user gesture; a
     * loopback page normally has both, but a deployment that serves this GUI over
     * a plain host or inside a frame may not, and a copy button that silently does
     * nothing is worse than one that says it failed.
     *
     * @param text - what to copy.
     * @returns a promise of true when the clipboard really holds it.
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
          await navigator.clipboard.writeText(String(text))
          return true
        }
      } catch {
        // Refused or unavailable: fall through to the older route.
      }
      try {
        const area = document.createElement('textarea')
        area.value = String(text)
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body?.appendChild(area)
        area.select()
        const copied = document.execCommand?.('copy') === true
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /** A small button that copies one string and reports whether it worked. */
    function CopyButton(props) {
      const [done, setDone] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      return h('button', {
        type: 'button',
        onClick: () => {
          void copyText(props.text).then(ok => {
            setDone(ok)
            setFailed(!ok)
            setTimeout(() => { setDone(false); setFailed(false) }, 1800)
          })
        },
        style: {
          font,
          fontSize: '11px',
          padding: '1px 7px',
          flex: 'none',
          cursor: 'pointer',
          borderRadius: '5px',
          color: done ? C.ok : failed ? C.bad : C.labelSecondary,
          background: 'transparent',
          border: `1px solid ${C.borderStrong}`,
        },
      }, done ? (props.doneLabel ?? 'скопировано') : failed ? 'не вышло' : (props.label ?? 'копировать'))
    }

    /** One clickable outbound link. */
    function Link(props) {
      return h('a', {
        href: props.href,
        target: '_blank',
        rel: 'noreferrer noopener',
        style: {
          color: C.brand,
          textDecoration: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '12px',
          wordBreak: 'break-all',
        },
      }, props.children ?? props.href)
    }

    /** A labelled row holding one outbound link. */
    function LinkRow(props) {
      return h('div', { style: { display: 'flex', gap: '8px', marginBottom: '3px', alignItems: 'baseline' } },
        h('span', { style: { color: C.labelSecondary, minWidth: '150px', flex: 'none' } }, props.name),
        h(Link, { href: props.href }, props.children ?? props.href))
    }

    /** A labelled row holding one path on this machine, with a copy button. */
    function PathRow(props) {
      const text = String(props.children ?? '')
      return h('div', { style: { display: 'flex', gap: '8px', marginBottom: '3px', alignItems: 'baseline' } },
        h('span', { style: { color: C.labelSecondary, minWidth: '150px', flex: 'none' } }, props.name),
        h('span', {
          style: {
            color: C.label,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '12px',
            wordBreak: 'break-all',
            flex: '1 1 auto',
          },
        }, text === '' ? '—' : text),
        text === '' ? null : h(CopyButton, { text }))
    }

    /**
     * One text field, saved when it loses focus or on Enter.
     *
     * Saving on blur rather than on every keystroke matters here: each of these
     * fields names something the host half resolves — an origin it fetches, a
     * loader row it writes — so a half-typed value is a failed lookup rather than
     * a draft. Escape puts the previous value back.
     */
    function TextField(props) {
      const [value, setValue] = React.useState(props.value ?? '')
      const [focused, setFocused] = React.useState(false)
      // Follow the host's answer whenever nobody is typing in the field, so a
      // change made elsewhere does not leave a stale value on screen.
      React.useEffect(() => {
        if (!focused) setValue(props.value ?? '')
      }, [props.value, focused])
      const commit = () => {
        setFocused(false)
        const next = String(value).trim()
        if (next !== '' && next !== String(props.value ?? '')) props.onSave(next)
      }
      return h('input', {
        type: props.type ?? 'text',
        value,
        spellCheck: false,
        ...(props.min === undefined ? {} : { min: props.min }),
        ...(props.max === undefined ? {} : { max: props.max }),
        ...(props.step === undefined ? {} : { step: props.step }),
        onChange: event => setValue(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: commit,
        onKeyDown: event => {
          if (event.key === 'Enter') event.target.blur()
          if (event.key === 'Escape') { setValue(props.value ?? ''); event.target.blur() }
        },
        style: {
          font,
          fontSize: '12.5px',
          color: C.label,
          background: focused ? C.surface : 'transparent',
          border: `1px solid ${focused ? C.brand : C.borderStrong}`,
          borderRadius: '6px',
          padding: '4px 8px',
          width: props.width ?? '280px',
          maxWidth: '100%',
          fontFamily: props.mono === false ? undefined : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
      })
    }

    /** One labelled row holding a field. */
    function FieldRow(props) {
      return h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { color: C.labelSecondary, minWidth: '150px', flex: 'none', fontSize: '12.5px' } }, props.name),
        props.children,
        props.hint === undefined
          ? null
          : h('span', { style: { color: C.labelSecondary, fontSize: '11.5px' } }, props.hint))
    }

    /**
     * The generated patch row, fetched on demand.
     *
     * The same bytes the automatic write produces, so whoever would rather edit
     * `cordis.patch.yml` by hand is not transcribing a summary of what the plugin
     * does — and can diff the block against the row already there before touching
     * anything.
     */
    function YamlPanel(props) {
      const [text, setText] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)

      const load = async () => {
        setBusy(true)
        setError(undefined)
        try {
          const response = await fetch(`${API}/models.yaml?cached=${props.cached === true ? '1' : '0'}`, {
            headers: { accept: 'text/yaml' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setText(await response.text())
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { marginBottom: '18px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(Button, { onClick: () => { void load() }, disabled: busy }, busy ? 'Чтение…' : text === undefined ? 'Показать блок для ручной правки' : 'Перечитать блок'),
          text === undefined ? null : h(CopyButton, { text, label: 'копировать YAML', doneLabel: 'YAML скопирован' }),
          error === undefined ? null : h('span', { style: { color: C.bad, fontSize: '12.5px' } }, `Не удалось прочитать: ${error}`)),
        text === undefined
          ? null
          : h('pre', {
              style: {
                margin: '8px 0 0',
                padding: '10px 12px',
                maxHeight: '320px',
                overflow: 'auto',
                fontSize: '11.5px',
                lineHeight: 1.5,
                color: C.label,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: '8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                whiteSpace: 'pre',
              },
            }, text))
    }

    /**
     * The key-value field of the add and replace forms.
     *
     * Deliberately not `TextField`: that one commits on blur, and a half-typed key
     * must never be posted. This one commits on Enter or on its form's own button
     * and hands the value up as an argument, so it lives in React state for
     * exactly as long as the field is open — never in an attribute, a `title`, a
     * dataset, storage or a URL. `autoComplete="off"` is there because a browser
     * that offers to remember this would be remembering a credential in a place
     * the user did not choose.
     */
    function SecretField(props) {
      const [shown, setShown] = React.useState(false)
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: '1 1 220px', minWidth: 0 },
      },
        h('input', {
          type: shown ? 'text' : 'password',
          value: props.value,
          placeholder: props.placeholder ?? 'значение ключа',
          spellCheck: false,
          autoComplete: 'off',
          'aria-label': props.label ?? 'значение ключа',
          onChange: event => props.onChange(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') { event.preventDefault(); props.onSubmit?.() }
            if (event.key === 'Escape') props.onCancel?.()
          },
          style: {
            font,
            fontSize: '12.5px',
            color: C.label,
            background: 'transparent',
            border: `1px solid ${C.borderStrong}`,
            borderRadius: '6px',
            padding: '4px 8px',
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            fontFamily: MONO,
          },
        }),
        h(Button, {
          variant: 'small',
          onClick: () => setShown(!shown),
          title: shown ? 'Скрыть значение' : 'Показать значение',
        }, shown ? 'скрыть' : 'показать'))
    }

    /**
     * The «+» form: an optional label and a value.
     *
     * One component for both surfaces, because the settings page and the
     * composer's popup must not drift in what they post: the label is optional on
     * both, the value leaves in one JSON body on both, and the field is cleared on
     * both — including when the host refused, since keeping a secret on screen
     * after a failure is the worse of the two trades.
     */
    function KeyForm(props) {
      const [label, setLabel] = React.useState('')
      const [value, setValue] = React.useState('')
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const popup = props.variant === 'popup'

      const submit = async () => {
        if (busy) return
        const next = String(value).trim()
        const invalid = keyFormError(next)
        if (invalid !== undefined) { setError(invalid); return }
        setError(undefined)
        setBusy(true)
        const answer = await props.onSubmit(next, String(label).trim())
        setBusy(false)
        setValue('')
        if (answer === null) setError(state.keysError ?? 'Ключ не записан.')
        else if (answer.ok === false) setError(String(answer.error ?? 'Ключ не записан.'))
        else props.onDone?.()
      }

      const inputStyle = {
        font,
        fontSize: '12.5px',
        color: C.label,
        background: 'transparent',
        border: `1px solid ${C.borderStrong}`,
        borderRadius: '6px',
        padding: '4px 8px',
        width: popup ? '100%' : '220px',
        maxWidth: '100%',
        boxSizing: 'border-box',
      }

      const fieldStyle = popup
        ? { display: 'flex', flexDirection: 'column', gap: '6px' }
        : { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' }
      const nameStyle = popup
        ? { color: C.labelSecondary, fontSize: '11.5px' }
        : { color: C.labelSecondary, minWidth: '150px', flex: 'none', fontSize: '12.5px' }

      return h('div', {
        style: popup
          ? { display: 'flex', flexDirection: 'column', gap: '6px' }
          : { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' },
      },
        props.hideLabel === true
          ? null
          : h('div', { style: fieldStyle },
              h('span', { style: nameStyle }, 'Название'),
              h('input', {
                type: 'text',
                value: label,
                spellCheck: false,
                placeholder: props.labelPlaceholder ?? 'необязательно',
                'aria-label': 'название ключа',
                onChange: event => setLabel(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); void submit() } },
                style: inputStyle,
              })),
        h('div', { style: fieldStyle },
          h('span', { style: nameStyle }, props.valueName ?? 'Значение ключа'),
          h(SecretField, {
            value,
            placeholder: props.placeholder,
            onChange: setValue,
            onSubmit: () => { void submit() },
            onCancel: popup ? props.onCancel : undefined,
          })),
        error === undefined ? null : h('div', { style: { color: C.bad, fontSize: '11.5px' } }, error),
        h('div', {
          style: { display: 'flex', gap: '6px', alignItems: 'center', ...(popup ? { marginTop: '2px' } : {}) },
        },
          h(Button, { variant: popup ? undefined : 'primary', disabled: busy, onClick: () => { void submit() } },
            busy ? (props.busyLabel ?? 'Запись…') : (props.submitLabel ?? 'Добавить')),
          h(Button, { variant: 'small', disabled: busy, onClick: props.onCancel }, 'Отмена')))
    }

    /**
     * One key on the settings page.
     *
     * Everything about a key that is safe to show, and everything the user can do
     * to it: rename on blur, replace the value, make it the default, check that it
     * still answers, and delete it. The primary key explains why it cannot be
     * deleted instead of offering a button that refuses — a dead control reads as a
     * bug, a sentence reads as a rule.
     */
    function KeyRow(props) {
      const key = props.item
      const [replacing, setReplacing] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)
      const [test, setTest] = React.useState(undefined)
      const [testing, setTesting] = React.useState(false)
      // A check really calls the provider's `/models` with that key, so it can
      // take seconds: the whole row locks for the duration, not just the button,
      // because a rename that lands mid-check would report on the wrong key.
      const busy = props.busy === true || testing
      const primary = key.primary === true
      const isDefault = key.id === props.defaultKeyId

      /** One mutation on this row, through the section so the notice stays in one place. */
      const run = body => props.onMutate(body)

      const onTest = async () => {
        setTesting(true)
        setTest(undefined)
        const answer = await run({ action: 'test', id: key.id })
        setTesting(false)
        setTest(answer?.test ?? null)
      }

      const badge = {
        fontSize: '10.5px',
        padding: '1px 6px',
        borderRadius: '99px',
        color: C.labelSecondary,
        border: `1px solid ${C.border}`,
      }

      return h('div', { style: { borderTop: `1px solid ${C.border}`, padding: '10px 0' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(TextField, {
            value: key.label ?? '',
            width: '170px',
            mono: false,
            onSave: label => { void run({ action: 'rename', id: key.id, label }) },
          }),
          primary ? h('span', { style: badge }, 'основной') : null,
          isDefault ? h('span', { style: badge }, 'по умолчанию') : null,
          h('span', { style: { color: C.label, fontSize: '12px', fontFamily: MONO } }, key.masked ?? '—'),
          key.present === false
            ? h('span', { style: { ...badge, color: C.warn, borderColor: C.warn } }, 'значения нет')
            : null,
          // A key whose route is not in the profile cannot carry a request, and
          // saying so here is what makes the repair button below legible.
          key.installed === false
            ? h('span', { style: { ...badge, color: C.warn, borderColor: C.warn } }, 'маршрут не записан')
            : null),
        h('div', {
          style: { color: C.labelSecondary, fontSize: '11.5px', margin: '4px 0 7px', fontFamily: MONO, wordBreak: 'break-all' },
        }, `${key.ref ?? '—'} · маршрут ${key.route ?? '—'} · моделей: ${key.models ?? 0} · чатов: ${key.sessions ?? 0}`),

        replacing
          ? h(KeyForm, {
              hideLabel: true,
              valueName: 'Новое значение',
              placeholder: 'новое значение ключа',
              submitLabel: 'Записать',
              busyLabel: 'Запись…',
              onCancel: () => setReplacing(false),
              onDone: () => setReplacing(false),
              onSubmit: async value => run({ action: 'set', id: key.id, key: value }),
            })
          : null,

        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h(Button, {
            variant: 'small',
            disabled: busy || props.readOnly === true,
            onClick: () => { setReplacing(!replacing); setConfirming(false) },
          }, replacing ? 'Скрыть форму' : 'Заменить значение'),
          isDefault
            ? null
            : h(Button, {
                variant: 'small',
                disabled: busy,
                onClick: () => { void run({ action: 'default', id: key.id }) },
              }, 'По умолчанию'),
          h(Button, { variant: 'small', disabled: busy || testing, onClick: () => { void onTest() } },
            testing ? 'Проверка…' : 'Проверить'),
          primary
            ? h('span', { style: { color: C.labelSecondary, fontSize: '11.5px' } },
                'Основной ключ не удаляется: он владеет маршрутом профиля.')
            : confirming
              ? h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
                  h(Button, {
                    variant: 'small',
                    disabled: busy,
                    onClick: () => { setConfirming(false); void run({ action: 'remove', id: key.id }) },
                  }, 'Удалить навсегда'),
                  h(Button, { variant: 'small', disabled: busy, onClick: () => setConfirming(false) }, 'Отмена'))
              : h(Button, { variant: 'small', disabled: busy, onClick: () => setConfirming(true) }, 'Удалить')),

        test === undefined
          ? null
          : h('div', {
              style: {
                marginTop: '6px',
                fontSize: '11.5px',
                color: test === null || test.ok !== true ? C.bad : C.ok,
              },
            }, test === null
              ? 'Хост не ответил результатом проверки.'
              : test.ok === true
                ? `Ключ отвечает: HTTP ${test.status ?? 200}, моделей ${test.models ?? 0}.`
                : `Ключ не ответил: ${test.error ?? `HTTP ${test.status ?? '—'}`}`))
    }

    /**
     * The settings page's «API-ключи» section.
     *
     * Reads `/keys` itself rather than riding the decorator's `reload()`: the
     * settings page has no session to ask about, and `/keys` is the route that
     * reports `editor` and `defaultKeyId`, which is what decides whether adding a
     * key is offered at all and why.
     */
    function KeysSection() {
      const [data, setData] = React.useState(undefined)
      const [adding, setAdding] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(undefined)

      // Forced: opening the settings page is deliberate, and this is the route
      // that reports `editor`, `defaultKeyId`, `maxKeys` and the file paths, which
      // a session-scoped answer does not carry.
      React.useEffect(() => { void loadKeys(null, { force: true }).then(answer => setData(answer)) }, [])

      // A key added from the composer's popup lands in the shared state; this
      // section repaints from it instead of asking the host a second time.
      React.useEffect(() => {
        const onChanged = () => { if (state.keysPayload !== undefined) setData(state.keysPayload) }
        window.addEventListener(CHANGED, onChanged)
        return () => window.removeEventListener(CHANGED, onChanged)
      }, [])

      const mutate = async body => {
        setBusy(String(body.action))
        setNotice(undefined)
        const answer = await postKeys(body)
        setBusy('')
        setData(state.keysPayload ?? answer)
        setNotice(answer === null
          ? { kind: 'bad', text: state.keysError ?? 'Запрос не прошёл.' }
          : answer.ok === false
            ? { kind: 'bad', text: String(answer.error ?? 'Отказано.') }
            : keysNotice(body, answer))
        announce(true)
        return answer
      }

      /**
       * The ring's own master switch, which the host keeps in its config file.
       *
       * Its own POST rather than the page's `post` helper, so the answer lands in
       * this section's notice line: a switch inside «API-ключи» that reported
       * "Сохранено." next to «Обновить каталог и иконки» would read as if the
       * catalog had been touched.
       *
       * @param checked - true to let chats pick their own key.
       */
      const toggleRing = async checked => {
        setBusy('ring')
        setNotice(undefined)
        try {
          const response = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ apiKeys: checked }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          // Forced: the switch was just written, so the answer this half is holding
          // is by definition the one from before it.
          await loadKeys(null, { force: true })
          setData(state.keysPayload)
          setNotice(checked
            ? { kind: 'ok', text: 'Ключи включены: чаты могут отправлять запросы каждый своим.' }
            : { kind: 'warn', text: 'Ключи выключены: маршруты остались в конфигурации, но запросы идут основным маршрутом.' })
          announce(true)
        } catch (error) {
          setNotice({ kind: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      // The flags come from the shared state rather than from this section's own
      // copy of the answer, because a failed read leaves no payload to read them
      // from — and "the host half is out of date" is exactly the case that has to
      // still render.
      const missing = []
      if (state.keysEnabled === false) missing.push('возможность выключена настройкой плагина')
      if (state.keysCredentials === false) missing.push('хост не отдаёт сервис credentials — значение ключа некуда записать')
      if (state.keysEditor === false) missing.push('хост не отдаёт configEditor — маршрут для нового ключа добавить нельзя')
      const outdated = state.keysAvailable === false
      // A host half without these routes cannot take a new key either, so an
      // out-of-date answer disables the form the same way a missing service does.
      const readOnly = missing.length > 0 || outdated
      const loaded = data ?? state.keysPayload
      const keys = Array.isArray(loaded?.keys) ? loaded.keys : []
      const defaultKeyId = loaded?.defaultKeyId ?? state.defaultKeyId
      const maxKeys = Number.isFinite(state.maxKeys) ? state.maxKeys : 12
      const atLimit = keys.length >= maxKeys
      const routesMissing = loaded?.routes?.missing ?? state.routes.missing ?? []
      const routesStale = loaded?.routes?.stale ?? state.routes.stale ?? []
      const routing = loaded?.routing ?? state.routing
      const fallback = loaded?.fallback ?? state.fallback
      const keyPaths = loaded?.paths ?? state.keysPaths

      return h('div', {
        style: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', background: C.surface },
      },
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap' },
        },
          h('span', { style: { color: C.labelSecondary, fontSize: '11.5px' } }, 'API-ключи'),
          h(Button, {
            variant: 'small',
            title: atLimit ? `Больше ${maxKeys} ключей маршрут не держит` : 'Добавить ключ',
            disabled: adding || readOnly || atLimit,
            onClick: () => setAdding(true),
          }, '+'),
          h('span', { style: { color: C.labelSecondary, fontSize: '11.5px' } }, `${keys.length} из ${maxKeys}`),
          notice === undefined
            ? null
            : h('span', {
                style: {
                  fontSize: '11.5px',
                  color: notice.kind === 'bad' ? C.bad : notice.kind === 'warn' ? C.warn : C.ok,
                },
              }, notice.text)),

        h('label', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
            cursor: outdated ? 'default' : 'pointer',
          },
        },
          h('input', {
            type: 'checkbox',
            disabled: outdated,
            checked: state.keysEnabled !== false,
            onChange: event => { void toggleRing(event.target.checked) },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Ключи на несколько чатов')),

        h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '8px', lineHeight: 1.6 } },
          'Ключ хранится в хранилище учётных данных профиля, а здесь остаются только его название, маска и маршрут. '
          + 'Выбранный ключ действует на один чат и переживает перезапуск; учётная запись DeepSeek не затрагивается — '
          + 'подменяются только маршруты этого плагина.'),

        // The one warning that must not be missed: a request that could not use
        // the key its chat picked. It still went through on the base route, so
        // nothing failed visibly — which is exactly why it is written down here.
        fallback === null || fallback === undefined
          ? null
          : h('div', {
              style: {
                color: C.warn,
                fontSize: '11.5px',
                lineHeight: 1.6,
                marginBottom: '8px',
                border: `1px solid ${C.warn}`,
                borderRadius: '6px',
                padding: '6px 8px',
              },
            },
            `Последний запрос не смог уйти своим ключом: ${fallback.reason ?? 'причина не сообщена'}. `
            + `Чат ${fallback.sessionId ?? '—'}, ключ «${fallback.keyLabel ?? fallback.keyId ?? '—'}», `
            + `маршрут ${fallback.route ?? '—'}, модель ${fallback.model ?? '—'}. `
            + 'Запрос прошёл через основной маршрут, ответ получен — но не тем ключом.'),

        loaded === undefined && !outdated
          ? h('div', { style: { color: C.labelSecondary, fontSize: '12px' } }, 'Чтение…')
          : null,

        outdated
          ? h('div', { style: { color: C.warn, fontSize: '12px', lineHeight: 1.6 } },
              `Хост-половина плагина устарела: маршрут /keys не отвечает (${state.keysError ?? '404'}). `
              + 'Обновите пакет dsh-rustvy — список ключей появится здесь без правки конфигов руками.')
          : null,

        readOnly && !outdated
          ? h('div', { style: { color: C.warn, fontSize: '12px', lineHeight: 1.6 } },
              `Добавление ключа недоступно: ${missing.join('; ')}.`)
          : null,

        atLimit && !readOnly
          ? h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '8px' } },
              `Достигнут предел: ${maxKeys} ключей. Удалите один, чтобы добавить другой.`)
          : null,

        adding && !readOnly && !atLimit
          ? h(KeyForm, {
              onCancel: () => setAdding(false),
              onDone: () => setAdding(false),
              onSubmit: async (value, label) => mutate({ action: 'add', key: value, label }),
            })
          : null,

        ...keys.map(record => h(KeyRow, {
          // `key` is React's own identity prop, so the record travels as `item`:
          // a spread of the record over the row would overwrite the identity with
          // a whole object and every row would remount on every repaint.
          key: record.id,
          item: record,
          defaultKeyId,
          busy: busy !== '',
          readOnly,
          onMutate: mutate,
        })),

        outdated
          ? null
          : h('div', { style: { marginTop: '10px' } },
              h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', margin: '0 0 6px' } }, 'Маршруты ключей'),
              h(Row, { name: 'строка профиля' }, `${loaded?.entryId ?? '—'}${loaded?.packageName === undefined ? '' : ` (${loaded.packageName})`}`),
              h(Row, { name: 'адрес списка' }, loaded?.modelsUrl ?? state.modelsUrl ?? '—'),
              h(Row, {
                name: 'запросов через подмену',
                // `seen === 0` after real traffic is the one number worth reading
                // here: it means the harness never dispatched the waterfall the
                // substitution hangs on, so no chat is using its key at all.
                tone: routing?.seen > 0 && routing?.applied === 0 ? C.warn : undefined,
              }, `${routing?.applied ?? 0} из ${routing?.seen ?? 0}`),
              h(Row, { name: 'чатов со своим ключом' }, String(loaded?.picks ?? state.picks ?? 0)),
              routesMissing.length === 0
                ? null
                : h(Row, { name: 'маршруты не записаны', tone: C.warn }, listOf(routesMissing)),
              routesStale.length === 0
                ? null
                : h(Row, { name: 'список моделей устарел', tone: C.warn },
                    `${listOf(routesStale)} — нажмите «Записать список моделей» выше`),
              h(PathRow, { name: 'метаданные ключей' }, keyPaths?.keys ?? ''),
              h(PathRow, { name: 'выбор чатов' }, keyPaths?.picks ?? ''),
              routesMissing.length === 0
                ? null
                : h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
                    h(Button, {
                      variant: 'primary',
                      disabled: busy !== '' || state.keysEditor === false,
                      onClick: () => { void mutate({ action: 'repair' }) },
                    }, busy === 'repair' ? 'Запись…' : 'Починить маршруты'),
                    h('span', { style: { color: C.labelSecondary, fontSize: '11.5px' } },
                      'Дописывает в конфигурацию маршруты ключей, которых в ней нет.'))))
    }

    /** The tick that marks the key a chat sends with. */
    const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>'

    /** The switch's own glyph: a key, drawn in `currentColor` like the marks. */
    const KEY_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="8" r="2.6"/>'
      + '<path d="M7.6 8H14M11.6 8v2.4M13.6 8v1.7"/></svg>'

    /**
     * Re-render when the shared state moves.
     *
     * The switch has no props to follow: what it shows lives in the state it shares
     * with the settings page, so the only thing React can hold for it is a counter
     * that the change event increments.
     *
     * @returns a function that forces the same re-render, for a caller that has
     *   just refreshed the state itself and cannot wait for an event.
     */
    function useSharedState() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const onChanged = () => bump(value => value + 1)
        window.addEventListener(CHANGED, onChanged)
        return () => window.removeEventListener(CHANGED, onChanged)
      }, [])
      return () => bump(value => value + 1)
    }

    /**
     * One inline SVG glyph, painted in `currentColor`.
     *
     * Markup rather than a React tree, because a two-node icon written as elements
     * is four lines of `h()` that say less than the path does, and `currentColor`
     * is what keeps it correct in both palettes and in every row state.
     */
    function Glyph(props) {
      return h('span', {
        className: `dmi-glyph ${props.className ?? ''}`.trim(),
        'aria-hidden': 'true',
        ...(props.style === undefined ? {} : { style: props.style }),
        dangerouslySetInnerHTML: { __html: props.svg },
      })
    }

    /** The tick on the row this chat sends with. */
    function Check(props) {
      return h(Glyph, {
        className: 'dmi-key-check',
        svg: CHECK_SVG,
        // Hidden rather than absent, so every label in the list starts on the same
        // edge and the column reads as a list rather than a ragged staircase.
        style: { visibility: props.on === true ? 'visible' : 'hidden' },
      })
    }

    /** One row of the switch's popup: a tick, a label, an optional note. */
    function KeyPopupRow(props) {
      return h('button', {
        type: 'button',
        className: 'dmi-keypop-row',
        disabled: props.disabled === true,
        'data-dmi-active': props.active === true ? '1' : '0',
        ...(props.disabled === true ? { 'data-dmi-disabled': '1' } : {}),
        ...(props.title === undefined ? {} : { title: props.title }),
        onClick: props.onClick,
      },
        h(Check, { on: props.active === true }),
        h('span', { className: 'dmi-key-name' }, props.children),
        props.note === undefined ? null : h('span', { className: 'dmi-key-note' }, props.note))
    }

    /**
     * The composer's key selector — the one place a conversation offers the choice.
     *
     * It sits in the tool row right after the permission/mode dropdown and answers
     * a question that belongs to the chat rather than to the model: which key this
     * conversation sends with. The model picker stays about models.
     *
     * It renders nothing until it holds a `sessionId`: the choice is per chat, and a
     * switch that posted for the wrong session is worse than no switch. The id it
     * was given is published to the shared state, which is what a background refresh
     * and `chooseKey`'s default both read.
     */
    function KeyControl(props) {
      const [open, setOpen] = React.useState(false)
      const [adding, setAdding] = React.useState(false)
      const [ready, setReady] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const repaint = useSharedState()

      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null

      React.useEffect(() => {
        if (sessionId === null) return undefined
        publishSession(sessionId)
        // Forced: mounting is deliberate, and this chat's own pick is the one thing
        // the shared state may still be holding for another conversation.
        void loadKeys(sessionId, { force: true }).then(answer => setReady(answer !== null))
        return undefined
      }, [sessionId])

      // The list is re-read on open, which is what makes a key added in another
      // window — or removed by the host — show up without a reload of the page.
      // Forced for the same reason, and it announces nothing, so it repaints this
      // control itself.
      const toggle = () => {
        const next = !open
        setOpen(next)
        setAdding(false)
        setError(undefined)
        if (next && sessionId !== null) void loadKeys(sessionId, { force: true }).then(() => repaint())
      }

      // A click anywhere outside this control closes the popup. Matched by
      // attribute rather than by element identity so the popup's own rows, its form
      // and the button all count as "inside" without a ref to compare against.
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = event => {
          const target = event?.target
          if (typeof target?.closest !== 'function') return
          if (target.closest('[data-dmi-keyui]') !== null) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [open])

      if (sessionId === null) return null
      // One key is no choice, and a host half without the routes has nothing to
      // offer: in both cases the composer stays exactly as it was.
      if (state.keysAvailable !== true || (ready !== true && state.keysLoadedAt === null)) return null
      if (state.keys.length < 2) return null

      const active = activeKey()
      const chosen = state.keyId === null ? null : state.keys.find(key => key.id === state.keyId) ?? null
      const label = chosen === null ? 'ключ по умолчанию' : keyName(chosen)
      const locked = state.keysEnabled === false || state.keysCredentials === false || state.keysEditor === false
      const atLimit = state.keys.length >= (state.maxKeys ?? Number.POSITIVE_INFINITY)

      /** One choice, posted for this chat and only then shown. */
      const pick = async keyId => {
        setError(undefined)
        setOpen(false)
        const answer = await chooseKey(keyId, sessionId)
        if (answer === null) {
          setError(state.keysError ?? 'Выбор не сохранён.')
          setOpen(true)
        }
      }

      /**
       * The popup's «+»: the same POST the settings page makes, and then the new
       * key is chosen for this chat — adding a key from inside a conversation is
       * done in order to send with it, and the popup closes on success, so leaving
       * the choice for later would hide what just happened.
       */
      const addKey = async (value, keyLabel) => {
        const answer = await postKeys({ action: 'add', key: value, label: keyLabel })
        announce(true)
        if (answer?.ok !== false && typeof answer?.added === 'string') await chooseKey(answer.added, sessionId)
        return answer
      }

      return h('span', { className: 'dmi-keywrap', 'data-dmi-keyui': '' },
        h('button', {
          type: 'button',
          className: 'dmi-keybtn',
          'data-dmi-keyui': '',
          'data-dmi-open': open ? '1' : '0',
          'aria-haspopup': 'true',
          'aria-expanded': open ? 'true' : 'false',
          title: `API-ключ этого чата: ${label}`,
          onClick: toggle,
        },
          h(Glyph, { svg: KEY_ICON_SVG }),
          h('span', { className: 'dmi-keybtn-label' }, label)),

        open
          ? h('span', { className: 'dmi-keypop', role: 'menu', 'data-dmi-keyui': '' },
              // Exactly one tick in this popup: a key row is ticked when this chat
              // explicitly picked it, and «По умолчанию» is ticked when it did not.
              // Ticking the default key's row *and* the «По умолчанию» row would be
              // two marks for one state, and the default key already carries its own
              // «по умолчанию» note.
              ...state.keys.map(key => h(KeyPopupRow, {
                key: key.id,
                active: chosen !== null && key.id === chosen.id,
                note: key.primary === true
                  ? 'основной'
                  : key.id === state.defaultKeyId
                    ? 'по умолчанию'
                    : undefined,
                onClick: () => { void pick(key.id) },
              }, keyName(key))),

              h('span', { className: 'dmi-key-sep' }),
              h(KeyPopupRow, {
                active: chosen === null,
                title: active === null
                  ? 'Этот чат отправляет запросы ключом по умолчанию'
                  : `Этот чат отправляет запросы ключом «${keyName(active)}», как новые чаты`,
                onClick: () => { void pick(null) },
              }, 'По умолчанию'),

              h('span', { className: 'dmi-key-sep' }),
              adding
                ? h('span', { className: 'dmi-keypop-form', 'data-dmi-keyui': '' },
                    h(KeyForm, {
                      variant: 'popup',
                      onCancel: () => setAdding(false),
                      onDone: () => { setAdding(false); setOpen(false) },
                      onSubmit: addKey,
                    }))
                : h(KeyPopupRow, {
                    disabled: locked || atLimit,
                    title: locked
                      ? 'Добавление ключа недоступно: см. раздел «API-ключи» в настройках'
                      : atLimit
                        ? `Больше ${state.maxKeys} ключей маршрут не держит`
                        : undefined,
                    onClick: () => { setError(undefined); setAdding(true) },
                  }, '+ Добавить ключ'),

              error === undefined ? null : h('span', { className: 'dmi-keypop-err' }, error))
          : null)
    }

    /**
     * A collector timestamp in the words its own monitor page uses.
     *
     * The ladder is theirs rather than this half's invention, so a moment read here
     * and the same moment read on the web monitor do not disagree about how long ago
     * something happened.
     *
     * @param at - epoch ms, or anything that is not a number.
     * @param now - the moment to measure from; the current one by default.
     * @returns «только что», «N мин назад», «N ч назад», «N дн назад» or «—».
     */
    function relativeTime(at, now = Date.now()) {
      if (!Number.isFinite(at)) return '—'
      const minutes = Math.floor((now - at) / 60_000)
      if (minutes < 1) return 'только что'
      if (minutes < 60) return `${minutes} мин назад`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} ч назад`
      return `${Math.floor(hours / 24)} дн назад`
    }

    /**
     * One model's line in the uptime box.
     *
     * The dot, the status word and the bar all take the same colour, because a row that
     * said "Degraded" in amber next to a green bar would be two answers to one
     * question. Every number is the collector's own, and one the wire left out is drawn
     * as «—» rather than as a zero.
     *
     * @param props - `{ model }`, one entry of the collector's `models`.
     */
    function UptimeRow(props) {
      const model = typeof props.model === 'object' && props.model !== null ? props.model : {}
      const status = typeof model.status === 'string' ? model.status : 'up'
      const tone = statusOf(status)
      const errors = Number.isFinite(model.errors) ? model.errors : null
      const uptime = Number.isFinite(model.uptime) ? model.uptime : null
      const buckets = Array.isArray(model.buckets) ? model.buckets : []
      const counts = buckets.map(bucket => (Number.isFinite(bucket?.count) ? bucket.count : 0))
      const peak = Math.max(1, ...counts)
      const events = Array.isArray(model.events) ? model.events : []
      // Forty-eight empty bars say nothing a word does not say better, and "no errors
      // in this window" is the answer the collector gives most days.
      const hasErrors = counts.some(count => count > 0) || events.length > 0
      const last = typeof model.lastError === 'object' && model.lastError !== null ? model.lastError : null
      return h('div', { className: 'dmi-up-row', 'data-dmi-status': status, style: { marginBottom: '9px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
          h('span', {
            className: 'dmi-up-dot',
            'data-dmi-status': status,
            style: { width: '8px', height: '8px', minWidth: '8px', borderRadius: '50%', background: tone.color, flex: 'none' },
          }),
          h('span', { style: { fontSize: '12.5px', flex: '1 1 auto', minWidth: 0 } }, String(model.name ?? model.id ?? '—')),
          h('span', { style: { fontSize: '11.5px', fontWeight: 600, color: tone.color } }, tone.label),
          h('span', { style: { fontSize: '11.5px', color: C.labelSecondary } }, uptime === null ? '—' : `${uptime}%`),
          h('span', {
            style: { flex: 'none', width: '54px', height: '4px', borderRadius: '2px', background: C.border, overflow: 'hidden' },
          },
          h('span', {
            style: {
              display: 'block',
              height: '100%',
              width: `${Math.max(0, Math.min(100, uptime ?? 0))}%`,
              background: tone.color,
            },
          })),
          h('span', { style: { fontSize: '11.5px', color: C.labelSecondary } }, `ошибок ${errors === null ? '—' : errors}`),
          last === null
            ? null
            : h('span', { style: { fontSize: '11.5px', color: C.labelSecondary } }, `последняя ${relativeTime(last.t)}`)),

        last === null
          ? null
          : h('div', {
              style: { color: C.labelSecondary, fontSize: '11.5px', margin: '2px 0 0 15px', wordBreak: 'break-word' },
            },
            `последняя ошибка ${Number.isFinite(last.t) ? new Date(last.t).toLocaleString() : '—'} — ${String(last.code ?? '—')} ${String(last.message ?? '')}`),

        h('div', { style: { display: 'flex', gap: '1px', alignItems: 'flex-end', height: '16px', margin: '4px 0 0 15px' } },
          hasErrors
            ? counts.map((count, index) => h('span', {
                key: index,
                title: count === 0 ? 'ошибок нет' : String(count),
                style: {
                  flex: '1 1 0',
                  height: `${Math.max(6, Math.round((count / peak) * 100))}%`,
                  borderRadius: '1px',
                  background: count === 0 ? C.border : C.down,
                },
              }))
            : h('span', { style: { color: C.labelSecondary, fontSize: '11px' } }, 'ошибок нет')))
    }

    /**
     * The collector's uptime view, as one box on the settings page.
     *
     * Every number here is the collector's own: this half reads the host's mirror and
     * draws it, so the panel and the monitor's web page cannot disagree about what "up"
     * means. That includes the empty answer, which is the normal one while the
     * collector's aggregation is still being written — «ошибок нет» is a finding rather
     * than a failure to load, and it is drawn as one instead of as a spinner or a red
     * line.
     *
     * The range is this component's own state on purpose: it is a way of looking at the
     * data rather than a setting, and writing it to `/config` would turn one user's
     * glance at last month into a preference every other surface inherits.
     *
     * @param props - `{ enabled }`, the page's own reading of `config.uptimeView`.
     */
    function UptimeSection(props) {
      const enabled = props.enabled !== false
      const [range, setRange] = React.useState('24h')
      const [data, setData] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)

      /**
       * One read of the mirror.
       *
       * Forced, because every caller is deliberate — mounting, changing range, pressing
       * the button — and a deliberate read answered from the throttle would look like
       * the button did nothing.
       *
       * @param want - the range to ask for.
       */
      const read = React.useCallback(async want => {
        setBusy(true)
        try {
          setData(await loadUptime(want, { force: true }))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        if (!enabled) {
          setData(undefined)
          return undefined
        }
        void read(range)
        // The collector's own page polls every 30 s and the host mirrors that answer,
        // so this keeps the same cadence and stops the moment the page is closed: a
        // panel nobody is looking at has no business asking.
        const timer = setInterval(() => { void read(range) }, 30_000)
        return () => clearInterval(timer)
      }, [enabled, range, read])

      const summary = typeof data?.summary === 'object' && data.summary !== null ? data.summary : {}
      const models = Array.isArray(data?.models) ? data.models : []
      const refused = typeof data?.error === 'string' && data.error !== '' ? data.error : state.uptimeError
      const generatedAt = Number.isFinite(data?.generatedAt) ? new Date(data.generatedAt).toLocaleString() : '—'
      const cachedAt = Number.isFinite(data?.fetchedAt) ? new Date(data.fetchedAt).toLocaleString() : '—'
      const monitorUrl = typeof data?.monitorUrl === 'string' && data.monitorUrl !== '' ? data.monitorUrl : null

      return h('div', {
        style: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', background: C.surface },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' } },
          h('span', { style: { color: C.labelSecondary, fontSize: '11.5px', flex: '1 1 auto' } }, 'Аптайм моделей'),
          enabled
            ? h(Select, {
                value: range,
                options: [['24h', '24 часа'], ['7d', '7 дней'], ['30d', '30 дней']],
                onChange: value => setRange(value),
              })
            : null,
          enabled
            ? h(Button, { variant: 'small', onClick: () => { void read(range) }, disabled: busy },
                busy ? 'Обновление…' : 'Обновить')
            : null),

        !enabled
          ? h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', lineHeight: 1.6 } },
              'Аптайм выключен настройкой «Показывать аптайм моделей»: панель ничего не читает, и точки в списке моделей не рисуются.')
          : data === undefined
            ? h('div', { style: { color: C.labelSecondary, fontSize: '11.5px' } }, 'Читаем состояние моделей…')
            : data === null || data.ok === false
              ? h('div', { style: { color: C.warn, fontSize: '11.5px', lineHeight: 1.6 } },
                  `Коллектор не ответил: ${refused ?? 'причина не сообщена'}. Кнопка «Обновить» спрашивает ещё раз.`)
              : h('div', null,
                  data.stale === true
                    ? h('div', { style: { color: C.warn, fontSize: '11.5px', lineHeight: 1.6, marginBottom: '6px' } },
                        `показано кешированное от ${cachedAt}; коллектор недоступен: ${refused ?? 'причина не сообщена'}`)
                    : null,
                  h('div', { style: { fontSize: '12.5px', marginBottom: '8px' } },
                    `операционно ${summary.operational ?? '—'} из ${summary.totalModels ?? '—'} · деградируют ${summary.slow ?? '—'} · лежат ${summary.down ?? '—'} · аптайм ${summary.uptime ?? '—'}% · ошибок за период ${summary.totalErrors ?? '—'}`),
                  models.length === 0
                    ? h('div', { style: { color: C.labelSecondary, fontSize: '11.5px' } },
                        'Коллектор не назвал ни одной модели за этот период.')
                    : models.map(model => h(UptimeRow, { key: String(model?.id ?? model?.name ?? ''), model })),
                  h('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap', color: C.labelSecondary, fontSize: '11.5px' },
                  },
                  h('span', null, `обновлено ${generatedAt} · хранилище ${typeof data?.storage === 'string' && data.storage !== '' ? data.storage : '—'}`),
                  monitorUrl === null ? null : h(Link, { href: monitorUrl }, 'открыть полный монитор'))),
      )
    }

    /**
     * The settings page.
     *
     * Two blocks, because the mirror now does two jobs: what it holds for the
     * marks and how they are drawn, and what the provider serves right now
     * against what this profile's route has installed. The second block shows
     * the difference before anything is written — a profile author decides from
     * the drift, not from a count — and every address and file it uses is on the
     * page, editable or copyable, so nothing has to be changed blind in YAML.
     */
    function IconsPage() {
      const [status, setStatus] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [busy, setBusy] = React.useState('')

      /** Read the host's status into the page. */
      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setStatus(payload)
        } catch (error) {
          setNotice({ kind: 'bad', text: `Не удалось прочитать состояние: ${error.message}` })
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      /** Send one mutation to the host, then repaint the picker from its answer. */
      const post = async (path, body, label) => {
        setBusy(label)
        setNotice(undefined)
        try {
          const response = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setNotice(noticeFor(path, payload))
          await reload()
          await refresh()
        } catch (error) {
          setNotice({ kind: 'bad', text: error.message })
        } finally {
          setBusy('')
        }
      }

      const config = status?.config ?? {}
      const sync = status?.modelSync ?? {}
      const paths = status?.paths ?? {}
      const origin = String(config.origin ?? '')
      const fetched = status?.fetchedAt === null || status?.fetchedAt === undefined
        ? 'никогда'
        : new Date(status.fetchedAt).toLocaleString()

      /**
       * Whether collection is on.
       *
       * Read as "not explicitly off" rather than as a truth test, because a host half
       * older than the field answers `/state` without it and the default is on: a
       * missing `collectErrors` must not draw the switch as off.
       */
      const collecting = config.collectErrors !== false

      return h('div', { style: { font, color: C.label, padding: '4px 2px 24px', maxWidth: '760px' } },
        // The heading carries the gap to the first toggle itself: the paragraph that
        // used to supply it is gone, and 6px would put a checkbox under the title.
        h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '0 0 18px' } }, 'Rustvy'),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.enabled !== false,
            onChange: event => { void post('/config', { enabled: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Показывать иконки моделей')),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.markTrigger !== false,
            onChange: event => { void post('/config', { markTrigger: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Иконка в кнопке выбранной модели')),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.hideOtherMarks !== false,
            onChange: event => { void post('/config', { hideOtherMarks: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Прятать логотипы других скинов в строке, где нарисована эта иконка')),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.uptimeView !== false,
            onChange: event => { void post('/config', { uptimeView: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Показывать аптайм моделей')),

        h(FieldRow, { name: 'Размер значка, px', hint: 'от 10 до 32' },
          h(TextField, {
            type: 'number',
            min: 10,
            max: 32,
            step: 1,
            width: '80px',
            value: String(config.size ?? 16),
            onSave: value => { void post('/config', { size: Number(value) }, 'save') },
          })),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' } },
          h(Button, { variant: 'primary', onClick: () => { void post('/refresh', {}, 'refresh') }, disabled: busy !== '' },
            busy === 'refresh' ? 'Обновление…' : 'Обновить каталог и иконки'),
          h(Button, { onClick: () => { void refresh() }, disabled: busy !== '' }, 'Перечитать состояние'),
          notice === undefined
            ? null
            : h('span', {
                style: {
                  color: notice.kind === 'ok'
                    ? C.ok
                    : notice.kind === 'bad'
                      ? C.bad
                      : notice.kind === 'warn'
                        ? C.warn
                        : C.labelSecondary,
                  fontSize: '12.5px',
                },
              }, notice.text)),

        // First on the page, because it is the one thing here that answers the question
        // the page was opened with — is the model I am about to pick answering right
        // now — while everything below it is configuration. Moved as it stands: same
        // component, same props, same margins.
        h(UptimeSection, { enabled: config.uptimeView !== false }),

        h('div', {
          style: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', background: C.surface },
        },
          h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '6px' } }, 'Модели провайдера'),
          h(Row, { name: 'маршрут' },
            `${sync.route ?? '—'}${sync.entryId === null || sync.entryId === undefined ? ' (строка профиля не найдена)' : ` → ${sync.entryId}`}`),
          h(Row, { name: 'адрес списка' }, `${sync.baseURL ?? '—'}/models`),
          h(Row, { name: 'источник' }, sourceLabel(sync.source)),
          h(Row, { name: 'установлено' }, String(sync.installedCount ?? 0)),
          h(Row, { name: 'отдаёт провайдер' }, String(sync.count ?? 0)),
          sync.upToDate === true
            ? h(Row, { name: 'расхождение', tone: C.ok }, 'нет — список актуален')
            : h(Row, { name: 'расхождение', tone: C.warn },
                `новые: ${listOf(sync.added)}; убраны: ${listOf(sync.removed)}; изменены: ${changedList(sync.changed)}`),
          sync.available === false
            ? h(Row, { name: 'запись', tone: C.warn }, 'хост не отдаёт configEditor — список можно только посмотреть')
            : null,
          sync.error === undefined ? null : h(Row, { name: 'ошибка списка', tone: C.warn }, sync.error),
          sync.backup === null || sync.backup === undefined
            ? null
            : h(Row, { name: 'копия для отката' }, new Date(sync.backup).toLocaleString()),
          (sync.notes ?? []).length === 0
            ? null
            : h(Row, { name: 'примечания' }, (sync.notes ?? []).join('; '))),

        h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', margin: '0 0 8px' } },
          'Что именно синхронизировать'),
        h(FieldRow, { name: 'Маршрут провайдера', hint: 'ключ в providers' },
          h(TextField, {
            value: config.modelRoute ?? 'rustvy',
            width: '180px',
            onSave: value => { void post('/config', { modelRoute: value }, 'save') },
          })),
        h(FieldRow, { name: 'Строка профиля', hint: 'id в cordis.patch.yml' },
          h(TextField, {
            value: config.modelEntryId ?? 'llm-pi-ai',
            width: '180px',
            onSave: value => { void post('/config', { modelEntryId: value }, 'save') },
          })),
        h(FieldRow, { name: 'Сайт провайдера', hint: 'запасной адрес каталога' },
          h(TextField, {
            value: origin,
            width: '280px',
            onSave: value => { void post('/config', { origin: value }, 'save') },
          })),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.syncModels !== false,
            onChange: event => { void post('/config', { syncModels: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Держать список моделей маршрута актуальным')),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12.5px', color: C.labelSecondary, minWidth: '150px', flex: 'none' } }, 'Записывать список'),
          h(Select, {
            value: config.modelAutoApply ?? 'explicit',
            options: [['off', 'только отдельной кнопкой'], ['explicit', 'при нажатии «Обновить»'], ['always', 'сам, при каждом обновлении']],
            onChange: value => { void post('/config', { modelAutoApply: value }, 'save') },
          })),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12.5px', color: C.labelSecondary, minWidth: '150px', flex: 'none' } }, 'Название модели'),
          h(Select, {
            value: config.modelNameSource ?? 'displayName',
            options: [['displayName', 'как на сайте провайдера'], ['id', 'идентификатор']],
            onChange: value => { void post('/config', { modelNameSource: value }, 'save') },
          })),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.modelOfferOff !== false,
            onChange: event => { void post('/config', { modelOfferOff: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Предлагать уровень «без рассуждений» у рассуждающих моделей')),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: config.modelKeepUnknown === true,
            onChange: event => { void post('/config', { modelKeepUnknown: event.target.checked }, 'save') },
          }),
          h('span', { style: { fontSize: '12.5px' } }, 'Оставлять модели, которые провайдер больше не отдаёт')),

        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap' } },
          h(Button, {
            variant: 'primary',
            onClick: () => { void post('/apply-models', {}, 'apply') },
            disabled: busy !== '' || sync.available === false || !(sync.count > 0) || sync.upToDate === true,
          }, busy === 'apply' ? 'Запись…' : 'Записать список моделей'),
          h(Button, {
            onClick: () => { void post('/revert-models', {}, 'revert') },
            disabled: busy !== '' || sync.backup === null || sync.backup === undefined,
          }, busy === 'revert' ? 'Откат…' : 'Откатить к предыдущему')),

        h(YamlPanel, { cached: false }),

        h(KeysSection),

        // The error collector's own box, rather than a row beside the mark switches:
        // this is the one setting on the page that sends anything off the machine. The
        // box is a caption and a switch and nothing else. The readout that used to sit
        // under them is gone, and so is the paragraph that said what leaves and what
        // never does — that disclosure now lives in the READMEs and in
        // `docs/error-report.md`, where a reader can reach it without this page
        // carrying a wall of text. What collection did, and what it could not deliver,
        // is still on the host's own loopback route.
        h('div', {
          style: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', background: C.surface },
        },
          h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '6px' } }, 'Сбор ошибок Rustvy'),

          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: collecting,
              onChange: event => { void post('/config', { collectErrors: event.target.checked }, 'save') },
            }),
            h('span', { style: { fontSize: '12.5px' } }, 'Собирать ошибки rustvy')),
        ),

        // Last of the sections, and the paragraph that explains its rows moves with it:
        // the text describes the «Адреса», «Пути» and «Патч профиля» lines below, and
        // left above «Модели провайдера» it would explain rows that are no longer there.
        // It ends up next to the warning at the foot of the page, which is right — that
        // warning is about this box's catalog read and nothing else.
        h('div', {
          style: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', background: C.surface },
        },
          h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '6px' } }, 'Зеркало каталога'),
          h(Row, { name: 'версия каталога' }, status?.version === null || status?.version === undefined ? '—' : String(status.version)),
          h(Row, { name: 'моделей' }, String(status?.models ?? 0)),
          h(Row, { name: 'иконок в кэше' }, String(status?.logos ?? 0)),
          h(Row, { name: 'обновлён' }, fetched),
          h(Row, { name: 'маршрут' }, status?.route ?? '—'),
          h(Row, { name: 'прокси процесса' }, status?.proxy ?? 'none'),
          h(Row, { name: 'сборка' }, `${status?.build ?? '—'} (ревизия ${status?.revision ?? '—'})`),
          status?.error === undefined
            ? null
            : h(Row, { name: 'последняя ошибка', tone: C.warn }, status.error),

          h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', margin: '10px 0 6px' } }, 'Адреса'),
          origin === '' ? null : h(LinkRow, { name: 'сайт провайдера', href: origin }),
          origin === '' ? null : h(LinkRow, { name: 'страница каталога', href: `${origin}/models` }),
          sync.modelsUrl === undefined ? null : h(LinkRow, { name: 'список моделей', href: sync.modelsUrl }),

          h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', margin: '10px 0 6px' } }, 'Файлы'),
          h(PathRow, { name: 'зеркало каталога' }, paths.catalog ?? ''),
          h(PathRow, { name: 'настройки плагина' }, paths.config ?? ''),
          h(PathRow, { name: 'копия списка моделей' }, paths.backup ?? ''),
          h(PathRow, { name: 'патч профиля' }, paths.patch ?? ''),
          h(PathRow, { name: 'каталог кэша' }, paths.cache ?? ''),
          // The collector's two files, when this host half has them: an older one
          // reports no such paths, and an absent row is the honest rendering of it.
          paths.install === undefined ? null : h(PathRow, { name: 'анонимный идентификатор' }, paths.install),
          paths.errorsQueue === undefined ? null : h(PathRow, { name: 'очередь ошибок' }, paths.errorsQueue)),

        h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '16px', lineHeight: 1.6 } },
          'Адреса открываются в новой вкладке. Пути — только текст: браузер не открывает чужие файлы, '
          + 'но их можно скопировать и открыть самому. Патч профиля — тот файл, где живёт строка маршрута; '
          + 'править его руками стоит тогда, когда автоматическая запись не подходит.'),

        // Not prose: the one place this page reports a catalog read that failed, and
        // the only reason the closing block survives at all. It renders when there is
        // something to report and renders nothing otherwise, so the page ends on its
        // last control rather than on a reassurance nobody asked for.
        status?.error === undefined
          ? null
          : h('div', { style: { color: C.warn, fontSize: '11.5px', lineHeight: 1.6 } },
              'Каталог не получен — значки рисуются по правилам и монограммам. Проверьте прокси и нажмите «Обновить».'),
      )
    }

    /** Plugin name, and the one service this half needs. */
    const name = 'dsh-rustvy'
    const inject = ['slots']

    /**
     * Client plugin body: own the stylesheet, keep the picker decorated for as
     * long as the plugin is mounted, and register the settings page.
     *
     * @param ctx - the client cordis context.
     */
    function apply(ctx) {
      mountStyles()

      ctx.effect(() => {
        let disposed = false

        /**
         * React to a change made anywhere in this page.
         *
         * A keys-only change needs nothing here: the surfaces that draw keys are
         * React components listening for the same event. Anything else is a
         * settings change, so the catalog is re-read and the marks repainted.
         */
        const onChanged = event => {
          if (disposed || event?.detail?.keys === true) return
          void reload()
        }
        window.addEventListener(CHANGED, onChanged)

        /**
         * One interaction with the page: repaint the marks, and refresh the key
         * list for the chat the composer published.
         *
         * Both are cheap by construction. The repaint is coalesced into one frame,
         * and the read is throttled inside `loadKeys`, so a burst of clicks costs at
         * most one request per couple of seconds — which matters because the host
         * resolves every key's credential to answer it. A read that did reach the
         * host moved the revision, and only then does the switch need repainting.
         */
        const onInteract = () => {
          if (disposed) return
          scheduleDecorate()
          // The dots ride the same interactions the marks do, throttled inside
          // `loadUptime` to the collector's own cadence: a menu opened twice in a row
          // costs one loopback read per half minute, and only an answer that moved
          // something earns a second pass.
          if (state.uptimeView) {
            const beforeUptime = state.uptimeRevision
            void loadUptime(DOT_RANGE).then(() => {
              if (state.uptimeRevision !== beforeUptime) scheduleDecorate()
            })
          }
          if (state.sessionId === null) return
          const before = state.keysRevision
          void loadKeys(state.sessionId).then(() => {
            if (state.keysRevision !== before) announce(true)
          })
        }

        observer = new MutationObserver(records => {
          if (suppress || disposed) return
          // A mutation that only moved this half's own marks needs no pass; a
          // characterData edit does, because it is how a trigger's label changes
          // when the user picks another model.
          const foreign = records.some(record => {
            if (record.type === 'characterData') return true
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
              if (node.nodeType !== 1) continue
              const element = /** @type {Element} */ (node)
              if (element.classList?.contains(MARK) || element.classList?.contains(DOT)) continue
              if (element.querySelector?.(`.${MARK}`) !== null) continue
              if (element.querySelector?.(`.${DOT}`) !== null) continue
              return true
            }
            return false
          })
          if (foreign) scheduleDecorate()
        })

        const root = document.body ?? document.documentElement
        if (root !== null && root !== undefined) {
          observer.observe(root, { childList: true, subtree: true, characterData: true })
        }

        // The picker is a portal that appears on demand, so a pass on open is
        // what actually draws the marks; the observer catches the rows that
        // arrive later (a search filtering the list, a group loading).
        document.addEventListener('pointerdown', onInteract, true)
        document.addEventListener('focusin', onInteract, true)

        void reload()
        // The mirror may still be fetching when the page opens, and a cold read
        // is bounded on the host, so an empty answer is retried twice before the
        // page settles on vendor rules and monograms alone.
        const retries = [4000, 20_000].map(delay => setTimeout(() => {
          if (!disposed && state.records.length === 0) void reload()
        }, delay))

        return () => {
          disposed = true
          for (const timer of retries) clearTimeout(timer)
          window.removeEventListener(CHANGED, onChanged)
          document.removeEventListener('pointerdown', onInteract, true)
          document.removeEventListener('focusin', onInteract, true)
          if (observer !== null) {
            observer.disconnect()
            observer = null
          }
          clearMarks()
          unmountStyles()
        }
      }, 'dsh-rustvy: picker marks')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        // The id is a stable slot identity, not a label: it stays what it was so
        // a profile that already placed or opened this section keeps its state.
        id: 'rustvy',
        order: 42,
        label: () => 'Rustvy',
      }, () => h(IconsPage)))

      /**
       * The key selector, in the composer's tool row immediately after the
       * permission/mode dropdown.
       *
       * This is the one place a conversation offers the choice: the model picker
       * stays about models, and a second copy of the same list in a menu the user
       * opens for another reason is clutter rather than convenience.
       *
       * The slot is session-scoped, so Cordis disposes the registration when the
       * conversation it was injected for goes away, and this half keeps no
       * per-session resource of its own. `KeyControl` renders nothing at all until
       * the slot hands it a `sessionId` and the host answers with two keys or more.
       */
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'rustvy-key',
        order: 60,
        label: () => 'API-ключ',
        // Forwarded through `createElement` rather than registered bare, so the
        // control's hooks bind to a component instance the same way the settings
        // page's do, whichever way the slot renders its content.
      }, props => h(KeyControl, props)))
    }

    /** Tell the decorator that a setting changed, wherever the change was made. */
    if (typeof window !== 'undefined') {
      window.__dshModelIconsReload = () => reload()
    }

    // Injected during materialization, which is the moment the module system
    // inventories a bundle's <style> tags, so an unload takes the rules with it
    // even if this half's own cleanup never runs.
    mountStyles()

    return { name, inject, apply }
  },
})
