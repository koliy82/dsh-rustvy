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
 * This is a hand-authored bundle in the loader's factory-CJS protocol
 * (`window.__ModuleLoader__.load`), which is what the client module system
 * serves for a package declaring `dsh.client`. `react` comes from the frozen
 * platform module table and is used only by the settings page; the decoration
 * itself is plain DOM.
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

    /** Body attribute that turns on "one mark per row" for competing skins. */
    const HIDE_FLAG = 'data-dmi-hide-other'

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
    }

    const font = '13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif'

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
     */
    const CSS = `
.${MARK}{--dmi-size:16px;flex:none;width:var(--dmi-size);height:var(--dmi-size);min-width:var(--dmi-size);display:inline-block;background-color:currentColor;opacity:.9;-webkit-mask:var(--dmi-src) center / contain no-repeat;mask:var(--dmi-src) center / contain no-repeat;pointer-events:none;vertical-align:middle}
.${MARK}[data-dmi-surface="trigger"]{opacity:.85}
.${MARK}[data-dmi-mono]{background-color:transparent;-webkit-mask:none;mask:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:4px;font-size:calc(var(--dmi-size) * .58);font-weight:700;line-height:1;letter-spacing:.01em;opacity:.7;box-sizing:border-box}
body[${HIDE_FLAG}] [${ROW_FLAG}] .dsh-claude-model-combine,body[${HIDE_FLAG}] [${ROW_FLAG}] svg[data-combine-word]{display:none!important}
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
      byId: new Map(),
      byName: new Map(),
      records: [],
      available: new Set(),
      version: null,
      fetchedAt: null,
      error: null,
    }

    /** Style element this half owns; the loader inventories it, and so do we. */
    let styleElement = null

    /** True while this half is writing, so the observer ignores its own edits. */
    let suppress = false

    /** A pass is scheduled; coalesce mutations into one animation frame. */
    let scheduled = false

    /** The observer, when one is running. */
    let observer = null

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
      const surface = row.closest(
        '[role="menu"], [role="listbox"], [class*="_menu"], [class*="_card"], [class*="_groups"], .dsh-claude-model-popover',
      )
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
          const entry = resolve(nameOf(found.row, node))
          if (entry === undefined) continue
          if (decorateRow(found.row, entry, found.surface)) drawn += 1
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

    /** Remove every mark this half drew, on unload or when icons are switched off. */
    function clearMarks() {
      suppress = true
      try {
        for (const mark of document.querySelectorAll(`.${MARK}`)) mark.remove()
        for (const row of document.querySelectorAll(`[${ROW_FLAG}]`)) row.removeAttribute(ROW_FLAG)
      } finally {
        suppress = false
      }
      document.body?.removeAttribute(HIDE_FLAG)
    }

    /** Coalesce a burst of mutations into one pass on the next frame. */
    function scheduleDecorate() {
      if (scheduled || suppress) return
      scheduled = true
      const run = () => {
        scheduled = false
        if (suppress) return
        decorate(document)
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
        const summary = await loadCatalog()
        clearMarks()
        decorate(document)
        return summary
      } catch (error) {
        state.ready = false
        state.error = error instanceof Error ? error.message : String(error)
        clearMarks()
        return undefined
      }
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

    /** One button on the settings page. */
    function Button(props) {
      const primary = props.variant === 'primary'
      return h('button', {
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        style: {
          padding: '7px 14px',
          font,
          fontWeight: 500,
          cursor: props.disabled === true ? 'default' : 'pointer',
          opacity: props.disabled === true ? 0.55 : 1,
          borderRadius: '6px',
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

      return h('div', { style: { font, color: C.label, padding: '4px 2px 24px', maxWidth: '760px' } },
        h('h2', { style: { fontSize: '15px', fontWeight: 600, margin: '0 0 6px' } }, 'Rustvy'),
        h('p', { style: { color: C.labelSecondary, margin: '0 0 18px', fontSize: '12.5px' } },
          'Значок производителя перед названием модели в списке выбора и в кнопке модели, '
          + 'и список моделей маршрута, синхронный тому, что провайдер отдаёт сейчас. '
          + 'Каталог и сами значки зеркалятся хост-половиной с сайта провайдера в кэш профиля, '
          + 'поэтому страница берёт их с локального адреса и не выходит в интернет сама.'),

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
          h(PathRow, { name: 'каталог кэша' }, paths.cache ?? '')),

        h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', marginBottom: '16px', lineHeight: 1.6 } },
          'Адреса открываются в новой вкладке. Пути — только текст: браузер не открывает чужие файлы, '
          + 'но их можно скопировать и открыть самому. Патч профиля — тот файл, где живёт строка маршрута; '
          + 'править его руками стоит тогда, когда автоматическая запись не подходит.'),

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

        h('div', { style: { color: C.labelSecondary, fontSize: '11.5px', lineHeight: 1.6 } },
          h('div', null, 'Значок рисуется маской CSS, залитой текущим цветом строки, — тот же приём, что и на сайте провайдера, поэтому одна и та же картинка подходит и светлой, и тёмной теме.'),
          h('div', null, 'Модель, которой нет в зеркале, определяется по началу её идентификатора (claude-*, gpt-*, glm-*, kimi-*, qwen-*, deepseek-* и так далее). Если и это не сработало, вместо значка рисуется монограмма из первых букв производителя.'),
          h('div', null, 'Каталог обновляется сам раз в сутки и при каждом нажатии кнопки выше; уже загруженные значки берутся из кэша профиля, поэтому список моделей открывается мгновенно и без сети.'),
          h('div', null, 'Список моделей маршрута берётся с того же адреса, что и сами запросы, поэтому новая модель провайдера появляется в выборе без правки конфигов руками. Перед записью показывается расхождение: какие модели добавятся, какие уберутся и у каких изменятся окно контекста, лимит вывода, модальности или уровни рассуждения. Ручные настройки совместимости протокола сохраняются, предыдущий список остаётся в копии для отката.'),
          h('div', null, 'Кнопка «Показать блок для ручной правки» отдаёт ровно тот YAML, который записался бы сам, — вместе с полями подключения маршрута. Его можно скопировать и вставить в патч профиля, если автоматическая запись не нужна: содержимое одинаковое, различается только тем, кто его положил в файл.'),
          h('div', { style: { color: status?.error === undefined ? C.labelSecondary : C.warn } },
            status?.error === undefined
              ? 'Правки файлов плагина применяются на лету, без перезапуска приложения.'
              : 'Каталог не получен — значки рисуются по правилам и монограммам. Проверьте прокси и нажмите «Обновить».')),
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

        /** React to a settings change made anywhere in this page. */
        const onChanged = () => { void reload() }
        window.addEventListener('dsh-rustvy:changed', onChanged)

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
              if (element.classList?.contains(MARK)) continue
              if (element.querySelector?.(`.${MARK}`) !== null) continue
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
        document.addEventListener('pointerdown', scheduleDecorate, true)
        document.addEventListener('focusin', scheduleDecorate, true)

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
          window.removeEventListener('dsh-rustvy:changed', onChanged)
          document.removeEventListener('pointerdown', scheduleDecorate, true)
          document.removeEventListener('focusin', scheduleDecorate, true)
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
