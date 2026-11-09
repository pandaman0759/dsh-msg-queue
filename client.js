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

    /* ── 附件：字节存 IndexedDB（localStorage 放不下），条目里只留 {id,name,type} ── */

    const DB_NAME = 'dsh-msg-queue'
    const DB_STORE = 'images'
    /** 单个附件上限，超过就不收（宿主上传通道本身也有上限，这里只是先挡一道）。 */
    const MAX_FILE_BYTES = 16 * 1024 * 1024

    let dbPromise = null
    function openDb() {
      if (dbPromise) return dbPromise
      dbPromise = new Promise(function (resolve, reject) {
        let req
        try {
          if (!window.indexedDB) {
            reject(new Error('这个环境没有 IndexedDB'))
            return
          }
          req = window.indexedDB.open(DB_NAME, 1)
        } catch (err) {
          reject(err)
          return
        }
        req.onupgradeneeded = function () {
          const db = req.result
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
        }
        req.onsuccess = function () { resolve(req.result) }
        req.onblocked = function () { reject(new Error('IndexedDB 被另一个标签页占用')) }
        req.onerror = function () { reject(req.error || new Error('打不开 IndexedDB')) }
      })
      // 失败不要把失败的 promise 缓存住，下次还能重试
      dbPromise.catch(function () { dbPromise = null })
      return dbPromise
    }

    function dbRequest(mode, run) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(DB_STORE, mode)
          const store = tx.objectStore(DB_STORE)
          let result
          try {
            result = run(store)
          } catch (err) {
            reject(err)
            return
          }
          tx.oncomplete = function () { resolve(result && 'result' in result ? result.result : undefined) }
          tx.onerror = function () { reject(tx.error) }
          tx.onabort = function () { reject(tx.error) }
        })
      })
    }

    function putImage(id, record) {
      return dbRequest('readwrite', function (store) { return store.put(record, id) })
    }

    function getImage(id) {
      return dbRequest('readonly', function (store) { return store.get(id) })
    }

    function dropImages(ids) {
      if (!ids || ids.length === 0) return Promise.resolve()
      return dbRequest('readwrite', function (store) {
        for (const id of ids) store.delete(id)
      }).catch(function () { /* 删不掉只是占点空间 */ })
    }

    function normalizeImages(raw) {
      const out = []
      if (!Array.isArray(raw)) return out
      for (const entry of raw) {
        if (!entry || typeof entry.id !== 'string' || !entry.id) continue
        out.push({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name ? entry.name : 'image',
          type: typeof entry.type === 'string' && entry.type ? entry.type : 'image/png',
        })
      }
      return out
    }

    /* 缩略图 URL 缓存：同一个 id 只生成一次 objectURL（页面生命周期内有效）。 */
    const thumbUrls = new Map()

    function useThumbUrl(entry) {
      const [url, setUrl] = React.useState(function () { return thumbUrls.get(entry.id) || '' })
      React.useEffect(function () {
        let alive = true
        const cached = thumbUrls.get(entry.id)
        if (cached) {
          setUrl(cached)
          return undefined
        }
        getImage(entry.id).then(function (record) {
          if (!alive || !record || !record.blob) return
          const next = URL.createObjectURL(record.blob)
          thumbUrls.set(entry.id, next)
          setUrl(next)
        }).catch(function () { /* 图没了就只是不显示 */ })
        return function () { alive = false }
      }, [entry.id])
      return url
    }

    function isImageType(type) {
      return /^image\//.test(String(type || ''))
    }

    /** 非图片附件的角标：取扩展名，认不出就写 FILE。 */
    function fileExtLabel(name) {
      const raw = String(name || '')
      const dot = raw.lastIndexOf('.')
      if (dot > 0 && raw.length - dot <= 7) return raw.slice(dot + 1).toUpperCase().slice(0, 5)
      return 'FILE'
    }

    function Thumb(props) {
      const url = useThumbUrl(props.image)
      if (!isImageType(props.image.type)) {
        return h('span', {
          className: 'dsmq-thumb dsmq-file',
          title: props.image.name || '',
        }, h('span', { className: 'dsmq-file-ext' }, fileExtLabel(props.image.name)))
      }
      if (!url) return h('span', { className: 'dsmq-thumb dsmq-thumb-empty' }, '')
      return h('img', {
        className: 'dsmq-thumb',
        src: url,
        alt: props.image.name || '',
        title: props.image.name || '',
      })
    }

    function normalizeItems(raw) {
      const out = []
      if (!Array.isArray(raw)) return out
      for (const entry of raw) {
        if (!entry) continue
        const text = cleanText(typeof entry.text === 'string' ? entry.text : '')
        const images = normalizeImages(entry.images)
        if (!text && images.length === 0) continue
        out.push({
          id: typeof entry.id === 'string' && entry.id ? entry.id : uid(),
          text,
          images,
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
    function notify(text, durationMs) {
      patch({ notice: String(text || '') })
      if (noticeTimer) clearTimeout(noticeTimer)
      const ttl = typeof durationMs === 'number' && durationMs > 0 ? durationMs : NOTICE_MS
      noticeTimer = setTimeout(function () {
        noticeTimer = null
        patch({ notice: '' })
      }, ttl)
    }

    function setCollapsed(collapsed) {
      const value = !!collapsed
      patch({ collapsed: value })
      writeJson(UI_KEY, { collapsed: value })
    }

    function addItem(text, options) {
      const body = cleanText(text)
      const images = normalizeImages(options && options.images)
      if (!body && images.length === 0) return null
      const item = { id: uid(), text: body, images, at: Date.now() }
      patch({ items: snapshot.items.concat([item]), collapsed: false })
      writeJson(UI_KEY, { collapsed: false })
      if (!options || options.notice !== false) notify('已加入队列')
      return item
    }

    function updateItem(id, text, images) {
      const body = cleanText(text)
      const nextImages = images === undefined ? undefined : normalizeImages(images)
      if (!body && (!nextImages || nextImages.length === 0)) return
      patch({
        items: snapshot.items.map(function (item) {
          if (item.id !== id) return item
          const next = Object.assign({}, item, { text: body })
          if (nextImages) next.images = nextImages
          return next
        }),
      })
      notify('已更新')
    }

    function removeItem(id) {
      const target = snapshot.items.filter(function (item) { return item.id === id })[0]
      patch({ items: snapshot.items.filter(function (item) { return item.id !== id }) })
      if (target && target.images && target.images.length > 0) {
        const ids = target.images.map(function (image) { return image.id })
        for (const imageId of ids) {
          const url = thumbUrls.get(imageId)
          if (url) {
            try { URL.revokeObjectURL(url) } catch (err) { /* 忽略 */ }
            thumbUrls.delete(imageId)
          }
        }
        dropImages(ids)
      }
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
      Promise.resolve(sender.send(item.text, item.images)).then(function (accepted) {
        if (!accepted) return
        removeItem(id)
        notify('已发送')
        // 发出去就收起面板（点了「发送」就不用再点一次底部按钮）
        setCollapsed(true)
      }).catch(function (err) {
        notify('发送失败：' + String(err && err.message ? err.message : err))
      })
    }

    /* ══════════════════════════ ③ 投递器 ══════════════════════════ */

    const DRAFT_SELECTOR = function (state) {
      return state && typeof state.draft === 'string' ? state.draft : ''
    }

    const ATTACH_COUNT_SELECTOR = function (state) {
      return state && Array.isArray(state.attachmentIds) ? state.attachmentIds.length : 0
    }

    const PHASE_SELECTOR = function (state) {
      return state && typeof state.phase === 'string' ? state.phase : 'plain'
    }

    function readNothing() {
      return ''
    }

    function readZero() {
      return 0
    }

    function wait(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    /**
     * 找到当前会话的输入编辑区（Lexical 的 contenteditable，取面积最大的那个）。
     * 只用来给它派发 paste，不读它的内容、不改它的 DOM。
     */
    function composerEditor() {
      try {
        const nodes = document.querySelectorAll('[contenteditable="true"]')
        let best = null
        for (const node of nodes) {
          if (!node || !node.isConnected) continue
          const rect = node.getBoundingClientRect()
          if (rect.width < 40 || rect.height < 10) continue
          const area = rect.width * rect.height
          if (!best || area > best.area) best = { node, area }
        }
        return best ? best.node : null
      } catch (err) {
        return null
      }
    }

    function fileOfRecord(record, image) {
      try {
        const blob = record.blob
        if (!blob) return null
        const type = record.type || image.type || 'application/octet-stream'
        const name = record.name || image.name || 'image.png'
        return new File([blob], name, { type })
      } catch (err) {
        return null
      }
    }

    function useSenderRegistration(props, readDraft, readAttachCount, readPhase) {
      const actions = props.inputActions
      React.useEffect(function () {
        if (!actions
          || typeof actions.setDraft !== 'function'
          || typeof actions.submit !== 'function') {
          return undefined
        }
        return registerSender({
          /** @returns {Promise<boolean>} 是否已经真的提交出去。 */
          async send(text, images) {
            let draft = ''
            try {
              draft = String(readDraft() || '')
            } catch (err) {
              draft = ''
            }
            // 输入框里有草稿时先把它收进队列：绝不因为发一条队列消息而吞掉用户正在写的东西。
            if (draft.trim()) {
              addItem(draft, { notice: false })
              notify('输入框草稿已存入队列')
            }

            const expected = String(text || '')
            const list = Array.isArray(images) ? images : []
            const before = readAttachCount()

            if (list.length > 0) {
              // 官方没有"从别处往草稿里加附件"的公开 API（onAddFiles 只发给附件栏那一个座位），
              // 所以对编辑区派发一次合成 paste：它自己的粘贴上传路径会接住，走的是同一条校验/上传线。
              const editor = composerEditor()
              if (!editor) {
                notify('找不到输入框，这条先留在队列里')
                return false
              }
              let dispatched = 0
              for (const image of list) {
                let record = null
                try {
                  record = await getImage(image.id)
                } catch (err) {
                  record = null
                }
                if (!record || !record.blob) continue
                const file = fileOfRecord(record, image)
                if (!file) continue
                try {
                  const data = new DataTransfer()
                  data.items.add(file)
                  editor.dispatchEvent(new ClipboardEvent('paste', {
                    clipboardData: data,
                    bubbles: true,
                    cancelable: true,
                  }))
                  dispatched += 1
                } catch (err) {
                  /* 贴不进去就跳过这一张 */
                }
                await wait(120)
              }
              if (dispatched === 0) {
                notify('附件读不出来，这条先留在队列里')
                return false
              }
              const deadline = Date.now() + 6000
              while (Date.now() < deadline && readAttachCount() < before + dispatched) {
                await wait(80)
              }
              if (readAttachCount() < before + dispatched) {
                notify('附件没能自动附进输入框，这条先留在队列里')
                return false
              }
            }

            actions.setDraft(expected)
            await wait(SUBMIT_DELAY_MS)

            /* 附件是异步上传的：附件总数到齐 ≠ 上传完成，这时提交会被宿主拒绝
               （toast：one or more files have not finished uploading）。所以提交后看结果，
               没进去就等一会儿再提交一次；带附件时给更长的窗口（大文件上传慢）。 */
            const attempts = list.length > 0 ? 16 : 6
            for (let attempt = 0; attempt < attempts; attempt += 1) {
              try {
                actions.submit()
              } catch (err) {
                notify('发送失败：' + String(err && err.message ? err.message : err))
                return false
              }
              await wait(attempt === 0 ? 450 : 350)
              const phase = readPhase()
              if (phase !== 'plain') return true
              let now = ''
              try {
                now = String(readDraft() || '')
              } catch (err) {
                now = ''
              }
              if (now !== expected) return true
              if (readAttachCount() < before) return true
              if (attempt === attempts - 1) break
              await wait(250)
            }
            notify('没发出去（附件可能还在上传），这条先留在队列里')
            return false
          },
        })
      }, [actions, readDraft, readAttachCount, readPhase])
      return null
    }

    /** 输入机没有暴露草稿快照时的兜底：只发送，不碰草稿、不发图。 */
    function SenderPlain(props) {
      useSenderRegistration(props, readNothing, readZero, readPlainPhase)
      return null
    }

    function readPlainPhase() {
      return 'plain'
    }

    /** 正常路径：订阅当前会话的输入状态（草稿 + 附件数 + 提交相位），发送前保住草稿。 */
    function SenderWithDraft(props) {
      const draft = props.useInput(DRAFT_SELECTOR)
      const attachCount = props.useInput(ATTACH_COUNT_SELECTOR)
      const phase = props.useInput(PHASE_SELECTOR)
      const latestDraft = React.useRef('')
      latestDraft.current = draft
      const latestCount = React.useRef(0)
      latestCount.current = attachCount
      const latestPhase = React.useRef('plain')
      latestPhase.current = phase
      const readDraft = React.useRef(null)
      if (!readDraft.current) {
        readDraft.current = function () { return latestDraft.current }
      }
      const readCount = React.useRef(null)
      if (!readCount.current) {
        readCount.current = function () { return latestCount.current }
      }
      const readPhase = React.useRef(null)
      if (!readPhase.current) {
        readPhase.current = function () { return latestPhase.current }
      }
      useSenderRegistration(props, readDraft.current, readCount.current, readPhase.current)
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
      '.dsmq-input{width:100%;box-sizing:border-box;resize:none;min-height:54px;max-height:116px;padding:6px 9px;',
      'border-radius:8px;font-family:inherit;font-size:13px;line-height:20px;color:inherit;outline:none;',
      'transition:border-color .12s ease,box-shadow .12s ease;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff)}',
      '.dsmq-input:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
      '.dsmq-input:focus{border-color:var(--dsw-alias-brand-primary,#4d93f8);box-shadow:0 0 0 2px rgba(77,147,248,.18)}',
      '.dsmq-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a8)}',

      /* 输入框右下角的「+」：选图 → 存 IndexedDB → 缩略图挂在下面 */
      '.dsmq-field{position:relative;display:flex}',
      '.dsmq-input-draft{padding-right:32px}',
      '.dsmq-add{position:absolute;right:5px;bottom:5px;width:22px;height:22px;padding:0;border-radius:6px;',
      'display:flex;align-items:center;justify-content:center;cursor:pointer;font:14px/1 system-ui;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-base,#fff);',
      'color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-add:hover{color:var(--dsw-alias-label-primary,#1b1c20);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.5))}',
      '.dsmq-thumbs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}',
      '.dsmq-thumb-wrap{position:relative;display:block;width:44px;height:44px}',
      '.dsmq-thumb{display:block;width:44px;height:44px;object-fit:cover;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}',
      /* 非图片附件：一个方块里写扩展名，和缩略图同样大小 */
      '.dsmq-file{display:flex;align-items:center;justify-content:center;box-sizing:border-box}',
      '.dsmq-file-ext{font-size:10px;font-weight:600;letter-spacing:.3px;color:var(--dsw-alias-label-secondary,#5c626b)}',
      '.dsmq-thumb-x{position:absolute;top:-4px;right:-4px;width:16px;height:16px;padding:0;border-radius:8px;border:0;',
      'display:flex;align-items:center;justify-content:center;cursor:pointer;font:11px/1 system-ui;',
      'background:var(--dsw-alias-bg-layer-2,rgba(80,84,90,.9));color:var(--dsw-alias-label-primary,#fff)}',

      /* 每条做成一张轻卡片：浅底 + 1px 描边 + 圆角，跟上面输入框是一套语言 */
      '.dsmq-list{display:flex;flex-direction:column;gap:6px;max-height:156px;overflow:auto;margin:0 -2px;padding:0 2px}',
      '.dsmq-item{padding:6px 8px;border-radius:8px;transition:border-color .12s ease;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}',
      '.dsmq-item:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
      '.dsmq-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dsmq-meta{display:flex;align-items:center;justify-content:flex-end;gap:2px;margin-top:2px;',
      'opacity:.6;transition:opacity .12s ease}',
      '.dsmq-item:hover .dsmq-meta,.dsmq-item:focus-within .dsmq-meta{opacity:1}',
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
      const [staged, setStaged] = React.useState([])
      const [editingId, setEditingId] = React.useState('')
      const [editText, setEditText] = React.useState('')
      const [editImages, setEditImages] = React.useState([])
      const fileRef = React.useRef(null)

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

      function forgetImage(imageId) {
        const url = thumbUrls.get(imageId)
        if (url) {
          try { URL.revokeObjectURL(url) } catch (err) { /* 忽略 */ }
          thumbUrls.delete(imageId)
        }
        dropImages([imageId])
      }

      async function addFiles(fileList) {
        const files = Array.from(fileList || [])
        if (files.length === 0) return
        const next = staged.slice()
        let added = 0
        let lastError = ''
        for (const file of files) {
          if (!file) continue
          const type = file.type || ''
          if (file.size > MAX_FILE_BYTES) {
            lastError = '文件太大（上限 16MB）'
            continue
          }
          const entry = {
            id: 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: file.name || 'image',
            type: type || 'image/png',
          }
          try {
            await putImage(entry.id, { blob: file, name: entry.name, type: entry.type })
          } catch (err) {
            lastError = String(err && err.message ? err.message : err)
            continue
          }
          next.push(entry)
          added += 1
        }
        setStaged(next)
        if (added > 0) notify(added === 1 ? '附件已加入' : ('已加入 ' + added + ' 个附件'))
        else if (lastError) notify('存不下：' + lastError)
      }

      function commitDraft() {
        const text = cleanText(draft)
        if (!text && staged.length === 0) return
        addItem(text, { images: staged })
        setDraft('')
        setStaged([])
      }

      function imageStrip(images, onRemove) {
        if (!images || images.length === 0) return null
        return h('div', { className: 'dsmq-thumbs' }, images.map(function (image) {
          return h('span', { className: 'dsmq-thumb-wrap', key: image.id },
            h(Thumb, { image }),
            onRemove
              ? h('button', {
                type: 'button',
                className: 'dsmq-thumb-x',
                title: '移除这张图',
                onClick() { onRemove(image) },
              }, '×')
              : null
          )
        }))
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
                    if (!cleanText(editText) && editImages.length === 0) return
                    updateItem(item.id, editText, editImages)
                    setEditingId('')
                  }
                },
              }),
              imageStrip(editImages, function (image) {
                setEditImages(editImages.filter(function (entry) { return entry.id !== image.id }))
                forgetImage(image.id)
              }),
              h('div', { className: 'dsmq-meta' },
                h('button', {
                  type: 'button',
                  className: 'dsmq-link',
                  onClick() { setEditingId('') },
                }, '取消'),
                h('button', {
                  type: 'button',
                  className: 'dsmq-link dsmq-link-send',
                  disabled: !cleanText(editText) && editImages.length === 0,
                  onClick() {
                    updateItem(item.id, editText, editImages)
                    setEditingId('')
                  },
                }, '保存')
              )
            )
          }
          return h('div', { className: 'dsmq-item', key: item.id },
            item.text ? h('div', { className: 'dsmq-text', title: item.text }, item.text) : null,
            imageStrip(item.images, null),
            h('div', { className: 'dsmq-meta' },
              h('button', {
                type: 'button',
                className: 'dsmq-link',
                title: '编辑这条',
                onClick() {
                  setEditingId(item.id)
                  setEditText(item.text)
                  setEditImages(item.images || [])
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
        h('div', { className: 'dsmq-field' },
          h('textarea', {
            className: 'dsmq-input dsmq-input-draft',
            value: draft,
            placeholder: '想到什么先写这里，回车加入（Shift+回车换行）…',
            onChange(event) { setDraft(event.target.value) },
            onKeyDown(event) {
              if (isPlainEnter(event)) {
                event.preventDefault()
                commitDraft()
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsmq-add',
            title: '添加图片或文件',
            'aria-label': '添加图片或文件',
            onClick() { if (fileRef.current) fileRef.current.click() },
          }, '+'),
          h('input', {
            type: 'file',
            multiple: true,
            ref: fileRef,
            style: { display: 'none' },
            onChange(event) {
              // ⚠️ 先把 FileList 抄成数组再清空 value：清空会让 FileList 变空，
              // 之前就是"清完再读"→ 一张都读不到。
              const picked = Array.from(event.target.files || [])
              event.target.value = ''
              addFiles(picked)
            },
          })
        ),
        imageStrip(staged, function (image) {
          setStaged(staged.filter(function (entry) { return entry.id !== image.id }))
          forgetImage(image.id)
        }),
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
