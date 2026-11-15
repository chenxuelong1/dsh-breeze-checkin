/**
 * dsh-breeze-checkin —— Host 侧。
 *
 * 把 Breeze Blue（breezeblue.ai）的开发者账号做成一个本机账号池：
 *   - 账号凭据（邮箱 + 密码 + 会话 cookie）存进 DSH 的凭据记录，不落明文配置；
 *   - 签到走官方 Web 接口，与网页上点「立即领取」是同一条链路；
 *   - 所有写操作都是 POST + 仅本机回环，串行、幂等，绝不重复领取。
 *
 * 上游接口（2026-11-15 实测）：
 *   POST /api/auth/email/continue   { email, password, locale }  → 下发 breeze_blue_session
 *   GET  /api/me                     → 账号资料
 *   GET  /api/credits/summary        → balance / daily_claim_available / daily_claim_claimed_today
 *   POST /api/credits/daily-claim    { reward_tier } → { claimed, credits_issued, balance, ... }
 *
 * 幂等依据是服务端自己回的 `already_claimed`，不是本地日期：本地时钟错了也骗不过服务端。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 上游根地址。只认这一个域名，避免凭据被任何配置引导到别处。 */
const UPSTREAM = 'https://breezeblue.ai'

/** 签到档位：discord 档与普通档。服务端决定实际发放量，本地不写死。 */
const TIERS = new Set(['discord', 'standard'])

const STATE_PATH = '/plugins/dsh-breeze-checkin/state'
const ADD_PATH = '/plugins/dsh-breeze-checkin/account/add'
const REMOVE_PATH = '/plugins/dsh-breeze-checkin/account/remove'
const TEST_PATH = '/plugins/dsh-breeze-checkin/account/test'
const SETTINGS_PATH = '/plugins/dsh-breeze-checkin/settings'
const CHECKIN_PATH = '/plugins/dsh-breeze-checkin/checkin'
const REFRESH_PATH = '/plugins/dsh-breeze-checkin/refresh'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/* ------------------------------------------------------------------ 工具 */

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function messageOf(error) {
  // 网络层的原始报错是英文技术话（Failed to fetch / fetch failed），
  // 直接甩给用户等于没说。这里统一翻成「发生了什么 + 能怎么办」。
  if (error instanceof Error) {
    const text = error.message
    if (error.name === 'TimeoutError' || /aborted due to timeout|signal timed out/i.test(text)) {
      return '请求超时了，站点可能很慢，请稍后重试。'
    }
    if (error.name === 'AbortError') return '请求被中断了，请重试。'
    if (error instanceof TypeError || /fetch failed|Failed to fetch|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(text)) {
      return '连不上 breezeblue.ai（网络不通或被拦截），请检查网络后重试。'
    }
    return text
  }
  return String(error)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 是否为本机回环地址。DNS-rebinding 的第一道闸。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  if (value === '::1') return true
  return /^127\./.test(value)
}

/** Host 头必须是回环名，防止别的站点把浏览器指到这条路由上。 */
function isLoopbackHostHeader(host) {
  if (typeof host !== 'string' || host === '') return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]' || /^127\./.test(name)
}

/** 读 JSON 请求体，超过上限直接拒绝。 */
async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

/* ------------------------------------------------- 账号索引（不含密钥） */

/**
 * 账号索引只存「有哪些账号、各自叫什么、上次签到结果如何」。
 * 密码与 cookie 走凭据记录，绝不进这份文件。
 */
function stateDir() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'breeze-checkin')
}

function stateFile() {
  return path.join(stateDir(), 'accounts.json')
}

function emptyState() {
  return { version: 1, tier: 'discord', accounts: [] }
}

function loadState() {
  const file = stateFile()
  if (!existsSync(file)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((row) => row && typeof row.accountId === 'string' && typeof row.email === 'string')
      : []
    return {
      version: 1,
      tier: TIERS.has(parsed.tier) ? parsed.tier : 'discord',
      accounts,
    }
  } catch {
    // 文件坏了就当作空池：宁可让用户看到「没有账号」，也不要带着半份坏数据去签到。
    return emptyState()
  }
}

