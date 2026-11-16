/* ==========================================================================
   pipeline.js — 左栏 Pass 列表
   --------------------------------------------------------------------------
   · 点击选中、眼睛开关停用、双击重命名、拖拽排序、右键菜单
   · 显示每 Pass 的格式 / 分辨率倍率 / 采样器数量 / 编译错误数
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  let dragId = null;

  function tag(text, cls, title) {
    return SL.h('span', { class: 'ptag' + (cls ? ' ' + cls : ''), text: text, title: title || text });
  }

  /** 每个 pass 的标签行 */
  function tagsFor(pass, uniforms, gpuMs) {
    const wrap = SL.h('div', { class: 'pass-tags' });
    if (pass.format === 'hdr') wrap.appendChild(tag('HDR', 'hdr', 'RGBA16F 浮点缓冲'));
    else wrap.appendChild(tag('8bit', '', 'RGBA8 缓冲'));
    if (pass.role === 'source') wrap.appendChild(tag('中间态', 'src', '不读输入、不参与主链，供其他 Pass 用「指定 Pass」采样'));
    if (pass.scale !== 1) wrap.appendChild(tag(pass.scale + '×', 'scale', '相对输出分辨率'));
    const texCount = (uniforms || []).filter(function (u) { return u.kind === 'sampler'; }).length;
    if (texCount) wrap.appendChild(tag(texCount + ' tex', 'tex', texCount + ' 个纹理输入'));
    const v = pass.values || {};
    const keys = Object.keys(v);
    if (keys.length) wrap.appendChild(tag(keys.length + ' 参数', 'param', keys.length + ' 个可调参数'));
    if (gpuMs != null && pass.enabled !== false) {
      wrap.appendChild(tag(SL.fmt(gpuMs, 2) + 'ms', 'time', '该 Pass 的 GPU 耗时（EXT_disjoint_timer_query）'));
    }
    return wrap;
  }

  function clearDrop(list) {
    SL.$$('.pass-item', list).forEach(function (el) {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  /**
   * @param {object} ctx
   *   {list, passes, selectedId, errors:{passId:[...]}, uniformsOf(passId),
   *    onSelect(id), onToggle(id), onRename(id,name), onReorder(fromId,toId,after),
   *    onMenu(id, x, y), onAdd(afterId)}
   */
  function render(ctx) {
    const list = ctx.list;
    list.innerHTML = '';
    const passes = ctx.passes || [];

    if (!passes.length) {
      list.appendChild(SL.h('div', {
        class: 'insp-empty',
        style: 'padding:18px 14px;text-align:center',
        html: '还没有 Pass。<br>点下方「插入 Pass」或按 <kbd>N</kbd> 挑一个。'
      }));
      return;
    }

    passes.forEach(function (pass, i) {
      const errs = (ctx.errors && ctx.errors[pass.id]) || [];
      const item = SL.h('div', {
        class: 'pass-item' + (pass.id === ctx.selectedId ? ' active' : '') + (pass.enabled === false ? ' off' : ''),
        draggable: 'true',
        dataset: { id: pass.id },
        title: '点击编辑 · 双击改名 · 拖动排序'
      });

      item.appendChild(SL.h('span', { class: 'pass-idx', text: String(i + 1) }));

      const main = SL.h('div', { class: 'pass-main' });
      const nameEl = SL.h('div', { class: 'pass-name', text: pass.name || ('Pass ' + (i + 1)) });
      main.appendChild(nameEl);
      main.appendChild(tagsFor(pass, ctx.uniformsOf ? ctx.uniformsOf(pass.id) : null, ctx.passMs && ctx.passMs[pass.id]));
      item.appendChild(main);

      if (errs.length) {
        item.appendChild(SL.h('span', {
          class: 'pass-err',
          text: String(errs.length),
          title: errs[0].message + (errs.length > 1 ? '\n…共 ' + errs.length + ' 条' : '')
        }));
      }

      const eye = SL.h('button', {
        class: 'ibtn pass-eye',
        title: pass.enabled === false ? '已停用 — 点击启用' : '启用中 — 点击停用',
        html: SL.icon(pass.enabled === false ? 'eyeOff' : 'eye', 14)
      });
      eye.addEventListener('click', function (e) {
        e.stopPropagation();
        ctx.onToggle(pass.id);
      });
      item.appendChild(eye);

      item.addEventListener('click', function () {
        if (pass.id !== ctx.selectedId) ctx.onSelect(pass.id);
      });
      item.addEventListener('dblclick', function (e) {
        if (e.target.closest('.pass-eye')) return;
        startRename(item, nameEl, pass, ctx);
      });
      item.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        ctx.onMenu(pass.id, e.clientX, e.clientY);
      });

      /* 拖拽排序 */
      item.addEventListener('dragstart', function (e) {
        dragId = pass.id;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', pass.id); } catch (_) { }
      });
      item.addEventListener('dragend', function () {
        dragId = null;
        item.classList.remove('dragging');
        clearDrop(list);
      });
      item.addEventListener('dragover', function (e) {
        if (!dragId || dragId === pass.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = item.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearDrop(list);
        item.classList.add(after ? 'drop-after' : 'drop-before');
      });
      item.addEventListener('drop', function (e) {
        if (!dragId || dragId === pass.id) return;
        e.preventDefault();
        const r = item.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearDrop(list);
        ctx.onReorder(dragId, pass.id, after);
        dragId = null;
      });

      list.appendChild(item);
    });

    /* 末尾放置区：拖到底部追加 */
    const tail = SL.h('div', {
      style: 'height:10px;flex:none',
      title: '拖到这里移到末尾'
    });
    tail.addEventListener('dragover', function (e) {
      if (!dragId) return;
      e.preventDefault();
      clearDrop(list);
    });
    tail.addEventListener('drop', function (e) {
      if (!dragId) return;
      e.preventDefault();
      const last = passes[passes.length - 1];
      ctx.onReorder(dragId, last.id, true);
      dragId = null;
    });
    list.appendChild(tail);
  }

  function startRename(item, nameEl, pass, ctx) {
    if (nameEl.querySelector('input')) return;
    const old = pass.name;
    const inp = SL.h('input', { class: 'uni-num', type: 'text', value: old, style: 'width:100%' });
    nameEl.textContent = '';
    nameEl.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = function (ok) {
      if (done) return; done = true;
      const v = inp.value.trim();
      nameEl.textContent = ok && v ? v : old;
      if (ok && v && v !== old) ctx.onRename(pass.id, v);
    };
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', function () { finish(true); });
  }

  /** 底部概述文字 */
  function metaText(passes) {
    if (!passes || !passes.length) return '空管线';
    const on = passes.filter(function (p) { return p.enabled !== false; }).length;
    const hdr = passes.some(function (p) { return p.format === 'hdr' && p.enabled !== false; });
    return passes.length + ' 个 Pass · ' + on + ' 个启用' + (hdr ? ' · HDR' : '');
  }

  SL.pipeline = { render: render, metaText: metaText };
})(window.SL);
