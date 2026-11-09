/**
 * dsh-msg-queue —— 客户端半边
 *
 * 「左侧列表里的待发送队列」：工作中突然想到什么，先写进队列存着，不插队打断
 * 正在跑的任务；等合适的时机再点那一条的「发送」，它就以普通用户消息发给当前
 * 会话（等价于在输入框里打完再回车）。
 *
 * ── 为什么是"贴在左栏底部的分区"，而不是往左栏里插一个真的区块 ─────────────
 *
 * 这一版左栏（sidebar）里**没有**可增量的区块座位：`sidebar`、`sidebar.workspaces`
 * 都是 single + shadows-shipped-ui（注册即整块替换官方 UI，等于要把会话列表重写
 * 一遍），其余能挂的都是图标/动作（sidebar.panellist、sidebar.footer.action）。
 *
 * 所以做法是：容器仍挂在官方明确提供的"跨栏浮层"座位 `shell.overlay` 上，但**外观
 * 与位置完全按左栏来**——宽度、左边界、底边都从侧栏底部的那个原生按钮实测出来，
 * 背景用侧栏自己的填充色令牌（--dsw-specific-sidebar-fill），无圆角、无阴影、无
 * 侧边留白，只留一条上边框。视觉上它就是左栏列表最下面的一个分区，展开/收起只
 * 改变这一块的高度，不再是一个飘在中间的卡片。
 *
 * ── 三个插槽条目 ────────────────────────────────────────────────────────
 *
 *  ① `sidebar.footer.action`（root）── 左栏底部原生按钮：图标 + 计数角标，
 *     点它展开/收起队列；同时它也是②测量位置与宽度的锚点。侧栏收成 56px 轨道时
 *     点它会先把侧栏展开。
 *  ② `shell.overlay`（root）── 队列分区本体（位置/宽度按①实测贴边）。
 *  ③ `conversation.composer.dock`（session）── 零像素「投递器」，只为了拿到当前
 *     会话的 `inputActions`（setDraft / submit），root 作用域拿不到它。
 *
 * ── 数据 ────────────────────────────────────────────────────────────────
 *   队列存 localStorage（跨会话、跨重启都在），折叠状态一起记住。
 *   发送前若输入框里还有草稿，草稿会先被收进队列，绝不吞掉用户正在写的东西。
 */
