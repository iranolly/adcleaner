/* AdCleaner tools/stub-dom.mjs —— 自测共享桩 DOM / 虚拟时钟 / 迷你选择器引擎
 * =============================================================================
 * 交付物（由 .cache/ 临时脚本迁移而来）：tools/selftest-guard-iso.mjs 与
 * tools/selftest-userscript.mjs 共用，零依赖、不联网。
 *
 * 设计要点：
 *   - 只实现状态机真正用到的 DOM 子集（querySelector/All、closest、style、dataset、
 *     addEventListener、offsetParent、getComputedStyle…），选择器引擎支持
 *     tag/.class/#id/[attr(=|^= $= *=)]/:not()/:has()/后代（> 与空格等价）；
 *   - 「我们注入的 display:none 样式」用 refreshCssHidden() 真实回放到元素的
 *     _cssHidden 标记上，因此隐藏层判定走的是与浏览器一致的 getComputedStyle/offsetParent 路径
 *     （而不是在测试里直接断言内部标志）；
 *   - 虚拟时钟 createClock() 让 setInterval/setTimeout 的推进完全可控（可测 300s 级安全阀）；
 *     onError 回调可暴露定时器内异常（默认静默，与浏览器一致）。
 */

export function splitTop(text, sep) {
  const out = [];
  let buf = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}
function readParen(s, start) {
  let depth = 1, i = start;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  return { text: s.slice(start, i), next: i + 1 };
}
function classList(el) { return String(el.className || '').split(/\s+/).filter(Boolean); }
export function matchSimple(el, sel) {
  let s = sel.trim();
  if (!s || el.nodeType !== 1) return false;
  let i = 0;
  const tagM = /^([a-zA-Z][\w-]*|\*)/.exec(s);
  if (tagM) {
    if (tagM[1] !== '*' && el.tagName !== tagM[1].toUpperCase()) return false;
    i = tagM[0].length;
  }
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (!m || !classList(el).includes(m[1])) return false;
      i += m[0].length;
    } else if (ch === '#') {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (!m || el.id !== m[1]) return false;
      i += m[0].length;
    } else if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return false;
      const body = s.slice(i + 1, end);
      const eq = body.search(/[~^$*|]?=/);
      let name = body, op = null, want = null;
      if (eq >= 0) {
        const opM = /([~^$*|]?)=/.exec(body);
        name = body.slice(0, eq);
        op = opM[1] + '=';
        want = body.slice(eq + opM[0].length).replace(/^"|"$/g, '');
      }
      const val = el.getAttribute(name);
      if (val === null) return false;
      if (op === '=' && val !== want) return false;
      if (op === '^=' && !val.startsWith(want)) return false;
      if (op === '$=' && !val.endsWith(want)) return false;
      if (op === '*=' && !val.includes(want)) return false;
      i = end + 1;
    } else if (s.startsWith(':not(', i)) {
      const inner = readParen(s, i + 5);
      if (!inner) return false;
      if (matchSelector(el, inner.text)) return false;
      i = inner.next;
    } else if (s.startsWith(':has(', i)) {
      const inner = readParen(s, i + 5);
      if (!inner) return false;
      if (!descendants(el).some((d) => matchSelector(d, inner.text))) return false;
      i = inner.next;
    } else {
      return false;
    }
  }
  return true;
}
export function matchComplex(el, sel) {
  const parts = splitTop(sel.trim().replace(/\s*>\s*/g, ' '), ' ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el;
  for (let i = parts.length - 2; i >= 0; i--) {
    let p = node.parentNode, found = false;
    while (p && p.nodeType === 1) {
      if (matchSimple(p, parts[i])) { found = true; break; }
      p = p.parentNode;
    }
    if (!found) return false;
    node = p;
  }
  return true;
}
export function matchSelector(el, sel) {
  return splitTop(sel, ',').some((part) => matchComplex(el, part));
}
export function descendants(el) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes || []) { if (c.nodeType === 1) { out.push(c); walk(c); } } };
  walk(el);
  return out;
}

