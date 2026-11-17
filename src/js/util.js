/* ==========================================================================
   util.js — 基础工具、图标、DOM 构建、浮层（toast / modal / popover）
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  /* ---------------------------- 选择器与数学 ---------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /** 数字显示：最多 digits 位小数，去掉多余的 0 */
  function fmt(n, digits) {
    if (digits === undefined) digits = 3;
    if (!isFinite(n)) return String(n);
    const s = n.toFixed(digits);
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hexToRgb01(hex) {
    let h = String(hex || '#000000').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h.slice(0, 6), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgb01ToHex(r, g, b) {
    const c = (v) => pad2(clamp(Math.round(v * 255), 0, 255).toString(16));
    return '#' + c(r) + c(g) + c(b);
  }
  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  }

  let uidCounter = 0;
  const uid = (p) => (p || 'id') + '_' + (++uidCounter) + '_' + Math.random().toString(36).slice(2, 7);

  function debounce(fn, ms) {
    let t = null;
    const wrapped = function () {
      const args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(self, args); }, ms);
    };
    wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
    wrapped.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return wrapped;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function deepClone(o) {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    const out = {};
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
    return out;
  }

  /* ------------------------------ DOM 构建 ------------------------------ */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const kids = [];
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach((cc) => {
        if (cc == null || cc === false) return;
        kids.push(cc);
      });
    }
    kids.forEach((c) => el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c));
    return el;
  }
  const frag = function () {
    const f = document.createDocumentFragment();
    for (let i = 0; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null) continue;
      (Array.isArray(c) ? c : [c]).forEach((x) => f.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    }
    return f;
  };

  /* -------------------------------- 图标 -------------------------------- */
  const ICONS = {
    play: '<path d="M7 4.6v14.8L19.5 12z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
    step: '<path d="M6 4.8v14.4L16.4 12z" fill="currentColor" stroke="none"/><rect x="17.4" y="4.8" width="1.8" height="14.4" rx=".9" fill="currentColor" stroke="none"/>',
    reset: '<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.55L3 8.2"/><path d="M3 3.6v4.9h4.9"/>',
    camera: '<path d="M14.6 4.2h-5.2L7.9 6.4H4.2A1.7 1.7 0 0 0 2.5 8.1v9.2a1.7 1.7 0 0 0 1.7 1.7h15.6a1.7 1.7 0 0 0 1.7-1.7V8.1a1.7 1.7 0 0 0-1.7-1.7h-3.7z"/><circle cx="12" cy="12.6" r="3.5"/>',
    download: '<path d="M12 3.5v11.8"/><path d="M7.4 10.9 12 15.5l4.6-4.6"/><path d="M3.8 19.6h16.4"/>',
    upload: '<path d="M12 20.5V8.7"/><path d="M7.4 13.1 12 8.5l4.6 4.6"/><path d="M3.8 4.4h16.4"/>',
    help: '<circle cx="12" cy="12" r="8.8"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.5 2.35c-.7.35-1.1.95-1.1 1.85"/><circle cx="12" cy="16.9" r=".95" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
    eye: '<path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="2.9"/>',
    eyeOff: '<path d="M2.2 12S5.8 5.6 12 5.6c1.7 0 3.2.5 4.5 1.2"/><path d="M21.8 12S18.2 18.4 12 18.4c-1.7 0-3.2-.5-4.5-1.2"/><path d="M4 20 20 4"/>',
    trash: '<path d="M4 7h16"/><path d="M9.2 7V4.2h5.6V7"/><path d="M6.2 7l1 12.8h9.6L17.8 7"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.2"/><path d="M15.5 5.5v-.8a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h.8"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    alert: '<path d="M12 3.4 21.4 20H2.6z"/><path d="M12 9.4v4.6"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    image: '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.2"/><circle cx="8.6" cy="9.9" r="1.7"/><path d="m3.6 17.4 5.2-4.8 4 3.6 2.8-2.4 4.8 4.2"/>',
    refresh: '<path d="M20.8 12a8.8 8.8 0 1 1-2.9-6.55L21 8.2"/><path d="M21 3.6v4.9h-4.9"/>',
    zoomIn: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="M16.2 16.2 21 21"/><path d="M10.8 7.8v6"/><path d="M7.8 10.8h6"/>',
    zoomOut: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="M16.2 16.2 21 21"/><path d="M7.8 10.8h6"/>',
    fit: '<path d="M9 3.6H3.6V9"/><path d="M15 3.6h5.4V9"/><path d="M15 20.4h5.4V15"/><path d="M9 20.4H3.6V15"/>',
    square: '<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="2"/>',
    info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11v5.4"/><circle cx="12" cy="7.8" r=".95" fill="currentColor" stroke="none"/>',
    sliders: '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>',
    code: '<path d="M8.5 7.5 3.8 12l4.7 4.5"/><path d="M15.5 7.5 20.2 12l-4.7 4.5"/><path d="M13.4 4.5 10.6 19.5"/>',
    folderPlus: '<path d="M20.4 12.4V7.9a1.8 1.8 0 0 0-1.8-1.8h-5l-2-2.2H5.2a1.8 1.8 0 0 0-1.8 1.8v12.2a1.8 1.8 0 0 0 1.8 1.8h6"/><path d="M17.6 14.6v6"/><path d="M14.6 17.6h6"/>',
    more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    up: '<path d="M12 19V5"/><path d="M6.5 10.5 12 5l5.5 5.5"/>',
    down: '<path d="M12 5v14"/><path d="M6.5 13.5 12 19l5.5-5.5"/>',
    save: '<path d="M5.6 3.8h9.6l4.9 4.9v11a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19.7V5.4a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M8.2 3.8v5.4h6.4V3.8"/><rect x="8.2" y="13.4" width="7.6" height="6.2" rx=".8"/>',
    chevronDown: '<path d="M6 9.5 12 15.5 18 9.5"/>',
    bolt: '<path d="M13.2 2.8 5 13.4h5.6L10.2 21 19 10.4h-5.8z"/>',
    grid: '<rect x="4" y="4" width="6.4" height="6.4" rx="1.4"/><rect x="13.6" y="4" width="6.4" height="6.4" rx="1.4"/><rect x="4" y="13.6" width="6.4" height="6.4" rx="1.4"/><rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1.4"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7v5.4l3.4 2"/>',
    dice: '<rect x="3.8" y="3.8" width="16.4" height="16.4" rx="3.2"/><circle cx="8.6" cy="8.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.6 20.6"/>',
    split: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2"/><path d="M12 4.6v14.8"/><path d="M3.4 12h8.6" opacity=".45"/>',
    zen: '<path d="M9 3.6H3.6V9"/><path d="M15 3.6h5.4V9"/><path d="M15 20.4h5.4V15"/><path d="M9 20.4H3.6V15"/><path d="M7.2 12h9.6"/>',
    keyboard: '<rect x="2.6" y="6.4" width="18.8" height="11.2" rx="2.2"/><path d="M6.4 10h.02M9.6 10h.02M12.8 10h.02M16 10h.02M6.4 13.6h.02M17.6 13.6h.02"/><path d="M9.6 13.9h4.8"/>',
    chevronUp: '<path d="M6 14.5 12 8.5 18 14.5"/>',
    corner: '<path d="M20 5v6.2a2.8 2.8 0 0 1-2.8 2.8H5"/><path d="M8.6 10.4 5 14l3.6 3.6"/>'
  };

  /**
   * 生成内联 SVG 图标。
   * @param {string} name ICONS 的键
   * @param {number} [size=14]
   * @param {string} [cls]
   */
  function icon(name, size, cls) {
    const body = ICONS[name];
    if (!body) return '';
    size = size || 14;
    return '<svg class="ic ' + (cls || '') + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function iconEl(name, size, cls) {
    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = icon(name, size, cls);
    return wrap;
  }

  /* ----------------------------- 浮层管理 ----------------------------- */
  const overlays = [];

  function registerOverlay(o) {
    overlays.push(o);
    return o;
  }
  function unregisterOverlay(o) {
    const i = overlays.indexOf(o);
    if (i >= 0) overlays.splice(i, 1);
  }
  function closeTopOverlay() {
    const top = overlays[overlays.length - 1];
    if (top) { top.close(); return true; }
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // 编辑器内 Esc 交给编辑器处理；浮层优先
    if (overlays.length) {
      e.preventDefault();
      closeTopOverlay();
    }
  }, true);

  document.addEventListener('pointerdown', function (e) {
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      if (o.type === 'modal') continue;
      if (o.el && o.el.contains(e.target)) continue;
      if (o.anchor && o.anchor.contains(e.target)) continue;
      o.close();
    }
  }, true);

  /* -------------------------------- toast -------------------------------- */
  function toast(msg, type, action) {
    const wrap = $('#toast-wrap');
    if (!wrap) return;
    type = type || 'info';
    const ic = type === 'bad' ? 'alert' : type === 'ok' ? 'check' : 'info';
    const el = h('div', { class: 'toast ' + type, role: 'status' });
    el.innerHTML = '<span class="ic">' + icon(ic, 13) + '</span><span class="tx"></span>';
    el.querySelector('.tx').textContent = msg;
    if (action && action.label) {
      const b = h('button', { class: 'btn tiny', style: 'margin-left:6px', text: action.label });
      b.onclick = () => { action.fn && action.fn(); dismiss(); };
      el.appendChild(b);
    }
    wrap.appendChild(el);
    while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
    let done = false;
    function dismiss() {
      if (done) return;
      done = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }
    setTimeout(dismiss, type === 'bad' ? 4600 : action ? 6000 : 2600);
    return { dismiss };
  }

  /* -------------------------------- modal -------------------------------- */
  let currentModal = null;
  function modal(opts) {
    const root = $('#modal-root');
    if (currentModal) { try { currentModal.close(); } catch (e) { /* noop */ } }
    root.innerHTML = '';
    root.classList.add('open');

    const prevFocus = document.activeElement;
    const box = h('div', { class: 'modal' + (opts.narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true' });
    const head = h('div', { class: 'modal-head' });
    const hTitle = h('h2', { text: opts.title || '' });
    if (opts.icon) {
      const ic = h('span', { style: 'color:var(--accent);display:flex' });
      ic.innerHTML = icon(opts.icon, 16);
      head.appendChild(ic);
    }
    head.appendChild(hTitle);
    const closeBtn = h('button', { class: 'ibtn sm', title: '关闭 (Esc)', 'aria-label': '关闭' });
    closeBtn.innerHTML = icon('x', 14);
    head.appendChild(closeBtn);

    const body = h('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    box.appendChild(head);
    box.appendChild(body);

    let foot = null;
    if (opts.footer === null) {
      foot = h('div', { class: 'modal-foot' });
      box.appendChild(foot);
    } else if (opts.footer) {
      foot = h('div', { class: 'modal-foot' });
      (Array.isArray(opts.footer) ? opts.footer : [opts.footer]).forEach(function (it) {
        if (it == null) return;
        foot.appendChild(typeof it === 'string' ? document.createTextNode(it) : it);
      });
      box.appendChild(foot);
    } else {
      const dflt = h('div', { class: 'modal-foot' });
      dflt.appendChild(h('span', { class: 'grow' }));
      const b = h('button', { class: 'btn', text: '关闭' });
      b.onclick = () => close();
      dflt.appendChild(b);
      box.appendChild(dflt);
    }

    const backdrop = h('div', { class: 'modal-backdrop' });
    root.appendChild(backdrop);
    root.appendChild(box);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (currentModal === handle) currentModal = null;
      unregisterOverlay(handle);
      root.classList.remove('open');
      root.innerHTML = '';
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* noop */ } }
      if (opts.onClose) opts.onClose();
    }
    const handle = registerOverlay({ type: 'modal', close: close, el: box });
    currentModal = handle;
    closeBtn.onclick = close;
    if (opts.dismissable !== false) backdrop.onclick = close;
    if (opts.onMount) opts.onMount({ body, foot, close });

    // 焦点移入弹窗
    setTimeout(function () {
      if (closed) return;
      const f = box.querySelector('[autofocus], .btn.primary, button, input, select, textarea');
      if (f) { try { f.focus(); } catch (e) { /* noop */ } }
    }, 30);

    return { close: close, box: box, body: body, foot: foot, handle: handle };
  }

  /** 确认框：返回 Promise<boolean> */
  function confirm(opts) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; resolve(v); };
      const m = modal({
        title: opts.title || '确认',
        narrow: true,
        icon: opts.danger ? 'alert' : 'info',
        body: '<p>' + esc(opts.message || '') + '</p>' +
          (opts.detail ? '<div class="hint-box' + (opts.danger ? ' bad' : '') + '">' + opts.detail + '</div>' : ''),
        footer: null,
        onClose: () => done(false),
        onMount: function (ctx) {
          const cancel = h('button', { class: 'btn', text: opts.cancelLabel || '取消' });
          const ok = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), text: opts.okLabel || '确定' });
          cancel.onclick = () => { done(false); ctx.close(); };
          ok.onclick = () => { done(true); ctx.close(); };
          ctx.foot.appendChild(h('span', { class: 'grow' }));
          ctx.foot.appendChild(cancel);
          ctx.foot.appendChild(ok);
          setTimeout(() => ok.focus(), 40);
        }
      });
      // modal() 的默认 footer 已创建；onMount 里追加即可（重复关闭保护已就绪）
      return m;
    });
  }

  /* ------------------------------- popover ------------------------------- */
  /**
   * 简单浮层：挂在 anchor 下方（自动翻转），点击外部 / Esc 关闭。
   * @param {HTMLElement} anchor
   * @param {HTMLElement} content
   * @param {{align?:'left'|'right', offset?:number}} [opt]
   */
  function popover(anchor, content, opt) {
    opt = opt || {};
    const pop = h('div', { class: 'popover', style: 'position:fixed;visibility:hidden' });
    // 挂在 body 上：弹窗根节点默认 display:none（只有 modal 打开时才显示），
    // 浮层挂进去会连带被隐藏。
    document.body.appendChild(pop);
    pop.appendChild(content);

    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = opt.align === 'right' ? r.right - pw : r.left;
    left = clamp(left, 8, vw - pw - 8);
    let top = r.bottom + (opt.offset == null ? 6 : opt.offset);
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.style.visibility = 'visible';

    const handle = registerOverlay({
      type: 'popover', el: pop, anchor: anchor,
      close: () => { unregisterOverlay(handle); pop.remove(); }
    });
    return { close: () => handle.close(), el: pop };
  }
  function root() { return $('#modal-root') || document.body; }

  /** 是否有浮层（modal / popover / 命令面板）正开着 —— 键盘快捷键要避让 */
  function hasOverlay() {
    return overlays.length > 0;
  }

  /**
   * 输入框弹窗：返回 Promise<string|null>（取消得到 null）。
   * @param {object} opts {title, label, value, placeholder, okLabel, validate(v)->string|null}
   */
  function prompt(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      let settled = false;
      const done = function (v) { if (settled) return; settled = true; resolve(v); };
      const inp = h('input', {
        class: 'uni-num', type: 'text', value: opts.value == null ? '' : String(opts.value),
        placeholder: opts.placeholder || '0', autofocus: true,
        style: 'width:100%;height:26px;text-align:left;font-size:12px'
      });
      const body = h('div');
      if (opts.label) body.appendChild(h('div', { style: 'margin-bottom:6px;color:var(--text-3);font-size:11.5px', text: opts.label }));
      body.appendChild(inp);
      const err = h('div', { style: 'margin-top:6px;font-size:11px;color:var(--bad);min-height:15px;font-family:var(--mono)' });
      body.appendChild(err);

      const m = modal({
        title: opts.title || '输入',
        narrow: true,
        icon: 'corner',
        body: body,
        footer: null,
        onClose: function () { done(null); },
        onMount: function (ctx) {
          const cancel = h('button', { class: 'btn', text: '取消' });
          const ok = h('button', { class: 'btn primary', text: opts.okLabel || '确定' });
          const submit = function () {
            const v = inp.value.trim();
            const bad = opts.validate ? opts.validate(v) : null;
            if (bad) { err.textContent = bad; inp.focus(); return; }
            done(v); ctx.close();
          };
          cancel.onclick = function () { done(null); ctx.close(); };
          ok.onclick = submit;
          ctx.foot.appendChild(h('span', { class: 'grow' }));
          ctx.foot.appendChild(cancel);
          ctx.foot.appendChild(ok);
          inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); done(null); ctx.close(); }
          });
          setTimeout(function () { inp.focus(); inp.select(); }, 30);
        }
      });
      return m;
    });
  }

  /* ------------------------------ 文件工具 ------------------------------ */
  function download(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
      fr.readAsText(file);
    });
  }
  function isTypingTarget(el) {
    if (!el) return false;
    const t = (el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
  }
  const modKey = isMac ? '⌘' : 'Ctrl';
  /** 是否按下了平台对应的修饰键（Mac 是 ⌘，其它是 Ctrl） */
  function hasMod(e) {
    return isMac ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
  }

  SL.$ = $;
  SL.$$ = $$;
  SL.clamp = clamp;
  SL.lerp = lerp;
  SL.isMac = isMac;
  SL.modKey = modKey;
  SL.hasMod = hasMod;
  SL.fmt = fmt;
  SL.pad2 = pad2;
  SL.hexToRgb01 = hexToRgb01;
  SL.rgb01ToHex = rgb01ToHex;
  SL.rgbToHsv = rgbToHsv;
  SL.hsvToRgb = hsvToRgb;
  SL.uid = uid;
  SL.debounce = debounce;
  SL.esc = esc;
  SL.deepClone = deepClone;
  SL.h = h;
  SL.frag = frag;
  SL.icon = icon;
  SL.iconEl = iconEl;
  SL.isTypingTarget = isTypingTarget;
  SL.ui = {
    toast: toast,
    modal: modal,
    confirm: confirm,
    prompt: prompt,
    popover: popover,
    hasOverlay: hasOverlay,
    registerOverlay: registerOverlay,
    unregisterOverlay: unregisterOverlay,
    closeTopOverlay: closeTopOverlay
  };
  SL.io = { download: download, readTextFile: readTextFile };
})(window.SL);