function saveState(state) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const file = stateFile()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/* ------------------------------------------------------- 凭据记录读写 */

/**
 * 记录 key 的 scope/id 只接受 `^[a-z][a-z0-9-]*$`，所以账号 id 必须是
 * 小写字母开头、只含字母数字与连字符。这里统一生成。
 */
function newAccountId() {
  const hex = Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  return `acct-${hex}`
}

/** 记录里存的载荷：登录所需的一切，只有本插件读得懂。 */
function recordPayloadOf(account) {
  return {
    email: account.email,
    password: account.password,
    cookie: account.cookie ?? null,
    checkedAtMs: account.checkedAtMs ?? null,
  }
}

/* ------------------------------------------------------------ 上游调用 */

/** 极简 cookie jar：只保留上游下发的名字/值，不带任何本地路径。 */
function absorbCookies(jar, response) {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const line of lines) {
    const [pair] = line.split(';')
    const index = pair.indexOf('=')
    if (index < 0) continue
    const name = pair.slice(0, index).trim()
    if (name === '') continue
    const value = pair.slice(index + 1).trim()
    // 过期/清空用空值表达，直接删掉，别留一个空 cookie 骗自己「已登录」。
    if (value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

async function upstream(jar, pathname, init = {}) {
  const headers = {
    'user-agent': USER_AGENT,
    origin: UPSTREAM,
    referer: `${UPSTREAM}/app/developer`,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(init.headers ?? {}),
  }
  if (jar.size > 0) {
    headers.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  const response = await fetch(UPSTREAM + pathname, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  absorbCookies(jar, response)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  return { status: response.status, body }
}

/** 用邮箱密码登录，返回 cookie jar 与账号资料。 */
async function login(email, password) {
  const jar = new Map()
  const result = await upstream(jar, '/api/auth/email/continue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, locale: 'zh', next_path: '/app/developer' }),
  })
  if (result.status >= 400 || result.body?.ok === false) {
    const code = typeof result.body?.code === 'string' ? result.body.code : ''
    throw new Error(loginMessageOf(code, result.status))
  }
  if (!jar.has('breeze_blue_session')) {
    throw new Error('登录接口没有下发会话 cookie，请稍后重试。')
  }
  return { jar, user: result.body?.user ?? null }
}

/** 把上游错误码翻成人话，别把英文 API 原文甩给用户。 */
function loginMessageOf(code, status) {
  switch (code) {
    case 'AUTH_INVALID_CREDENTIALS':
      return '邮箱或密码不对。'
    case 'AUTH_SIGNUP_VERIFICATION_REQUIRED':
      return '这个邮箱在本机无法直接登录（服务端要求新人机验证）。请先在浏览器里注册并登录一次。'
    case 'AUTH_REQUIRED':
    case 'AUTH_SESSION_EXPIRED':
      return '登录状态已失效，请重新添加账号。'
    case 'AUTH_WEAK_PASSWORD':
      return '密码不符合站点要求。'
    default:
      // 不再把英文 code 拼进用户可见文案；排查时看 DSH 日志。
      return status === 429
        ? '请求太频繁，请稍后再试。'
        : `登录失败（HTTP ${status}），请稍后再试；连续失败请更新插件。`
  }
}

/** 用已保存的 cookie 读账号状态；cookie 失效时返回 null 让调用方重新登录。 */
async function readSummary(jar) {
  const result = await upstream(jar, '/api/credits/summary')
  if (result.status === 401) return null
  if (result.status >= 400) throw new Error(`读取余额失败（HTTP ${result.status}）`)
  return result.body
}

/* --------------------------------------------------------------- 插件 */

/**
 * 单账号签到。
 *
 * 顺序固定：先读 summary 判断今天有没有领过，再决定要不要发领取。
 * 服务端的 `daily_claim_claimed_today` 才是唯一依据——本地不猜日期。
 */
async function checkinOne(account, tier, deps) {
  const base = { accountId: account.accountId, email: account.email }
  let payload
  try {
    payload = await deps.readSecret(account.accountId)
  } catch (error) {
    return { ...base, status: 'failed', message: `读不到凭据：${messageOf(error)}` }
  }
  if (payload === undefined) {
    return { ...base, status: 'failed', message: '凭据已丢失，请删除后重新添加这个账号。' }
  }

  const jar = new Map()
  if (payload.cookie && typeof payload.cookie === 'object') {
    for (const [name, value] of Object.entries(payload.cookie)) {
      if (typeof value === 'string' && value !== '') jar.set(name, value)
    }
  }

  try {
    let summary = jar.size > 0 ? await readSummary(jar) : null
    let relogged = false

    // cookie 过期就重新登录一次。密码是用户自己存的，不是猜的。
    if (summary === null) {
      const fresh = await login(payload.email, payload.password)
      jar.clear()
      for (const [name, value] of fresh.jar) jar.set(name, value)
      relogged = true
      summary = await readSummary(jar)
      if (summary === null) {
        return { ...base, status: 'failed', message: '登录后仍然读不到账号状态，站点可能改了接口。' }
      }
    }

    await deps.writeSecret(account.accountId, {
      ...payload,
      cookie: Object.fromEntries(jar),
    })

    if (summary.daily_claim_claimed_today === true) {
      return {
        ...base,
        status: 'already',
        balance: summary.balance,
        relogged,
        claimedToday: true,
        nextResetAt: summary.daily_claim_next_reset_at ?? null,
        message: '今天已经领过了。',
      }
    }
    if (summary.daily_claim_available !== true) {
      return {
        ...base,
        status: 'unavailable',
        balance: summary.balance,
        relogged,
        message: '当前账号今天没有可领取的奖励。',
      }
    }

    const claim = await upstream(jar, '/api/credits/daily-claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reward_tier: tier }),
    })
    if (claim.status >= 400) {
      return {
        ...base,
        status: 'failed',
        balance: summary.balance,
        relogged,
        message: `领取失败（HTTP ${claim.status}）${claim.body?.code ? `：${claim.body.code}` : ''}`,
      }
    }
    // 服务端说「已经领过」同样算成功，只是没进账——不重试，避免把「已领」当「失败」再打一次。
    const issued = typeof claim.body?.credits_issued === 'number' ? claim.body.credits_issued : 0
    const alreadyClaimed = claim.body?.already_claimed === true
    return {
      ...base,
      status: alreadyClaimed ? 'already' : 'claimed',
      credit: issued,
      balance: typeof claim.body?.balance === 'number' ? claim.body.balance : summary.balance,
      tier: typeof claim.body?.daily_claim_reward_tier === 'string' ? claim.body.daily_claim_reward_tier : tier,
      relogged,
      claimedToday: true,
      nextResetAt: claim.body?.daily_claim_next_reset_at ?? null,
      message: alreadyClaimed ? '今天已经领过了。' : `领到 ${issued} 积分。`,
    }
  } catch (error) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
}

/**
 * 只读地刷新一个账号的余额与今日状态。
 *
 * 与 `checkinOne` 的区别：绝不发领取请求，只做「看一眼现在什么情况」。
 * 「刷新状态」按钮用它，否则那个按钮只是在重读本地文件，点多少次余额都不会变。
 */
async function refreshOne(account, deps) {
  const base = { accountId: account.accountId, email: account.email }
  let payload
  try {
    payload = await deps.readSecret(account.accountId)
  } catch (error) {
    return { ...base, status: 'failed', message: `读不到凭据：${messageOf(error)}` }
  }
  if (payload === undefined) {
    return { ...base, status: 'failed', message: '凭据已丢失，请删除后重新添加这个账号。' }
  }

  const jar = new Map()
  if (payload.cookie && typeof payload.cookie === 'object') {
    for (const [name, value] of Object.entries(payload.cookie)) {
      if (typeof value === 'string' && value !== '') jar.set(name, value)
    }
  }

  try {
    let summary = jar.size > 0 ? await readSummary(jar) : null
    if (summary === null) {
      const fresh = await login(payload.email, payload.password)
      jar.clear()
      for (const [name, value] of fresh.jar) jar.set(name, value)
      summary = await readSummary(jar)
      if (summary === null) {
        return { ...base, status: 'failed', message: '登录后仍然读不到账号状态，站点可能改了接口。' }
      }
    }
    await deps.writeSecret(account.accountId, { ...payload, cookie: Object.fromEntries(jar) })
    return {
      ...base,
      status: 'ok',
      balance: typeof summary.balance === 'number' ? summary.balance : null,
      claimedToday: summary.daily_claim_claimed_today === true,
      available: summary.daily_claim_available === true,
      nextResetAt: summary.daily_claim_next_reset_at ?? null,
    }
  } catch (error) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
}

export function apply(ctx, config) {
  const disposers = []

  /** 账号读写的薄封装：凭据服务不在时，明确报错而不是退回明文。 */
  const credentials = () => {
    const service = ctx.get('credentials')
    if (service === undefined || typeof service.modifyRecord !== 'function') {
      throw new Error('本机没有可用的凭据服务，无法安全保存账号密码。')
    }
    return service
  }

  function recordKeyOf(accountId) {
    // scope 固定是插件自己，id 是账号 id；拼起来才是完整的 `<scope>/<id>`。
    return `dsh-breeze-checkin/${accountId}`
  }

  async function readSecret(accountId) {
    const service = credentials()
    const record = await service.readRecord(recordKeyOf(accountId))
    if (record === undefined || record?.kind !== 'grant') return undefined
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return undefined
    return payload
  }

  async function writeSecret(accountId, payload) {
    const service = credentials()
    await service.modifyRecord(recordKeyOf(accountId), async () => ({ kind: 'grant', payload }))
  }

  async function deleteSecret(accountId) {
    const service = credentials()
    if (typeof service.deleteRecord === 'function') await service.deleteRecord(recordKeyOf(accountId))
  }

  const deps = { readSecret, writeSecret }

  /** 对外视图：绝不带密码、不带 cookie。 */
  function publicAccount(row) {
    return {
      accountId: row.accountId,
      email: row.email,
      label: typeof row.label === 'string' ? row.label : '',
      enabled: row.enabled !== false,
      lastCheckinAtMs: typeof row.lastCheckinAtMs === 'number' ? row.lastCheckinAtMs : null,
      lastStatus: typeof row.lastStatus === 'string' ? row.lastStatus : null,
      lastMessage: typeof row.lastMessage === 'string' ? row.lastMessage : '',
      lastCredit: typeof row.lastCredit === 'number' ? row.lastCredit : null,
      balance: typeof row.balance === 'number' ? row.balance : null,
      nextResetAt: typeof row.nextResetAt === 'string' ? row.nextResetAt : null,
      // 服务端说「今天领过了」是独立于 lastStatus 的事实：新加的账号还没签到过，
      // 但它今天可能早就领过了，界面必须能直接说出来，而不是显示「未签到」骗人。
      claimedToday: row.claimedToday === true,
      lastTestedAtMs: typeof row.lastTestedAtMs === 'number' ? row.lastTestedAtMs : null,
    }
  }

  function snapshot() {
    const state = loadState()
    return {
      tier: state.tier,
      accounts: state.accounts.map(publicAccount),
      tiers: [...TIERS],
    }
  }

  /** 把一次签到的结果写回索引，并顺手刷新余额。 */
  function recordResult(state, row) {
    for (const account of state.accounts) {
      if (account.accountId !== row.accountId) continue
      account.lastStatus = row.status
      account.lastMessage = row.message ?? ''
      account.lastCredit = typeof row.credit === 'number' ? row.credit : null
      account.balance = typeof row.balance === 'number' ? row.balance : account.balance ?? null
      account.nextResetAt = row.nextResetAt ?? null
      // 只有真的问到服务端才更新「上次签到时间」，失败不算。
      if (row.status !== 'failed') account.lastCheckinAtMs = Date.now()
      // already 就是服务端确认今天已领；claimed 领完当然也算今天已领。
      if (row.status === 'claimed' || row.status === 'already') account.claimedToday = true
      break
    }
    return state
  }

  /* ------------------------------------------------------------ 路由 */

  function mount(webCtx) {
    const route = (entry) => disposers.push(webCtx.webServer.register(entry))

    /** 统一骨架：方法闸 → 回环闸 → 业务 → 异常兜底。 */
    function endpoint(spec, run) {
      route({
        kind: 'exact',
        path: spec.path,
        handler: async (req, res) => {
          if (req.method !== spec.method) return json(res, 405, { error: 'method not allowed' })
          if (!isLoopbackAddress(req.socket.remoteAddress)) return json(res, 403, { error: '仅允许本机访问' })
          if (!isLoopbackHostHeader(req.headers.host ?? '')) return json(res, 403, { error: '仅允许本机访问' })
          try {
            await run(req, res)
          } catch (error) {
            json(res, 500, { error: messageOf(error) })
          }
        },
      })
    }

    endpoint({ path: STATE_PATH, method: 'GET' }, async (_req, res) => {
      json(res, 200, snapshot())
    })

    endpoint({ path: ADD_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const email = typeof body.email === 'string' ? body.email.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : ''
      if (email === '' || !email.includes('@')) return json(res, 400, { error: '请填写有效邮箱。' })
      if (password === '') return json(res, 400, { error: '请填写密码。' })

      const state = loadState()
      if (state.accounts.some((row) => row.email.toLowerCase() === email.toLowerCase())) {
        return json(res, 409, { error: '这个邮箱已经在账号池里了。' })
      }

      // 先登录一次再入库：存一个登不上的账号只会让签到界面上多一行永远失败的红字。
      let session
      try {
        session = await login(email, password)
      } catch (error) {
        return json(res, 400, { error: messageOf(error) })
      }

      const accountId = newAccountId()
      try {
        await writeSecret(accountId, {
          email,
          password,
          cookie: Object.fromEntries(session.jar),
          checkedAtMs: Date.now(),
        })
      } catch (error) {
        return json(res, 500, { error: `保存凭据失败：${messageOf(error)}` })
      }

      const summary = await readSummary(session.jar).catch(() => null)
      state.accounts.push({
        accountId,
        email,
        label,
        enabled: true,
        lastCheckinAtMs: null,
        lastStatus: null,
        lastMessage: '',
        lastCredit: null,
        balance: typeof summary?.balance === 'number' ? summary.balance : null,
        nextResetAt: summary?.daily_claim_next_reset_at ?? null,
        // 加进来的时候服务端已经告诉我们今天领没领了，别把这个事实丢掉。
        claimedToday: summary?.daily_claim_claimed_today === true,
        lastTestedAtMs: null,
      })
      saveState(state)
      json(res, 200, { account: publicAccount(state.accounts.at(-1)), state: snapshot() })
    })

    endpoint({ path: REMOVE_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const accountId = typeof body.accountId === 'string' ? body.accountId : ''
      if (accountId === '') return json(res, 400, { error: '缺少 accountId。' })
      const state = loadState()
      const index = state.accounts.findIndex((row) => row.accountId === accountId)
      if (index < 0) return json(res, 404, { error: '账号不存在。' })
      state.accounts.splice(index, 1)
      saveState(state)
      // 索引先落盘再删凭据：中途失败最多留一条孤儿凭据，不会留一个「有账号但没密码」的空壳。
      await deleteSecret(accountId).catch(() => {})
      json(res, 200, snapshot())
    })

    endpoint({ path: TEST_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const accountId = typeof body.accountId === 'string' ? body.accountId : ''
      const state = loadState()
      const account = state.accounts.find((row) => row.accountId === accountId)
      if (account === undefined) return json(res, 404, { error: '账号不存在。' })

      const payload = await readSecret(accountId).catch(() => undefined)
      if (payload === undefined) return json(res, 400, { error: '这个账号的凭据已丢失，请删除后重新添加。' })

      try {
        const fresh = await login(payload.email, payload.password)
        await writeSecret(accountId, { ...payload, cookie: Object.fromEntries(fresh.jar) })
        const summary = await readSummary(fresh.jar)
        account.balance = typeof summary?.balance === 'number' ? summary.balance : account.balance ?? null
        account.nextResetAt = summary?.daily_claim_next_reset_at ?? null
        if (summary?.daily_claim_claimed_today === true) account.claimedToday = true
        // 「测试」只验证登录可用，不能抹掉今天的签到记录——
        // 否则上午刚领到 400，下午点一下测试，那一行就退回「未签到」，像是白领了。
        account.lastTestedAtMs = Date.now()
        saveState(state)
        json(res, 200, {
          ok: true,
          balance: account.balance,
          claimedToday: summary?.daily_claim_claimed_today === true,
          available: summary?.daily_claim_available === true,
          nextResetAt: account.nextResetAt,
          state: snapshot(),
        })
      } catch (error) {
        account.lastStatus = 'failed'
        account.lastMessage = messageOf(error)
        saveState(state)
        json(res, 400, { error: messageOf(error), state: snapshot() })
      }
    })

    endpoint({ path: REFRESH_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const state = loadState()
      const requested = Array.isArray(body.accountIds)
        ? body.accountIds.filter((id) => typeof id === 'string')
        : null
      const targets = state.accounts.filter((row) =>
        requested === null ? true : requested.includes(row.accountId),
      )
      if (targets.length === 0) return json(res, 200, { rows: [], state: snapshot() })

      const rows = []
      for (const [index, account] of targets.entries()) {
        // 只读刷新也串行：一口气打一堆请求同样会招来风控。
        if (index > 0) await wait(400)
        const row = await refreshOne(account, deps)
        rows.push(row)
        for (const target of state.accounts) {
          if (target.accountId !== row.accountId) continue
          if (typeof row.balance === 'number') target.balance = row.balance
          if (row.claimedToday === true) target.claimedToday = true
          if (row.nextResetAt !== undefined) target.nextResetAt = row.nextResetAt
          // 只读刷新不动 lastStatus：那是「上次签到结果」，不是「上次看了一眼」。
          if (row.status === 'failed') {
            target.lastStatus = 'failed'
            target.lastMessage = row.message
          }
          break
        }
        saveState(state)
      }
      json(res, 200, { rows, state: snapshot() })
    })

    endpoint({ path: SETTINGS_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const state = loadState()
      if (typeof body.tier === 'string') {
        if (!TIERS.has(body.tier)) return json(res, 400, { error: '档位只能是 discord 或 standard。' })
        state.tier = body.tier
      }
      if (Array.isArray(body.enabled)) {
        const wanted = new Set(body.enabled.filter((id) => typeof id === 'string'))
        for (const account of state.accounts) account.enabled = wanted.has(account.accountId)
      }
      saveState(state)
      json(res, 200, snapshot())
    })

    endpoint({ path: CHECKIN_PATH, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req)
      const state = loadState()
      if (typeof body.tier === 'string' && TIERS.has(body.tier)) state.tier = body.tier

      const requested = Array.isArray(body.accountIds)
        ? body.accountIds.filter((id) => typeof id === 'string')
        : null
      // 没点名就按勾选状态挑；点名了就只签点到的那些，一个都不额外签。
      const targets = state.accounts.filter((row) =>
        requested === null ? row.enabled !== false : requested.includes(row.accountId),
      )
      if (targets.length === 0) {
        saveState(state)
        return json(res, 200, { rows: [], state: snapshot(), message: '没有勾选任何账号。' })
      }

      const rows = []
      for (const [index, account] of targets.entries()) {
        // 串行 + 间隔：同时打一堆登录最容易把风控从「无挑战」升成「要人机验证」。
        if (index > 0) await wait(600)
        const row = await checkinOne(account, state.tier, deps)
        rows.push(row)
        recordResult(state, row)
        saveState(state)
      }

      json(res, 200, { rows, state: snapshot() })
    })

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载失败不该阻断其余路由的清理 */
        }
      }
    }
  }

  // webServer 可能比本插件晚就绪，所以走 inject 等它，而不是在 apply 里直接取。
  const fiber = ctx.inject(['webServer'], (webCtx) => {
    const disposeRoutes = mount(webCtx)
    webCtx.effect(() => disposeRoutes)
    return disposeRoutes
  })
  disposers.push(() => fiber.dispose())

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}
