// Маршруты пакетного обхода: `GET /dsh-rustvy/zapret` и `POST /dsh-rustvy/zapret`.
//
// Набор намеренно НЕ проверяет установку. Причина не в лени, а в том, что честная проверка
// `install` означала бы настоящую загрузку архива и настоящее окно UAC на машине того, кто
// прогоняет тесты, — ни то ни другое не принадлежит набору. Поэтому проверяется форма ответа,
// разбор действий и те отказы, которые детерминированы без сети и без повышения прав.
//
// Отказ при чужом запущенном zapret проверяется условно и УСЛОВНОСТЬ ПЕЧАТАЕТСЯ: на машине, где
// чужой службы нет, проверка сообщит, что не покрыта, вместо того чтобы молча пройти. Молчаливый
// пропуск — это зелёный тест, который не умеет краснеть.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exit } from 'node:process'

let passed = 0
let failed = 0
const skipped = []
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail === '' ? '' : `  — ${detail}`}`) } else { failed++; console.log(`FAIL  ${label}${detail === '' ? '' : `  — ${detail}`}`) }
}
const skip = (label, why) => { skipped.push(label); console.log(`SKIP  ${label}  — ${why}`) }

const STATES = ['absent', 'downloaded', 'stopped', 'running', 'foreign-running', 'unknown']
const SERVICES = ['absent', 'stopped', 'running', 'unknown']

const root = mkdtempSync(join(tmpdir(), 'dsh-zapret-host-'))
const profile = join(root, 'profiles', 'desktop')
const state = join(profile, '.dsh-rustvy')
mkdirSync(state, { recursive: true })
writeFileSync(join(profile, 'package.json'), '{"name":"dsh-zapret-host","version":"0.0.0","private":true}', 'utf8')
writeFileSync(join(state, 'config.json'), JSON.stringify({
  enabled: true,
  syncModels: false,
  apiKeys: false,
  collectErrors: false,
  uptimeView: false,
  origin: 'https://rustvy.xyz',
  uptimeEndpoint: 'http://127.0.0.1:9/api/report',
  proxyEnabled: false,
  proxySpec: '',
  proxyMode: 'http',
  tlsFragment: 'off',
  tlsFragmentCount: 4,
  tlsFragmentDelayMs: 3,
  streamIdleTimeout: 0,
}), 'utf8')

process.env.DSH_HOME = root
delete process.env.DSH_PROFILE_DIR

let route = null
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  profileContext: { patchPath: join(root, 'cordis.patch.yml') },
  on: () => () => {},
}
ctx.webServer = { register: registered => { route = registered; return () => { route = null } } }
ctx.configEditor = { entries: () => [], configuration: () => [], edit: async () => { throw new Error('не используется') } }

const { start } = await import('../lib/host.js')
const handle = await start(ctx, {})

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter()
    request.method = method
    request.url = path
    request.socket = { remoteAddress: '127.0.0.1' }
    request.headers = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
    const chunks = []
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); return this },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        const text = Buffer.concat(chunks.map(part => Buffer.from(String(part)))).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: this.status, json, text })
      },
    }
    route.handler(request, response)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    const timer = setTimeout(() => reject(new Error(`тайм-аут ${method} ${path}`)), 60_000)
    timer.unref()
  })
}

console.log('=== GET /dsh-rustvy/zapret ===')
const read = await call('GET', '/dsh-rustvy/zapret')
check('отвечает 200', read.status === 200, String(read.status))
check('и ok:true', read.json?.ok === true, JSON.stringify(read.json?.ok))
check('action — status', read.json?.action === 'status', String(read.json?.action))
check('progress при чтении состояния — null, а не выдуманное число', read.json?.progress === null, JSON.stringify(read.json?.progress))
check('reason пуст', read.json?.reason === '', JSON.stringify(read.json?.reason))

// `state` — строка из известного набора. Объект здесь означал бы, что страница рисует
// «неизвестно» при любом состоянии, а `null` — что состояние подменили отсутствием.
check('state — строка, а не объект и не null', typeof read.json?.state === 'string', typeof read.json?.state)
check('и она из объявленного набора', STATES.includes(read.json?.state), String(read.json?.state))
check('installed не выдаётся: sc не отличает его от stopped', read.json?.state !== 'installed', String(read.json?.state))

console.log('\n=== detail ===')
const detail = read.json?.detail
check('detail — объект', detail !== null && typeof detail === 'object', JSON.stringify(detail))
check('downloaded — булево', typeof detail?.downloaded === 'boolean', JSON.stringify(detail?.downloaded))
check('missing — массив', Array.isArray(detail?.missing), JSON.stringify(detail?.missing))
check('notices — массив', Array.isArray(detail?.notices), JSON.stringify(detail?.notices))
check('service из своего набора', SERVICES.includes(detail?.service), String(detail?.service))
check('foreignRunning — булево', typeof detail?.foreignRunning === 'boolean', JSON.stringify(detail?.foreignRunning))
check('hostlist — null, пока файла нет', detail?.hostlist === null, JSON.stringify(detail?.hostlist))
check('covered — null, а не false: никто не смотрел', detail?.covered === null, JSON.stringify(detail?.covered))
check('version — null, когда ничего не скачано', detail?.version === null, JSON.stringify(detail?.version))
check('ничего не скачано — значит missing непустой', detail?.downloaded === false ? detail.missing.length > 0 : true,
  JSON.stringify(detail?.missing))
check('и notices пусты, когда уведомления нет на диске', detail?.downloaded === false ? detail.notices.length === 0 : true,
  JSON.stringify(detail?.notices))

console.log('\n=== POST не отбивается как 405 (ловушка /timeout) ===')
const post = await call('POST', '/dsh-rustvy/zapret', { action: 'status' })
check('POST отвечает 200', post.status === 200, String(post.status))
check('и доходит до обработчика, а не до отказа по методу', post.json?.action === 'status', JSON.stringify(post.json))
check('status через POST даёт то же состояние, что GET', post.json?.state === read.json?.state,
  `${String(post.json?.state)} против ${String(read.json?.state)}`)

console.log('\n=== разбор действий ===')
const unknown = await call('POST', '/dsh-rustvy/zapret', { action: 'nonsense' })
check('неизвестное действие отклонено', unknown.json?.ok === false, JSON.stringify(unknown.json?.ok))
check('и причина называет это действие', String(unknown.json?.reason).includes('nonsense'), String(unknown.json?.reason))
check('при отказе state всё равно отдан', STATES.includes(unknown.json?.state), String(unknown.json?.state))

const empty = await call('POST', '/dsh-rustvy/zapret', {})
check('действие вообще без поля отклонено, а не принято за status', empty.json?.ok === false, JSON.stringify(empty.json?.ok))

const stop = await call('POST', '/dsh-rustvy/zapret', { action: 'stop' })
check('stop несуществующей службы не падает', typeof stop.json?.ok === 'boolean', JSON.stringify(stop.json?.ok))
check('и честно говорит, что службы нет', stop.json?.ok === false ? String(stop.json?.reason).length > 0 : true,
  String(stop.json?.reason))
// Кодировка. Windows PowerShell 5.1 пишет перенаправленный stdout в OEM-кодировке (cp866 на
// русской системе), а Node декодирует его как UTF-8, поэтому причина приходила кракозябрами.
// Прежняя проверка «причина не пуста» этот дефект не ловила: длина у кракозябр ненулевая, и
// отказ выглядел объяснённым, пока пользователь не прочитал бы его глазами.
check('причина читаема, а не в OEM-кодировке',
  !String(stop.json?.reason).includes('\uFFFD') && /[а-яА-Я]/u.test(String(stop.json?.reason)),
  String(stop.json?.reason))
check('и называет службу, к которой относится', String(stop.json?.reason).includes('dsh-rustvy-zapret'),
  String(stop.json?.reason))

console.log('\n=== uninstall без установленного ===')
const uninstall = await call('POST', '/dsh-rustvy/zapret', { action: 'uninstall' })
check('отвечает ok:true, когда удалять нечего', uninstall.json?.ok === true, JSON.stringify(uninstall.json))
check('и состояние после — не скачано', uninstall.json?.detail?.downloaded === false,
  JSON.stringify(uninstall.json?.detail?.downloaded))

console.log('\n=== hostlist и covered ===')
const lists = join(state, 'zapret', 'lists')
mkdirSync(lists, { recursive: true })
const hostlist = join(lists, 'rustvy.txt')
writeFileSync(hostlist, 'rustvy.xyz\n', 'utf8')
const withList = await call('GET', '/dsh-rustvy/zapret')
check('hostlist назван, когда файл существует', withList.json?.detail?.hostlist === hostlist,
  String(withList.json?.detail?.hostlist))
check('covered — true для хоста из origin', withList.json?.detail?.covered === true,
  JSON.stringify(withList.json?.detail?.covered))
writeFileSync(hostlist, 'example.org\n', 'utf8')
const otherList = await call('GET', '/dsh-rustvy/zapret')
check('covered — false, когда в списке другой хост', otherList.json?.detail?.covered === false,
  JSON.stringify(otherList.json?.detail?.covered))
writeFileSync(hostlist, '# только комментарий\n\n', 'utf8')
const commentsOnly = await call('GET', '/dsh-rustvy/zapret')
check('комментарии и пустые строки не считаются покрытием', commentsOnly.json?.detail?.covered === false,
  JSON.stringify(commentsOnly.json?.detail?.covered))

console.log('\n=== install: предупреждение при чужом движке, не запрет ===')
const foreignRunning = read.json?.detail?.foreignRunning === true
if (foreignRunning) {
  const install = await call('POST', '/dsh-rustvy/zapret', { action: 'install' })
  const reason = String(install.json?.reason)
  check('без подтверждения установка не начинается', install.json?.ok === false, JSON.stringify(install.json?.ok))
  check('и причина называет чужую службу', reason.includes(String(read.json?.detail?.foreignName ?? '')), reason)
  check('состояние — foreign-running', install.json?.state === 'foreign-running', String(install.json?.state))
  check('архив при этом не скачивался', existsSync(join(state, 'zapret', 'bin', 'winws.exe')) === false, '')
  // Предупреждение, а не дверь: пользователь должен узнать, что может поставить всё равно.
  check('причина говорит, что это можно обойти подтверждением', /подтверждением/u.test(reason), reason)
  // Фраза, которую попросил пользователь: у второго движка свой конфиг, и rustvy в нём быть не должно.
  check('и просит проверить, что в чужом конфиге нет rustvy', /нет rustvy|rustvy нет/u.test(reason), reason)
  // Гипотеза не выдаётся за факт: механизм перехвата не измерялся, и текст обязан это сказать.
  check('и не выдаёт непроверенное за измеренное', /не было|не измеря/i.test(reason), reason)
  check('и не повторяет прежнее утверждение, что движки ломают рукопожатия',
    !reason.includes('ломают рукопожатия'), reason)
  // Путь с ignoreForeign не проверяется: он дошёл бы до настоящей загрузки и настоящего UAC.
  skip('установка с ignoreForeign доходит до загрузки',
    'проверка потребовала бы настоящей сетевой загрузки и окна UAC; покрыт только путь отказа')
} else {
  // Не «прошли», а «не покрыто»: запускать install здесь означало бы настоящую загрузку и
  // настоящее окно UAC, а пропустить молча — значит выдать зелёный тест за проверку отказа.
  skip('предупреждение при чужом движке', 'на этой машине чужой zapret не запущен, а запускать install нельзя: он качает архив и запрашивает права')
}

if (typeof handle?.dispose === 'function') await handle.dispose()
else if (typeof handle === 'function') await handle()

rmSync(root, { recursive: true, force: true })
check('временный профиль удалён', !existsSync(root), root)

console.log(`\nИТОГ: ${passed} passed, ${failed} failed, ${skipped.length} skipped`)
if (skipped.length > 0) console.log('Не покрыто: ' + skipped.join('; '))
exit(failed > 0 ? 1 : 0)
