/**
 * dsh-breeze-checkin —— Client 侧（Web 设置面板）。
 *
 * 注册一节 `settings.section`，就是账号池那张卡片：
 * 勾选账号 → 签到 → 每行回填余额与结果。
 *
 * 所有数据都来自 Host 的 /plugins/dsh-breeze-checkin/*，
 * 浏览器这边不碰密码，也不碰 cookie。
 */
window.__ModuleLoader__.load({
  id: 'dsh-breeze-checkin',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const PREFIX = '/plugins/dsh-breeze-checkin'
    const SECTION_ID = 'breeze-checkin'
    const CLS = 'dsh-bzc'

    /* --------------------------------------------------------- 样式 */

    const column = { display: 'flex', flexDirection: 'column', gap: 12 }

    /** 排版小工具：比到处写内联对象好读。 */
    const text = (size, token, extra) => ({
      fontSize: size,
      color: token,
      margin: 0,
      lineHeight: 1.55,
      ...(extra ?? {}),
    })
    const muted = text(13, 'var(--dsw-alias-label-tertiary)')
    const bodyText = text(14, 'var(--dsw-alias-label-secondary)')
    const heading = text(15, 'var(--dsw-alias-label-primary)', { fontWeight: 600 })
    const subHeading = text(14, 'var(--dsw-alias-label-primary)', { fontWeight: 600 })

    /** 与宿主设置卡片对齐：用 settings-card 系列 token，而不是裸边框。 */
    const card = {
      background: 'var(--dsw-alias-settings-card-fill)',
      border: '1px solid var(--dsw-alias-settings-card-stroke)',
      borderRadius: 12,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      minWidth: 0,
    }

    const rowBase = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }

    const control = {
      font: 'inherit',
      fontSize: 14,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      padding: '8px 10px',
      boxSizing: 'border-box',
      minWidth: 0,
      width: '100%',
    }

    /**
     * 按钮外观。`disabled` 必须看得见——否则签到期间满屏按钮被禁用，
     * 却和能点时长得一模一样，用户会一直点、以为界面卡死。
     */
    const button = (variant, disabled) => ({
      font: 'inherit',
      fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
      borderRadius: 8,
      padding: '7px 14px',
      border:
        variant === 'primary' ? '1px solid var(--dsw-alias-button-primary-fill)' : '1px solid var(--dsw-alias-border-l2)',
      background:
        variant === 'primary'
          ? disabled
            ? 'var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))'
            : 'var(--dsw-alias-button-primary-fill)'
          : 'transparent',
      color:
        variant === 'primary'
          ? disabled
            ? 'var(--dsw-alias-label-tertiary)'
            : 'var(--dsw-alias-label-on-color)'
          : 'var(--dsw-alias-label-primary)',
      whiteSpace: 'nowrap',
      lineHeight: 1.45,
      opacity: disabled ? 0.65 : 1,
    })

    /**
     * 表格列宽。
     *
     * 两条约束同时成立：文本列一律 `minmax(0, …fr)` 才能缩到内容以下；
     * 最后一列必须写死宽度，否则表头的「操作」两字和行里的两个按钮
     * 各自按内容算宽，整列对不齐，前面的 fr 列跟着错位。
     * 「上次签到」并进邮箱格做第二行小字，省掉一整列。
     */
    const tableGrid = '26px minmax(0, 1.7fr) 64px minmax(0, 1.5fr) 98px'
    const TABLE_MIN_WIDTH = 420
    const tableScroll = { overflowX: 'auto', minWidth: 0, margin: '0 -2px', padding: '0 2px' }
    const tableHead = {
      display: 'grid',
      gridTemplateColumns: tableGrid,
      gap: 10,
      alignItems: 'center',
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary)',
      padding: '0 8px',
      boxSizing: 'border-box',
      minWidth: TABLE_MIN_WIDTH,
    }
    const tableRow = {
      display: 'grid',
      gridTemplateColumns: tableGrid,
      gap: 10,
      alignItems: 'center',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      padding: '10px 8px',
      fontSize: 13,
      boxSizing: 'border-box',
      minWidth: TABLE_MIN_WIDTH,
    }
    const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
    const tinyButton = {
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
      borderRadius: 7,
      padding: '3px 8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      whiteSpace: 'nowrap',
      lineHeight: 1.4,
      minWidth: 46,
    }

    const STATUS_LABEL = {
      claimed: '已签到',
      already: '今天已领',
      unavailable: '暂无可领',
      failed: '失败',
    }
    const STATUS_COLOR = {
      claimed: 'var(--dsw-alias-state-success-primary)',
      already: 'var(--dsw-alias-label-tertiary)',
      unavailable: 'var(--dsw-alias-label-tertiary)',
      failed: 'var(--dsw-alias-label-error)',
    }

    /**
     * 一行的状态文案。
     *
     * 优先级：正在签到 > 上次签到结果 > 服务端说的「今天已领」 > 未签到。
     * 最后那个 fallback 不能直接写「未签到」：新加的账号从没签过，
     * 但今天可能早就领过了，说成「未签到」就是在骗人。
     */
    function statusText(account, pending) {
      if (pending) return '签到中…'
      if (account.lastStatus === 'failed') return '失败'
      if (account.lastStatus === 'claimed') {
        return account.lastCredit ? `已签到 +${account.lastCredit}` : '已签到'
      }
      if (account.lastStatus === 'already') return '今天已领'
      if (account.lastStatus === 'unavailable') return '暂无可领'
      if (account.claimedToday === true) return '今天已领'
      return '未签到'
    }

    function timeText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /* --------------------------------------------------------- 请求 */

    /** 把浏览器/网络层的英文报错翻成人话。 */
    function networkMessage(error) {
      if (error?.name === 'TimeoutError' || /aborted due to timeout/i.test(error?.message ?? '')) {
        return '请求超时了，本机服务或站点响应太慢，请稍后重试。'
      }
      if (error?.name === 'AbortError') return '请求已取消。'
      if (error instanceof TypeError || /Failed to fetch|NetworkError|fetch failed/i.test(error?.message ?? '')) {
        return '连不上本机服务。请确认 DSH 仍在运行，然后重试。'
      }
      return error?.message || '请求失败，请重试。'
    }

    async function call(path, init, timeoutMs = 60_000) {
      let response
      try {
        response = await fetch(PREFIX + path, {
          ...(init ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        })
      } catch (error) {
        throw new Error(networkMessage(error))
      }
      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = { error: `本机服务返回了非 JSON 内容（HTTP ${response.status}）。` }
      }
      if (!response.ok) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）。`)
      return payload
    }

    /* ---------------------------------------------------------- 组件 */

    function Page() {
      const [state, setState] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [pendingIds, setPendingIds] = useState([])
      const [email, setEmail] = useState('')
      const [password, setPassword] = useState('')
      const [label, setLabel] = useState('')

      const alive = useRef(true)
      const emailRef = useRef(null)
      const formRef = useRef(null)
      /** 勾选写请求的串行队列：连点两下不能各自拿着旧快照去覆盖对方。 */
      const selectionQueue = useRef(Promise.resolve())

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          const next = await call('/state')
          if (alive.current) {
            setState(next)
            setLoadError('')
          }
          return next
        } catch (error) {
          if (alive.current) setLoadError(networkMessage(error))
          throw error
        }
      }, [])

      useEffect(() => {
        void refresh().catch(() => {})
      }, [refresh])

      const accounts = state?.accounts ?? []
      const selectedIds = accounts.filter((a) => a.enabled).map((a) => a.accountId)
      const total = pendingIds.length
      const [progressDone, setProgressDone] = useState(0)
      const [progressTotal, setProgressTotal] = useState(0)

      /**
       * 写勾选状态。
       *
       * 关键：不要用上一步的 `accounts` 去算新列表再 POST——连点两下时第二次
       * 拿的是旧快照，会把第一次的点选覆盖掉，用户看到勾选自己弹回去，
       * 随后签到少一个账号且毫无报错。这里改成串行队列 + 以服务端回包为准。
       */
      const commitSelection = useCallback((mutate) => {
        selectionQueue.current = selectionQueue.current.then(async () => {
          const base = await call('/state')
          if (!alive.current) return
          const enabled = mutate(base.accounts ?? [])
          const next = await call('/settings', {
            method: 'POST',
            body: JSON.stringify({ enabled }),
          })
          if (alive.current) setState(next)
        })
        selectionQueue.current = selectionQueue.current.catch((error) => {
          if (alive.current) setNotice({ tone: 'error', text: networkMessage(error) })
        })
        return selectionQueue.current
      }, [])

      const toggle = useCallback(
        (accountId, enabled) => {
          setState((prev) =>
            prev === null
              ? prev
              : { ...prev, accounts: prev.accounts.map((a) => (a.accountId === accountId ? { ...a, enabled } : a)) },
          )
          void commitSelection((rows) =>
            rows.filter((a) => (a.accountId === accountId ? enabled : a.enabled)).map((a) => a.accountId),
          )
        },
        [commitSelection],
      )

      const selectAll = useCallback(
        (on) => {
          setState((prev) =>
            prev === null ? prev : { ...prev, accounts: prev.accounts.map((a) => ({ ...a, enabled: on })) },
          )
          void commitSelection((rows) => (on ? rows.map((a) => a.accountId) : []))
        },
        [commitSelection],
      )

      const setTier = useCallback(async (tier) => {
        const previous = state?.tier
        // 乐观更新 + 失败回滚：否则失败后那个 radio 已经勾上了，state 还是旧值。
        setState((prev) => (prev === null ? prev : { ...prev, tier }))
        try {
          const next = await call('/settings', { method: 'POST', body: JSON.stringify({ tier }) })
          if (alive.current) {
            setState(next)
            setNotice({ tone: 'ok', text: '档位已保存。' })
          }
        } catch (error) {
          if (!alive.current) return
          setState((prev) => (prev === null ? prev : { ...prev, tier: previous }))
          setNotice({ tone: 'error', text: networkMessage(error) })
        }
      }, [state?.tier])

      const runCheckin = useCallback(async () => {
        if (selectedIds.length === 0) return
        setBusy('checkin')
        setNotice(null)
        setPendingIds(selectedIds)
        setProgressDone(0)
        setProgressTotal(selectedIds.length)
        try {
          // 每个账号最坏 30s 上游超时 + 间隔，按数量放大客户端上限，避免永久卡在「签到中」。
          const budget = 60_000 + 45_000 * selectedIds.length
          const result = await call(
            '/checkin',
            { method: 'POST', body: JSON.stringify({ accountIds: selectedIds }) },
            budget,
          )
          if (!alive.current) return
          setState(result.state)
          const rows = Array.isArray(result.rows) ? result.rows : []
          const claimed = rows.filter((r) => r.status === 'claimed')
          const already = rows.filter((r) => r.status === 'already')
          const unavailable = rows.filter((r) => r.status === 'unavailable')
          const failed = rows.filter((r) => r.status === 'failed')
          const gained = claimed.reduce((sum, r) => sum + (typeof r.credit === 'number' ? r.credit : 0), 0)
          const parts = []
          if (claimed.length > 0) parts.push(`${claimed.length} 个签到成功，共 +${gained} 积分`)
          if (already.length > 0) parts.push(`${already.length} 个今天已经领过`)
          if (unavailable.length > 0) parts.push(`${unavailable.length} 个今天没有可领奖励`)
          if (failed.length > 0) parts.push(`${failed.length} 个失败`)
          setNotice({
            tone: failed.length > 0 ? 'error' : 'ok',
            text: parts.length > 0 ? `${parts.join('，')}。` : '本次没有新增积分。',
          })
          setProgressDone(rows.length)
        } catch (error) {
          if (alive.current) {
            setNotice({ tone: 'error', text: networkMessage(error) })
            // 请求整体失败时刷新一次，让界面回到服务端的真实状态，而不是停在乐观视图。
            void refresh().catch(() => {})
          }
        } finally {
          if (alive.current) {
            setBusy('')
            setPendingIds([])
          }
        }
      }, [selectedIds, refresh])

      const refreshAll = useCallback(async () => {
        if (accounts.length === 0) return
        setBusy('refresh')
        setNotice(null)
        try {
          const result = await call(
            '/refresh',
            { method: 'POST', body: JSON.stringify({}) },
            60_000 + 30_000 * accounts.length,
          )
          if (!alive.current) return
          setState(result.state)
          const rows = Array.isArray(result.rows) ? result.rows : []
          const failed = rows.filter((r) => r.status === 'failed')
          setNotice(
            failed.length > 0
              ? { tone: 'error', text: `已刷新 ${rows.length - failed.length} 个账号，${failed.length} 个失败。` }
              : { tone: 'ok', text: `已刷新 ${rows.length} 个账号的余额与今日状态。` },
          )
        } catch (error) {
          if (alive.current) setNotice({ tone: 'error', text: networkMessage(error) })
        } finally {
          if (alive.current) setBusy('')
        }
      }, [accounts.length])

      const testOne = useCallback(async (accountId) => {
        setBusy(`test:${accountId}`)
        setNotice(null)
        try {
          const result = await call('/account/test', { method: 'POST', body: JSON.stringify({ accountId }) })
          if (!alive.current) return
          setState(result.state)
          setNotice({
            tone: 'ok',
            text: result.claimedToday
              ? '登录正常，今天已经领过。'
              : result.available
                ? `登录正常，余额 ${result.balance ?? '—'}，今天还没领。`
                : '登录正常，但今天没有可领奖励。',
          })
        } catch (error) {
          if (alive.current) {
            setNotice({ tone: 'error', text: networkMessage(error) })
            void refresh().catch(() => {})
          }
        } finally {
          if (alive.current) setBusy('')
        }
      }, [refresh])

      const removeOne = useCallback(async (accountId, accountEmail) => {
        if (!window.confirm(`确定从账号池移除 ${accountEmail}？本机保存的密码会一起删除。`)) return
        setBusy(`remove:${accountId}`)
        setNotice(null)
        try {
          const next = await call('/account/remove', { method: 'POST', body: JSON.stringify({ accountId }) })
          if (!alive.current) return
          setState(next)
          setNotice({ tone: 'ok', text: `已移除 ${accountEmail}。` })
        } catch (error) {
          if (alive.current) setNotice({ tone: 'error', text: networkMessage(error) })
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      const addAccount = useCallback(async () => {
        if (email.trim() === '' || password === '') {
          setNotice({ tone: 'error', text: '邮箱和密码都要填。' })
          return
        }
        setBusy('add')
        setNotice(null)
        try {
          const result = await call('/account/add', {
            method: 'POST',
            body: JSON.stringify({ email: email.trim(), password, label: label.trim() }),
          })
          if (!alive.current) return
          setState(result.state)
          setEmail('')
          setPassword('')
          setLabel('')
          setNotice({ tone: 'ok', text: '账号已加入账号池。' })
        } catch (error) {
          if (alive.current) setNotice({ tone: 'error', text: networkMessage(error) })
        } finally {
          if (alive.current) setBusy('')
        }
      }, [email, password, label])

      const focusAddForm = useCallback(() => {
        formRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        emailRef.current?.focus?.()
      }, [])

      /* ------------------------------------------------------- 渲染 */

      const noticeBar = notice
        ? h(
            'p',
            {
              role: 'status',
              'aria-live': 'polite',
              style: {
                ...text(13, notice.tone === 'error' ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-state-success-primary)'),
                margin: 0,
              },
            },
            notice.text,
          )
        : null

      /** 添加账号表单。空池时置顶，有账号时放底部。 */
      const addForm = h(
        'form',
        {
          ref: formRef,
          style: card,
          onSubmit: (event) => {
            event.preventDefault()
            void addAccount()
          },
        },
        h('p', { style: subHeading }, accounts.length === 0 ? '添加第一个账号' : '添加账号'),
        h(
          'p',
          { style: muted },
          '密码只保存在本机凭据库，界面不回显，也不会出现在任何日志里。添加时会先登录验证一次，登不上的账号不入库。',
        ),
        // 自动换行：窄面板下按钮掉到下一行，而不是把输入框挤成一条缝。
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' } },
          h(
            'label',
            { style: { flex: '1 1 170px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: text(12, 'var(--dsw-alias-label-tertiary)') }, '邮箱'),
            h('input', {
              ref: emailRef,
              style: { ...control, opacity: busy !== '' ? 0.6 : 1 },
              type: 'email',
              placeholder: 'you@example.com',
              autoComplete: 'off',
              value: email,
              disabled: busy !== '',
              onChange: (event) => setEmail(event.target.value),
            }),
          ),
          h(
            'label',
            { style: { flex: '1 1 170px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: text(12, 'var(--dsw-alias-label-tertiary)') }, '密码'),
            h('input', {
              style: { ...control, opacity: busy !== '' ? 0.6 : 1 },
              type: 'password',
              placeholder: '站点登录密码',
              autoComplete: 'new-password',
              value: password,
              disabled: busy !== '',
              onChange: (event) => setPassword(event.target.value),
            }),
          ),
          h(
            'label',
            { style: { flex: '1 1 120px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: text(12, 'var(--dsw-alias-label-tertiary)') }, '备注（可选）'),
            h('input', {
              style: { ...control, opacity: busy !== '' ? 0.6 : 1 },
              type: 'text',
              placeholder: '方便自己认',
              value: label,
              disabled: busy !== '',
              onChange: (event) => setLabel(event.target.value),
            }),
          ),
          h(
            'button',
            { type: 'submit', style: { ...button('primary', busy !== ''), flex: '0 0 auto' }, disabled: busy !== '' },
            busy === 'add' ? '验证中…' : '添加账号',
          ),
        ),
      )

      if (state === null) {
        return h(
          'div',
          { style: column },
          h('h3', { style: heading }, 'Breeze 签到'),
          h('p', { style: muted }, loadError || '正在读取账号池…'),
          loadError
            ? h(
                'div',
                { style: rowBase },
                h(
                  'button',
                  { type: 'button', style: button(undefined, false), onClick: () => void refresh().catch(() => {}) },
                  '重试',
                ),
              )
            : null,
        )
      }

      return h(
        'div',
        { style: column, className: CLS },
        // 局部样式：内联样式表达不了 :focus-visible，键盘用户需要看得见焦点。
        h(
          'style',
          null,
          `.${CLS} button:focus-visible,.${CLS} input:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:2px}`,
        ),

        h('h3', { style: heading }, 'Breeze 签到'),
        h(
          'p',
          { style: bodyText },
          '把 Breeze Blue（breezeblue.ai）的开发者账号集中在这里，勾选后一键领取每日积分。每个账号每天最多领一次，服务端已领过的会直接跳过。',
        ),
        h('p', { style: muted }, '不点按钮就不会发出任何请求；没有定时任务，也不会自己领。'),

        // ---- 空池：先让用户能加账号，别让他先看一张没用的表 ----
        accounts.length === 0
          ? h(
              'div',
              { style: column },
              h(
                'div',
                { style: { ...card, alignItems: 'center', gap: 10, padding: 22 } },
                h('p', { style: bodyText }, '账号池还是空的。'),
                h('p', { style: muted }, '添加一个账号就能开始签到。'),
                h(
                  'button',
                  { type: 'button', style: button('primary', false), onClick: focusAddForm },
                  '添加第一个账号',
                ),
              ),
              addForm,
              noticeBar,
            )
          : h(
              'div',
              { style: column },

              // ---- 主操作 ----
              h(
                'div',
                { style: { ...rowBase, justifyContent: 'space-between' } },
                h('p', { style: subHeading }, '账号池'),
                h(
                  'div',
                  { style: rowBase },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: button('primary', busy !== '' || selectedIds.length === 0),
                      disabled: busy !== '' || selectedIds.length === 0,
                      onClick: () => void runCheckin(),
                    },
                    busy === 'checkin'
                      ? progressTotal > 0
                        ? `签到中 ${progressDone}/${progressTotal}`
                        : '签到中…'
                      : `签到勾选的账号${selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: button(undefined, busy !== ''),
                      disabled: busy !== '',
                      onClick: () => void refreshAll(),
                    },
                    busy === 'refresh' ? '刷新中…' : '刷新余额',
                  ),
                ),
              ),

              selectedIds.length === 0
                ? h('p', { style: muted }, '先在下面的表里勾选要签到的账号。')
                : null,

              noticeBar,

              // ---- 档位 ----
              h(
                'div',
                { style: card },
                h('p', { style: subHeading }, '领取档位'),
                h(
                  'div',
                  { style: rowBase },
                  ...[
                    ['discord', 'Discord 档'],
                    ['standard', '普通档'],
                  ].map(([value, labelText]) =>
                    h(
                      'label',
                      { key: value, style: { ...rowBase, fontSize: 13, cursor: 'pointer', gap: 6, flexWrap: 'nowrap' } },
                      h('input', {
                        type: 'radio',
                        name: 'breeze-tier',
                        checked: state.tier === value,
                        disabled: busy !== '',
                        onChange: () => void setTier(value),
                        style: { margin: 0, cursor: busy !== '' ? 'default' : 'pointer' },
                      }),
                      h('span', null, labelText),
                    ),
                  ),
                ),
                h(
                  'p',
                  { style: muted },
                  '站点通常给 Discord 档更高的额度（默认 400，普通档 100）。实际发放多少以服务端返回为准，界面只显示真正到账的数。选错档位不会报错，只是领得少。',
                ),
              ),

              // ---- 账号表 ----
              h(
                'div',
                { style: column },
                h(
                  'div',
                  { style: { ...rowBase, justifyContent: 'space-between' } },
                  h('p', { style: muted }, `已勾选 ${selectedIds.length} / ${accounts.length} 个账号`),
                  h(
                    'div',
                    { style: rowBase },
                    h(
                      'button',
                      { type: 'button', style: button(undefined, busy !== ''), disabled: busy !== '', onClick: () => selectAll(true) },
                      '全选',
                    ),
                    h(
                      'button',
                      { type: 'button', style: button(undefined, busy !== ''), disabled: busy !== '', onClick: () => selectAll(false) },
                      '全不选',
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: tableScroll },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: TABLE_MIN_WIDTH } },
                    // 表头：role 让屏幕阅读器能按行/列导航，而不只是一串文字。
                    h(
                      'div',
                      { style: tableHead, role: 'row' },
                      h('span', { role: 'columnheader' }),
                      h('span', { role: 'columnheader' }, '账号'),
                      h('span', { role: 'columnheader', style: { textAlign: 'right' } }, '积分'),
                      h('span', { role: 'columnheader' }, '状态'),
                      h('span', { role: 'columnheader', style: { textAlign: 'right' } }, '操作'),
                    ),
                    ...accounts.map((account) => {
                      const pending = pendingIds.includes(account.accountId)
                      // id 必须稳定且唯一，才能让 label 通过 htmlFor 关联到复选框。
                      const boxId = `${CLS}-pick-${account.accountId}`
                      return h(
                        'div',
                        { key: account.accountId, style: tableRow, role: 'row' },
                        h('input', {
                          id: boxId,
                          type: 'checkbox',
                          checked: account.enabled,
                          disabled: busy !== '',
                          onChange: (event) => toggle(account.accountId, event.target.checked),
                          'aria-label': `选择 ${account.email}`,
                          style: { margin: 0, cursor: busy !== '' ? 'default' : 'pointer' },
                        }),
                        // 账号格：邮箱 / 备注 / 上次签到。
                        // 用原生 htmlFor 关联复选框——点文字由浏览器转发到 input，
                        // 只触发一次 onChange，不需要手写 onClick 去猜点击落点。
                        h(
                          'label',
                          {
                            htmlFor: boxId,
                            style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, cursor: busy !== '' ? 'default' : 'pointer' },
                          },
                          h(
                            'span',
                            { style: { ...ellipsis, color: 'var(--dsw-alias-label-primary)', fontSize: 13 }, title: account.email },
                            account.email,
                          ),
                          account.label
                            ? h(
                                'span',
                                { style: { ...ellipsis, ...muted, fontSize: 12 }, title: account.label },
                                `· ${account.label}`,
                              )
                            : null,
                          h(
                            'span',
                            { style: { ...ellipsis, ...muted, fontSize: 12 } },
                            `上次签到 ${timeText(account.lastCheckinAtMs)}`,
                          ),
                        ),
                        h(
                          'span',
                          {
                            style: {
                              fontVariantNumeric: 'tabular-nums',
                              textAlign: 'right',
                              fontSize: 13,
                              color: 'var(--dsw-alias-label-primary)',
                              ...ellipsis,
                            },
                            title: account.balance === null || account.balance === undefined ? '' : String(account.balance),
                          },
                          account.balance === null || account.balance === undefined ? '—' : String(account.balance),
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                          h(
                            'span',
                            {
                              style: {
                                fontSize: 13,
                                ...ellipsis,
                                color: STATUS_COLOR[account.lastStatus] ?? 'var(--dsw-alias-label-secondary)',
                              },
                              title: account.lastMessage || '',
                            },
                            statusText(account, pending),
                          ),
                          // 失败原因允许换行：这是用户唯一能看到「为什么错、该怎么办」的地方，
                          // 用省略号截断等于把信息藏起来。
                          account.lastMessage
                            ? h(
                                'span',
                                {
                                  style: {
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    color:
                                      account.lastStatus === 'failed'
                                        ? 'var(--dsw-alias-label-error)'
                                        : 'var(--dsw-alias-label-tertiary)',
                                    whiteSpace: account.lastStatus === 'failed' ? 'normal' : 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    wordBreak: 'break-word',
                                  },
                                  title: account.lastMessage,
                                },
                                account.lastMessage,
                              )
                            : null,
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                          h(
                            'button',
                            {
                              type: 'button',
                              style: { ...tinyButton, opacity: busy !== '' ? 0.55 : 1, cursor: busy !== '' ? 'not-allowed' : 'pointer' },
                              disabled: busy !== '',
                              onClick: () => void testOne(account.accountId),
                            },
                            // 不改文字：文字一变按钮宽度就塌缩，「删除」会左移，双击容易点到删除。
                            busy === `test:${account.accountId}` ? '测试中' : '测试',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              style: { ...tinyButton, opacity: busy !== '' ? 0.55 : 1, cursor: busy !== '' ? 'not-allowed' : 'pointer' },
                              disabled: busy !== '',
                              onClick: () => void removeOne(account.accountId, account.email),
                            },
                            '删除',
                          ),
                        ),
                      )
                    }),
                  ),
                ),
              ),

              addForm,
            ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 42,
              label: () => 'Breeze 签到',
            },
            Page,
          ),
        )
      },
    }
  },
})