window.__ModuleLoader__.load({
  id: 'dsh-msg-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ══════════════════════════ 持久化与状态 ══════════════════════════ */

    const ITEMS_KEY = 'dsh-msg-queue:items:v1'
    const UI_KEY = 'dsh-msg-queue:ui:v1'
    const NOTICE_MS = 2400
    /** setDraft 之后等编辑器状态落定的间隔（毫秒）。 */
    const SUBMIT_DELAY_MS = 30
    /** 左栏窄于这个宽度就是 56px 轨道形态：分区不展开，只留按钮上的角标。 */
    const RAIL_MAX_WIDTH = 100

    function uid() {
      return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return fallback
        return JSON.parse(raw)
      } catch (err) {
        return fallback
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (err) {
        /* 存不下只影响"下次还记不记得"，当前页面里照常可用 */
      }
    }

    function cleanText(value) {
      return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim()
    }

    function normalizeItems(raw) {
      const out = []
      if (!Array.isArray(raw)) return out
      for (const entry of raw) {
        if (!entry || typeof entry.text !== 'string') continue
        const text = cleanText(entry.text)
        if (!text) continue
        out.push({
          id: typeof entry.id === 'string' && entry.id ? entry.id : uid(),
          text,
          at: typeof entry.at === 'number' ? entry.at : Date.now(),
        })
      }
      return out
    }

    const uiRaw = readJson(UI_KEY, null)
    const initialItems = normalizeItems(readJson(ITEMS_KEY, []))
    let snapshot = {
      items: initialItems,
      /* 第一次进来：空队列就收成一行，有货才摊开。之后按用户自己的选择记忆。 */
      collapsed: uiRaw ? uiRaw.collapsed === true : initialItems.length === 0,
      canSend: false,
      notice: '',
      anchor: null,
    }
    const listeners = new Set()

    function emit() {
      for (const fn of Array.from(listeners)) {
        try {
          fn()
        } catch (err) {
          /* 单个监听器出错不影响别人 */
        }
      }
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }

    function patch(next) {
      snapshot = Object.assign({}, snapshot, next)
      if (next.items) writeJson(ITEMS_KEY, next.items)
      emit()
    }

    let noticeTimer = null
    function notify(text) {
      patch({ notice: String(text || '') })
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = setTimeout(function () {
        noticeTimer = null
        patch({ notice: '' })
      }, NOTICE_MS)
    }

    function setCollapsed(collapsed) {
      const value = !!collapsed
      patch({ collapsed: value })
      writeJson(UI_KEY, { collapsed: value })
    }

    function addItem(text, options) {
      const body = cleanText(text)
      if (!body) return null
      const item = { id: uid(), text: body, at: Date.now() }
      patch({ items: snapshot.items.concat([item]), collapsed: false })
      writeJson(UI_KEY, { collapsed: false })
      if (!options || options.notice !== false) notify('已加入队列')
      return item
    }

    function updateItem(id, text) {
      const body = cleanText(text)
      if (!body) return
      patch({
        items: snapshot.items.map(function (item) {
          return item.id === id ? Object.assign({}, item, { text: body }) : item
        }),
      })
      notify('已更新')
    }

    function removeItem(id) {
      patch({ items: snapshot.items.filter(function (item) { return item.id !== id }) })
    }

    /* ══════════════════════════ 左栏几何 ══════════════════════════ */

    /**
     * 从侧栏底部那个按钮往上爬，取"最宽但仍窄于 420px"的祖先当左栏本体，
     * 取"高度不超过 120px 的最外层祖先"当底部页脚行。
     * 返回 { left, width, bottom }：left/width 是左栏的水平范围，bottom 是页脚行
     * 顶边到视口底边的距离 —— 分区就贴在它上面。量不出来时返回 null。
     */
    function measureAnchor(node) {
      try {
        if (!node || typeof node.getBoundingClientRect !== 'function') return null
        let cur = node.parentElement
        let column = null
        let footerTop = null
        for (let depth = 0; depth < 10 && cur; depth += 1) {
          const rect = cur.getBoundingClientRect()
          if (rect.width > 420) break
          if (rect.width >= 40 && (!column || rect.width > column.width)) {
            column = { left: rect.left, width: rect.width }
          }
          if (rect.height > 0 && rect.height <= 120) footerTop = rect.top
          cur = cur.parentElement
        }
        if (!column) return null
        const fallbackTop = node.getBoundingClientRect().top
        const top = footerTop == null ? fallbackTop : footerTop
        const bottom = Math.max(0, Math.round(window.innerHeight - top))
        return {
          left: Math.round(column.left),
          width: Math.round(column.width),
          bottom,
        }
      } catch (err) {
        return null
      }
    }

    function publishAnchor(next) {
      const prev = snapshot.anchor
      if (prev && next
        && prev.left === next.left
        && prev.width === next.width
        && prev.bottom === next.bottom) return
      patch({ anchor: next })
    }

    /* ══════════════════════════ 发送桥 ══════════════════════════ */

    // 只有当前打开的会话才有的输入机；由 ③ 号条目在挂载时注册进来。
    let sender = null

    // 面板与底部按钮的真实 DOM 节点：判断"点到空白处"要不要收起时用。
    let footerEl = null
    let panelEl = null

    function registerSender(api) {
      sender = api
      patch({ canSend: true })
      return function () {
        if (sender !== api) return
        sender = null
        patch({ canSend: false })
      }
    }

    function sendItem(id) {
      const item = snapshot.items.filter(function (entry) { return entry.id === id })[0]
      if (!item) return
      if (!sender) {
        notify('先打开一个会话再发送')
        return
      }
      const preserved = sender.send(item.text)
      removeItem(id)
      if (!preserved) notify('已发送')
      // 发出去就收起面板（点了「发送」就不用再点一次底部按钮）
      setCollapsed(true)
    }

    /* ══════════════════════════ ③ 投递器 ══════════════════════════ */

    const DRAFT_SELECTOR = function (state) {
      return state && typeof state.draft === 'string' ? state.draft : ''
    }

    function readNothing() {
      return ''
    }

    function useSenderRegistration(props, readDraft) {
      const actions = props.inputActions
      React.useEffect(function () {
        if (!actions
          || typeof actions.setDraft !== 'function'
          || typeof actions.submit !== 'function') {
          return undefined
        }
        return registerSender({
          /** @returns {boolean} 是否顺手把输入框里的草稿存进了队列。 */
          send(text) {
            let draft = ''
            try {
              draft = String(readDraft() || '')
            } catch (err) {
              draft = ''
            }
            const preserved = !!draft.trim()
            // 输入框里有草稿时先把它收进队列：绝不因为发一条队列消息而吞掉用户正在写的东西。
            if (preserved) {
              addItem(draft, { notice: false })
              notify('输入框草稿已存入队列')
            }
            actions.setDraft(text)
            setTimeout(function () {
              try {
                actions.submit()
              } catch (err) {
                notify('发送失败：' + String(err && err.message ? err.message : err))
              }
            }, SUBMIT_DELAY_MS)
            return preserved
          },
        })
      }, [actions, readDraft])
      return null
    }

    /** 输入机没有暴露草稿快照时的兜底：只发送，不碰草稿。 */
    function SenderPlain(props) {
      useSenderRegistration(props, readNothing)
      return null
    }

    /** 正常路径：订阅当前会话的输入状态，发送前保住草稿。 */
    function SenderWithDraft(props) {
      const draft = props.useInput(DRAFT_SELECTOR)
      const latest = React.useRef('')
      latest.current = draft
      const readDraft = React.useRef(null)
      if (!readDraft.current) {
        readDraft.current = function () { return latest.current }
      }
      useSenderRegistration(props, readDraft.current)
      return null
    }

    function SenderEntry(props) {
      const Inner = typeof props.useInput === 'function' ? SenderWithDraft : SenderPlain
      return h(Inner, props)
    }

    /* ══════════════════════════ 公共小件 ══════════════════════════ */

    function useSnapshot() {
      const [, force] = React.useReducer(function (n) { return n + 1 }, 0)
      React.useEffect(function () { return subscribe(force) }, [])
      return snapshot
    }

    function formatTime(at) {
      try {
        return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      } catch (err) {
        return ''
      }
    }

    /* ══════════════════════════ ① 左栏底部按钮 ══════════════════════════ */

    /**
     * 回车 = 落地（加入/保存），Shift+回车 = 换行。
     * 中文输入法组字时那一下回车是"选词"，不能当提交 —— isComposing / keyCode 229 都挡掉。
     */
    function isPlainEnter(event) {
      if (!event || event.key !== 'Enter') return false
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
      const native = event.nativeEvent
      if (native && (native.isComposing === true || native.keyCode === 229)) return false
      return true
    }

    const LIST_ICON = h('svg', {
      width: 18,
      height: 18,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': true,
      style: { display: 'block' },
    },
      h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('rect', { x: 4, y: 5.2, width: 5.6, height: 1.3, rx: .65, fill: 'currentColor' }),
      h('rect', { x: 4, y: 7.6, width: 8, height: 1.3, rx: .65, fill: 'currentColor', opacity: .72 }),
      h('rect', { x: 4, y: 10, width: 4, height: 1.3, rx: .65, fill: 'currentColor', opacity: .48 })
    )

    function FooterButton(props) {
      const state = useSnapshot()
      const ref = React.useRef(null)
      const wide = props.wide !== false
      const count = state.items.length

      React.useEffect(function () {
        let raf = 0
        function apply() {
          raf = 0
          publishAnchor(measureAnchor(ref.current))
        }
        function schedule() {
          if (raf) return
          raf = window.requestAnimationFrame(apply)
        }
        schedule()
        window.addEventListener('resize', schedule)
        footerEl = ref.current
        return function () {
          window.removeEventListener('resize', schedule)
          if (raf) window.cancelAnimationFrame(raf)
          if (footerEl === ref.current) footerEl = null
        }
      }, [wide])

      function onClick() {
        const anchor = snapshot.anchor
        const rail = !anchor || anchor.width < RAIL_MAX_WIDTH
        if (rail) {
          // 轨道形态下先展开侧栏，再把队列摊开。
          try {
            const layout = typeof props.__layout === 'function' ? props.__layout() : null
            if (layout && typeof layout.toggleSidebar === 'function') layout.toggleSidebar()
          } catch (err) { /* 布局服务不在也照样展开分区 */ }
          setCollapsed(false)
          return
        }
        setCollapsed(!snapshot.collapsed)
      }

      // 样式表挂在"永远在场"的这个按钮上：面板收起时不渲染，样式也不能跟着消失，
      // 否则按钮会退回浏览器默认样式（文字被挤成两行就是这么来的）。
      return h(React.Fragment, null,
        STYLE_NODE,
        h('button', {
          ref,
          type: 'button',
          className: 'dsmq-foot',
          'data-rail': wide ? undefined : '1',
          'data-active': state.collapsed ? undefined : '1',
          title: state.collapsed ? '展开待发送队列' : '收起待发送队列',
          'aria-expanded': state.collapsed ? 'false' : 'true',
          onClick,
        },
          h('span', { className: 'dsmq-foot-icon' }, LIST_ICON),
          // 56px 轨道形态只留图标；宽栏按「用量/余额」的排版：左边标题，右边数量
          wide ? h('span', { className: 'dsmq-foot-label' }, '待发送') : null,
          wide && count > 0 ? h('span', { className: 'dsmq-foot-value' }, String(count)) : null
        )
      )
    }

    /* ══════════════════════════ ② 分区本体 ══════════════════════════ */

    // 颜色一律走官方设计令牌（--dsw-alias-* / --dsw-specific-*），浅色/深色自动跟随；
    // 回退值只是兜底。左栏自己用的是 --dsw-specific-sidebar-fill，分区跟它同色才像"长在里面"。
    const CSS = [
      /* 左栏底部的按钮：尺寸/圆角/内距/字号全部照抄 @ychris12138/dsh-usage-stats 的
         `.usg_badge`（lib/client.js 第 69–78 行）：高 42、圆角 12、padding 0 10px 0 8px、
         gap 8、字号 14、数量用 12px/600 次要色；轨道形态 36×36 圆形。
         底色用它 hover 用的那个令牌（--dsw-alias-interactive-bg-hover）常驻，所以平时就是浅灰。 */
      '.dsmq-foot{box-sizing:border-box;width:100%;height:42px;margin:4px 0;display:inline-flex;align-items:center;',
      'gap:8px;padding:0 10px 0 8px;border:none;border-radius:12px;overflow:hidden;cursor:pointer;text-align:left;',
      'color:var(--dsw-alias-label-primary,#1b1c20);font-family:inherit;font-size:14px;background:0 0}',
      /* 平时透明，悬停或面板展开时才是浅灰 —— 与 usage-stats 的 .usg_badge:hover / [data-active] 同款 */
      '.dsmq-foot:hover,.dsmq-foot[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}',
      '.dsmq-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d93f8);outline-offset:2px}',
      '.dsmq-foot[data-rail]{justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0;border-radius:50%}',
      '.dsmq-foot-icon{flex:none;display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:inherit}',
      '.dsmq-foot[data-rail] .dsmq-foot-icon{width:18px;height:18px}',
      '.dsmq-foot-icon svg{display:block;width:100%;height:100%}',
      '.dsmq-foot-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsmq-foot-value{flex:none;color:var(--dsw-alias-label-secondary,#5c626b);font-variant-numeric:tabular-nums;',
      'font-size:12px;font-weight:600;line-height:16px}',

      /* 分区本体：贴左栏底边，等宽、同色、无圆角无阴影，只有一条上边框 */
      '.dsmq{position:fixed;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;',
      'pointer-events:auto;overflow:hidden;border-radius:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));',
      'background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));',
      'color:var(--dsw-alias-label-primary,#1b1c20);font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',

      '.dsmq-body{display:flex;flex-direction:column;gap:6px;padding:8px 10px 9px}',
      '.dsmq-input{width:100%;box-sizing:border-box;resize:vertical;min-height:48px;max-height:120px;',
      'padding:5px 7px;border-radius:6px;font:inherit;color:inherit;outline:none;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));',
      'background:var(--dsw-alias-bg-base,#fff)}',
      '.dsmq-input:focus{border-color:var(--dsw-alias-brand-primary,#4d93f8)}',
      '.dsmq-input::placeholder{color:var(--dsw-alias-label-secondary,#9aa0a8)}',

      '.dsmq-row{display:flex;align-items:center;gap:6px}',
      '.dsmq-hint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-btn{box-sizing:border-box;padding:2px 8px;border-radius:6px;font:inherit;color:inherit;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.32));background:transparent}',
      '.dsmq-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.dsmq-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsmq-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d93f8);color:#fff}',
      '.dsmq-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d93f8);filter:brightness(1.07)}',

      /* 列表条目做成侧栏行的样子：无卡片边框，悬停才浮出背景 */
      /* 最多露两条，再多就在这一块里滚动，绝不越滚越长 */
      '.dsmq-list{display:flex;flex-direction:column;gap:1px;max-height:156px;overflow:auto;margin:0 -4px}',
      '.dsmq-item{padding:4px 5px;border-radius:6px}',
      '.dsmq-item:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}',
      '.dsmq-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dsmq-meta{display:flex;align-items:center;gap:2px;margin-top:3px;opacity:.6;transition:opacity .12s ease}',
      '.dsmq-item:hover .dsmq-meta,.dsmq-item:focus-within .dsmq-meta{opacity:1}',
      '.dsmq-time{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-link{padding:1px 5px;border:0;border-radius:5px;background:transparent;color:inherit;',
      'font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-link:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#1b1c20)}',
      '.dsmq-link:disabled{opacity:.45;cursor:not-allowed}',
      '.dsmq-link-send{color:var(--dsw-alias-brand-primary,#4d93f8);font-weight:600}',
      '.dsmq-empty{padding:3px 2px;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-notice{font-size:11px;color:var(--dsw-alias-state-warn-primary,#c07f00)}',
    ].join('')

    const STYLE_NODE = h('style', { dangerouslySetInnerHTML: { __html: CSS } })

    function QueuePanel() {
      const state = useSnapshot()
      const [draft, setDraft] = React.useState('')
      const [editingId, setEditingId] = React.useState('')
      const [editText, setEditText] = React.useState('')

      const anchor = state.anchor
      const items = state.items

      // 展开期间：点到面板和底部按钮之外的任何地方（空白处/对话/别的面板）都自动收起。
      React.useEffect(function () {
        if (state.collapsed) {
          panelEl = null
          return undefined
        }
        function onPointerDown(event) {
          const target = event.target
          if (panelEl && panelEl.contains(target)) return
          if (footerEl && footerEl.contains(target)) return
          setCollapsed(true)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
          panelEl = null
        }
      }, [state.collapsed])

      // 左栏收成 56px 轨道时，分区不占位（角标在①号按钮上），也不至于把文字挤成竖排。
      // 收起来时同样什么都不画：开关与计数都在①号那个左栏底部按钮上，这里不再重复一行标题。
      if (!anchor || anchor.width < RAIL_MAX_WIDTH || state.collapsed) return null

      function commitDraft() {
        if (!cleanText(draft)) return
        addItem(draft)
        setDraft('')
      }

      const frameStyle = {
        left: anchor.left + 'px',
        width: anchor.width + 'px',
        bottom: anchor.bottom + 'px',
      }

      const list = items.length === 0
        ? h('div', { className: 'dsmq-empty' }, '队列是空的：想到什么先写上面那格')
        : items.map(function (item) {
          if (item.id === editingId) {
            return h('div', { className: 'dsmq-item', key: item.id },
              h('textarea', {
                className: 'dsmq-input',
                value: editText,
                autoFocus: true,
                onChange(event) { setEditText(event.target.value) },
                onKeyDown(event) {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditingId('')
                    return
                  }
                  if (isPlainEnter(event)) {
                    event.preventDefault()
                    updateItem(item.id, editText)
                    setEditingId('')
                  }
                },
              }),
              h('div', { className: 'dsmq-meta' },
                h('span', { className: 'dsmq-time' }, '回车保存 · Shift+回车换行'),
                h('button', {
                  type: 'button',
                  className: 'dsmq-link',
                  onClick() { setEditingId('') },
                }, '取消'),
                h('button', {
                  type: 'button',
                  className: 'dsmq-link dsmq-link-send',
                  disabled: !cleanText(editText),
                  onClick() {
                    updateItem(item.id, editText)
                    setEditingId('')
                  },
                }, '保存')
              )
            )
          }
          return h('div', { className: 'dsmq-item', key: item.id },
            h('div', { className: 'dsmq-text', title: item.text }, item.text),
            h('div', { className: 'dsmq-meta' },
              h('span', { className: 'dsmq-time' }, formatTime(item.at)),
              h('button', {
                type: 'button',
                className: 'dsmq-link',
                title: '编辑这条',
                onClick() {
                  setEditingId(item.id)
                  setEditText(item.text)
                },
              }, '编辑'),
              h('button', {
                type: 'button',
                className: 'dsmq-link',
                title: '删除这条',
                onClick() {
                  removeItem(item.id)
                  notify('已删除')
                },
              }, '删'),
              h('button', {
                type: 'button',
                className: 'dsmq-link dsmq-link-send',
                disabled: !state.canSend,
                title: state.canSend ? '发送到当前会话' : '先打开一个会话',
                onClick() { sendItem(item.id) },
              }, '发送')
            )
          )
        })

      const body = h('div', { className: 'dsmq-body' },
        h('textarea', {
          className: 'dsmq-input',
          value: draft,
          placeholder: '想到什么先写这里，合适的时机再发送…',
          onChange(event) { setDraft(event.target.value) },
          onKeyDown(event) {
            if (isPlainEnter(event)) {
              event.preventDefault()
              commitDraft()
            }
          },
        }),
        h('div', { className: 'dsmq-row' },
          h('span', { className: 'dsmq-hint' }, '回车加入 · Shift+回车换行'),
          h('button', {
            type: 'button',
            className: 'dsmq-btn dsmq-btn-primary',
            disabled: !cleanText(draft),
            onClick: commitDraft,
          }, '加入')
        ),
        h('div', { className: 'dsmq-list' }, list),
        state.notice ? h('div', { className: 'dsmq-notice' }, state.notice) : null
      )

      return h('div', {
        className: 'dsmq',
        style: frameStyle,
        ref(node) { panelEl = node },
      }, STYLE_NODE, body)
    }

    /* ══════════════════════════ 注册 ══════════════════════════ */

    const inject = ['slots']

    function apply(ctx) {
      // 布局服务按需取：apply 时它可能还没就绪，点击时才取就一定拿得到。
      function readLayout() {
        try {
          return typeof ctx.get === 'function' ? ctx.get('layout') : null
        } catch (err) {
          return null
        }
      }

      function FooterWithLayout(props) {
        return h(FooterButton, Object.assign({}, props, { __layout: readLayout }))
      }

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({ name: 'sidebar.footer.action', id: 'msg-queue', order: 20 }, FooterWithLayout)
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'msg-queue', order: 60 }, QueuePanel)
      })
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({ name: 'conversation.composer.dock', id: 'msg-queue-sender', order: 90 }, SenderEntry)
      })
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