export class El {
  constructor(tag, doc, opts = {}) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._attrs = new Map();
    this._styleProps = {};
    this._text = opts.text || '';
    this.dataset = {};
    this._className = opts.className || '';
    this.id = opts.id || '';
    this.disabled = false;
    this._cssHidden = false;
    this._listeners = {};
    this.clickCount = 0;
    this._rate = 1;
    this.muted = false;
    this.paused = false;
    this.ended = false;
    this.readyState = 4;
    this.duration = 600;
    this.currentTime = 0;
    const self = this;
    this.style = {
      setProperty(k, v) { self._styleProps[k] = String(v); },
      removeProperty(k) { delete self._styleProps[k]; },
      getPropertyValue(k) { return self._styleProps[k] || ''; },
      get display() { return self._styleProps.display || ''; },
      set display(v) { self._styleProps.display = String(v); }
    };
    Object.defineProperty(this, 'playbackRate', {
      configurable: true,
      get() { return this._rate; },
      set(v) { this._rate = Number(v); this._fire('ratechange'); }
    });
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() {
    let out = this._text || '';
    for (const c of this.childNodes) out += c.nodeType === 1 ? c.textContent : (c._nodeValue || '');
    return out;
  }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  set className(v) { this._className = String(v); }
  get className() { return this._className || ''; }
  hiddenChain() {
    let n = this;
    while (n && n.nodeType === 1) {
      if (n._cssHidden || n._styleProps.display === 'none') return true;
      n = n.parentNode;
    }
    return false;
  }
  get offsetParent() {
    if (this.hiddenChain()) return null;
    if (this._styleProps.position === 'fixed') return null;   // 与 Chrome 一致：fixed 元素 offsetParent 为 null
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  hasAttribute(k) { return this._attrs.has(k); }
  removeAttribute(k) { this._attrs.delete(k); }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (matchSelector(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelectorAll(sel) { return descendants(this).filter((e) => matchSelector(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  _fire(type) { for (const fn of (this._listeners[type] || []).slice()) { try { fn.call(this, { type }); } catch (e) { /* 忽略 */ } } }
  click() { this.clickCount++; }
}

/** 便捷构造：等价于 new El(tag, doc, opts) */
export function makeEl(tag, doc, opts = {}) { return new El(tag, doc, opts); }

export function createDom() {
  const doc = {
    nodeType: 9,
    head: null, body: null, documentElement: null,
    visibilityState: 'visible',
    hidden: false,
    _listeners: {},
    createElement: (tag) => new El(tag, doc),
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = doc._listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);      // 真实移除：供 stopAll() 监听器泄漏回归测试断言
    }
  };
  const html = new El('html', doc);
  const head = new El('head', doc);
  const body = new El('body', doc);
  html.appendChild(head); html.appendChild(body);
  doc.documentElement = html; doc.head = head; doc.body = body;
  doc.all = () => [html, ...descendants(html)];
  doc.querySelectorAll = (sel) => doc.all().filter((e) => matchSelector(e, sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  return doc;
}

export function getComputedStyle(el) {
  const hidden = el.hiddenChain();
  return {
    display: hidden ? 'none' : 'block',
    visibility: 'visible',
    position: el._styleProps.position || 'static'
  };
}

/** 虚拟时钟：startAt 可指定起点；onError 可上报定时器回调抛出的异常（默认静默） */
export function createClock(startAt = 1700000000000, onError = null) {
  let now = startAt;
  let seq = 1;
  const tasks = new Map();
  function schedule(fn, delay, interval) {
    const id = seq++;
    tasks.set(id, { fn, time: now + Math.max(0, Number(delay) || 0), interval: interval ? Math.max(1, Number(delay) || 1) : 0 });
    return id;
  }
  return {
    now: () => now,
    setInterval: (fn, d) => schedule(fn, d, true),
    setTimeout: (fn, d) => schedule(fn, d, false),
    clear: (id) => tasks.delete(id),
    count: (interval) => [...tasks.values()].filter((t) => !!t.interval === interval).length,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let bestId = null, bestTime = Infinity;
        for (const [id, t] of tasks) if (t.time <= end && t.time < bestTime) { bestTime = t.time; bestId = id; }
        if (bestId === null) break;
        const t = tasks.get(bestId);
        now = Math.max(now, t.time);
        if (t.interval) t.time = now + t.interval; else tasks.delete(bestId);
        try { t.fn(); } catch (e) { if (onError) onError(e); }
      }
      now = end;
    }
  };
}

/** 模拟「我们注入的 display:none 样式确实生效」：把每条 data-adcleaner 样式里的
 *  display:none 规则回放到 _cssHidden 标记（含 cosmetic.css 静态注入与逐条等价 CSS）。 */
export function refreshCssHidden(dom) {
  for (const e of dom.all()) e._cssHidden = false;
  for (const st of dom.all()) {
    if (st.tagName !== 'STYLE' || st.getAttribute('data-adcleaner') !== '1') continue;
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(st.textContent))) {
      if (!/display\s*:\s*none/.test(m[2])) continue;
      for (const sel of m[1].split(',')) {
        const s = sel.trim();
        if (!s) continue;
        for (const e of dom.all()) if (matchSelector(e, s)) e._cssHidden = true;
      }
    }
  }
}
