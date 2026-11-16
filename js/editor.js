/* ==========================================================================
   editor.js — 轻量 GLSL 编辑器
   --------------------------------------------------------------------------
   结构：<pre> 高亮层 + 错误行层 + 透明 <textarea> 输入层 三层叠加，
   字号/行高/内边距完全一致，滚动同步，光标天然对齐。
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  class CodeEditor {
    /**
     * @param {object} opt {textarea, pre, gutter, errRows, onChange, onCompile, onCursor}
     */
    constructor(opt) {
      this.ta = opt.textarea;
      this.pre = opt.pre;
      this.gutter = opt.gutter;
      this.errRows = opt.errRows;
      this.onChange = opt.onChange || function () {};
      this.onCompile = opt.onCompile || function () {};
      this.onCursor = opt.onCursor || function () {};

      this.lh = 20;
      this.padTop = 10;
      this.lastLineCount = -1;
      this._hlPending = false;
      this._composing = false;
      this._errors = [];

      this.measure();
      this.bind();
      this.updateHighlight(true);
      this.updateGutter();
    }

    /* ------------------------------ 尺寸测量 ------------------------------ */
    measure() {
      const cs = getComputedStyle(this.ta);
      const lh = parseFloat(cs.lineHeight);
      this.lh = isFinite(lh) && lh > 1 ? lh : 20;
      this.padTop = parseFloat(cs.paddingTop) || 10;
      // 让行号栏使用同一行高
      this.gutter.style.lineHeight = this.lh + 'px';
      this.gutter.style.paddingTop = this.padTop + 'px';
    }

    /* -------------------------------- 事件 -------------------------------- */
    bind() {
      const self = this;
      this.ta.addEventListener('input', function () {
        self.updateHighlight();
        self.updateGutter();
        self.onChange(self.ta.value);
        self.reportCursor();
      });
      this.ta.addEventListener('scroll', function () { self.syncScroll(); }, { passive: true });
      this.ta.addEventListener('keydown', function (e) { self.onKeyDown(e); });
      this.ta.addEventListener('keyup', function (e) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
          self.reportCursor();
        }
      });
      this.ta.addEventListener('click', function () { self.reportCursor(); });
      this.ta.addEventListener('compositionstart', function () { self._composing = true; });
      this.ta.addEventListener('compositionend', function () {
        self._composing = false;
        self.updateHighlight();
        self.updateGutter();
        self.onChange(self.ta.value);
      });
      window.addEventListener('resize', function () { self.measure(); self.updateHighlight(true); });
    }

    /* -------------------------------- 键盘 -------------------------------- */
    onKeyDown(e) {
      const ta = this.ta;
      const mod = e.ctrlKey || e.metaKey;

      // 编译
      if (mod && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        this.onCompile(this.ta.value);
        return;
      }
      // 保存
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('sl:save'));
        return;
      }
      // 注释切换
      if (mod && (e.key === '/' || e.key === '?')) {
        e.preventDefault();
        this.toggleComment();
        return;
      }
      // Tab / Shift+Tab 缩进
      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) this.dedent();
        else this.indent();
        return;
      }
      // 回车自动缩进
      if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
        const pos = ta.selectionStart;
        if (pos === ta.selectionEnd) {
          const before = ta.value.slice(0, pos);
          const lineStart = before.lastIndexOf('\n') + 1;
          const curLine = ta.value.slice(lineStart, pos);
          const indent = (/^[ \t]*/.exec(curLine) || [''])[0];
          const extra = /\{\s*$/.test(curLine) ? '  ' : '';
          if (indent || extra) {
            e.preventDefault();
            this.insert('\n' + indent + extra);
            return;
          }
        }
      }
      // 跳过已存在的右括号 / 引号
      const PAIRS = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'" };
      if (!mod && !e.altKey && PAIRS[e.key] && ta.selectionStart === ta.selectionEnd) {
        const pos = ta.selectionStart;
        if (ta.value[pos] === e.key && ta.value[pos - 1] !== '\\') {
          e.preventDefault();
          ta.setSelectionRange(pos + 1, pos + 1);
          this.reportCursor();
          return;
        }
      }
      // Esc 失焦
      if (e.key === 'Escape') { this.ta.blur(); }
    }

    /** 通过 execCommand 插入，保留浏览器撤销栈 */
    insert(text) {
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        const ta = this.ta;
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + text.length;
        ta.dispatchEvent(new Event('input'));
      }
      this.updateHighlight();
      this.updateGutter();
      this.reportCursor();
    }

    getLineRange() {
      const ta = this.ta;
      const s = ta.selectionStart, e = ta.selectionEnd;
      const val = ta.value;
      const from = val.lastIndexOf('\n', s - 1) + 1;
      let to = val.indexOf('\n', e);
      if (to < 0) to = val.length;
      return [from, to];
    }

    indent() {
      const [from] = this.getLineRange();
      const ta = this.ta;
      if (ta.selectionStart !== ta.selectionEnd) {
        this.transformLines(function (line) { return line.length ? '  ' + line : line; });
      } else {
        this.insert('  ');
      }
      return from;
    }

    dedent() {
      this.transformLines(function (line) { return line.replace(/^ {1,2}|^\t/, ''); });
    }

    transformLines(fn) {
      const ta = this.ta;
      const [from, to] = this.getLineRange();
      const block = ta.value.slice(from, to);
      const next = block.split('\n').map(fn).join('\n');
      ta.setSelectionRange(from, to);
      this.insert(next);
      ta.setSelectionRange(from, from + next.length);
    }

    toggleComment() {
      const ta = this.ta;
      const [from, to] = this.getLineRange();
      const block = ta.value.slice(from, to);
      const lines = block.split('\n');
      const allCommented = lines.every(function (l) { return !l.trim() || /^\s*\/\//.test(l); });
      const next = lines.map(function (l) {
        if (!l.trim()) return l;
        if (allCommented) return l.replace(/^(\s*)\/\/\s?/, '$1');
        return l.replace(/^(\s*)/, '$1// ');
      }).join('\n');
      ta.setSelectionRange(from, to);
      this.insert(next);
      ta.setSelectionRange(from, from + next.length);
      this.updateHighlight();
    }

    /* ------------------------------- 内容同步 ------------------------------- */
    setValue(code, silent) {
      this.ta.value = code == null ? '' : code;
      this.updateHighlight(true);
      this.updateGutter();
      if (!silent) this.onChange(this.ta.value);
      this.reportCursor();
    }
    getValue() { return this.ta.value; }

    updateHighlight(force) {
      if (this._hlPending && !force) return;
      this._hlPending = true;
      const self = this;
      requestAnimationFrame(function () {
        self._hlPending = false;
        if (self._composing) return;
        const val = self.ta.value;
        self.pre.innerHTML = SL.glsl.highlight(val) + '\n';
        self.syncScroll();
      });
    }

    updateGutter() {
      const n = this.ta.value.split('\n').length;
      if (n === this.lastLineCount) return;
      this.lastLineCount = n;
      let html = '';
      for (let i = 1; i <= n; i++) html += '<div class="gl" data-line="' + i + '">' + i + '</div>';
      this.gutter.innerHTML = html;
      this.markGutterErrors();
      this.syncScroll();
    }

    markGutterErrors() {
      const bad = {};
      this._errors.forEach((e) => { if (e.line > 0) bad[e.line] = 1; });
      Array.prototype.forEach.call(this.gutter.children, function (el) {
        const l = parseInt(el.dataset.line, 10);
        el.classList.toggle('err', !!bad[l]);
      });
    }

    syncScroll() {
      const ta = this.ta;
      this.pre.scrollTop = ta.scrollTop;
      this.pre.scrollLeft = ta.scrollLeft;
      this.gutter.scrollTop = ta.scrollTop;
      if (this.errRows && this.errRows.parentNode) {
        this.errRows.parentNode.scrollTop = ta.scrollTop;
      }
    }

    /* ------------------------------- 错误标记 ------------------------------- */
    setErrors(errors) {
      this._errors = errors || [];
      const rows = this.errRows;
      if (!rows) return;
      const bad = {};
      this._errors.forEach((e) => { if (e.line > 0) bad[e.line] = e; });
      rows.innerHTML = '';
      const total = this.ta.value.split('\n').length;
      rows.style.height = (total * this.lh) + 'px';
      Object.keys(bad).forEach((line) => {
        const d = document.createElement('div');
        d.className = 'err-line';
        d.style.top = ((parseInt(line, 10) - 1) * this.lh) + 'px';
        d.title = bad[line].message || '';
        rows.appendChild(d);
      });
      this.markGutterErrors();
      this.syncScroll();
    }

    /* ------------------------------- 光标定位 ------------------------------- */
    gotoLine(line) {
      const val = this.ta.value;
      const lines = val.split('\n');
      const n = SL.clamp(line || 1, 1, lines.length);
      let pos = 0;
      for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos + (lines[n - 1] ? lines[n - 1].length : 0));
      // 滚动到可视区
      const top = (n - 1) * this.lh;
      const viewH = this.ta.clientHeight;
      if (top < this.ta.scrollTop || top > this.ta.scrollTop + viewH - this.lh * 2) {
        this.ta.scrollTop = Math.max(0, top - viewH / 2);
        this.syncScroll();
      }
      this.reportCursor();
    }

    reportCursor() {
      const pos = this.ta.selectionStart;
      const before = this.ta.value.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      this.onCursor(line, col, this.ta.value.length);
    }

    focus() { this.ta.focus(); }
  }

  SL.CodeEditor = CodeEditor;
})(window.SL);
