/* ==========================================================================
   uniforms.js — 右侧 Uniforms 面板
   --------------------------------------------------------------------------
   · 依据源码里的 uniform 声明 + // @range 注解生成控件
   · 采样器：选择「上一 Pass / 自身上一帧 / 纹理资源 / 指定 Pass / 无」
   · 初始值：@default > 注解范围 > 类型零值
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  const COMP = SL.glsl.COMPONENTS;

  function num(v, fallback) {
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  /** 依据类型与注解给出范围/步长 */
  function rangeFor(u) {
    const ann = u.ann || {};
    const isInt = u.kind === 'int';
    let min = 0, max = 1;
    if (ann.range) { min = ann.range[0]; max = ann.range[1]; }
    else if (isInt) { min = 0; max = 10; }
    else if (u.kind === 'vec4' || u.kind === 'vec3' || u.kind === 'vec2') { min = 0; max = 1; }
    let step = ann.step;
    if (!step) step = isInt ? 1 : Math.max((max - min) / 200, 1e-5);
    return { min: min, max: max, step: step };
  }

  function defaultFor(u) {
    const n = COMP[u.kind] || 1;
    const ann = u.ann || {};
    if (ann.def && ann.def.length) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(ann.def.length === 1 ? ann.def[0] : (ann.def[i] != null ? ann.def[i] : 0));
      return out;
    }
    if (u.isColor) {
      const base = n >= 4 ? [1, 1, 1, 1] : [1, 1, 1];
      return base.slice(0, n);
    }
    if (u.kind === 'bool') return [0];
    if (u.kind === 'int') {
      const r = rangeFor(u);
      return [Math.round(SL.clamp(0, r.min, r.max))];
    }
    const r = rangeFor(u);
    const z = SL.clamp(0, r.min, r.max);
    const out = [];
    for (let i = 0; i < n; i++) out.push(z);
    return out;
  }

  /** 补齐 pass.values：确保每个可编辑 uniform 都有初值 */
  function init(pass, uniforms) {
    if (!pass.values) pass.values = {};
    uniforms.forEach(function (u) {
      if (u.kind === 'sampler' || !u.editable) return;
      if (!pass.values[u.name] || !pass.values[u.name].length) {
        pass.values[u.name] = defaultFor(u);
      }
    });
  }

  /** 采样器默认绑定：u_self → 自身；iChannel1..3 → 空；其余 → 上一 Pass */
  function defaultBinding(name) {
    if (/self|feedback|prevframe|history|trail/i.test(name)) return { kind: 'self' };
    if (/^iChannel[1-3]$/.test(name)) return { kind: 'none' };
    return { kind: 'prev' };
  }

  /** 源码里用到了哪些自动 uniform（用于展示） */
  function usedAuto(src) {
    const names = Object.keys(SL.glsl.AUTO_UNIFORMS);
    return names.filter(function (n) {
      return new RegExp('\\b' + n + '\\b').test(src);
    });
  }

  /* ------------------------------ 控件工厂 ------------------------------ */
  function sliderFor(u, comp, value, onChange) {
    const r = rangeFor(u);
    const pct = ((value - r.min) / (r.max - r.min || 1)) * 100;
    const inp = SL.h('input', {
      type: 'range', min: r.min, max: r.max, step: r.step,
      value: value, 'aria-label': u.label + (comp ? ' ' + comp : '')
    });
    inp.style.setProperty('--p', SL.clamp(pct, 0, 100) + '%');
    // 聚焦时放开 step：否则细调值会被浏览器按 step 吸附回去
    inp.addEventListener('focus', function () {
      inp.dataset.baseStep = inp.step;
      inp.step = 'any';
    });
    inp.addEventListener('blur', function () {
      if (inp.dataset.baseStep) inp.step = inp.dataset.baseStep;
    });
    inp.addEventListener('input', function () {
      let v = parseFloat(inp.value);
      if (u.kind === 'int') v = Math.round(v);
      inp.style.setProperty('--p', SL.clamp(((v - r.min) / (r.max - r.min || 1)) * 100, 0, 100) + '%');
      onChange(v);
    });
    // 按住 Shift 用方向键微调（1/10 步长），细调参数时不用来回点数值框
    inp.addEventListener('keydown', function (e) {
      if (!e.shiftKey) return;
      let dir = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
      if (!dir) return;
      e.preventDefault();
      const cur = parseFloat(inp.value);
      let v = SL.clamp(cur + dir * (r.step / 10), r.min, r.max);
      if (u.kind === 'int') v = Math.round(v);
      inp.value = v;
      inp.style.setProperty('--p', SL.clamp(((v - r.min) / (r.max - r.min || 1)) * 100, 0, 100) + '%');
      onChange(v);
    });
    return {
      el: inp,
      set: function (v) {
        inp.value = v;
        inp.style.setProperty('--p', SL.clamp(((v - r.min) / (r.max - r.min || 1)) * 100, 0, 100) + '%');
      }
    };
  }

  /* ------------------------------- 行渲染 ------------------------------- */
  function renderRow(u, pass, ctx, rerender) {
    const values = pass.values[u.name] || (pass.values[u.name] = defaultFor(u));
    const label = (u.ann && u.ann.label) || u.name;
    const row = SL.h('div', { class: 'uni-row' });
    const top = SL.h('div', { class: 'uni-top' });
    const nameEl = SL.h('div', {
      class: 'uni-name',
      title: u.name + ' : ' + u.type + (u.line ? '  (第 ' + u.line + ' 行)' : '') + '  ·  双击复位'
    });
    nameEl.appendChild(SL.h('span', { text: label }));
    if (label !== u.name) nameEl.appendChild(SL.h('span', { class: 'type', text: u.name }));
    else nameEl.appendChild(SL.h('span', { class: 'type', text: u.type }));
    // 双击名字 = 把这个参数复位到注解里的默认值
    nameEl.addEventListener('dblclick', function () {
      if (u.kind === 'mat') return;
      const vals = defaultFor(u);
      ctx.pass.values[u.name] = vals;
      ctx.onValueChange(u.name, vals);
      if (rerender) rerender();
    });
    const valEl = SL.h('div', { class: 'uni-val', title: '点击直接输入数值' });
    top.appendChild(nameEl);
    top.appendChild(valEl);
    row.appendChild(top);

    const ctrl = SL.h('div', { class: 'uni-ctrl' });
    row.appendChild(ctrl);

    const n = COMP[u.kind] || 1;
    const sliders = [];
    const fmtVals = function () {
      valEl.textContent = values.map(function (v) {
        return u.kind === 'int' ? String(Math.round(v)) : SL.fmt(v, 3);
      }).join(', ');
    };

    /* ---- 颜色 ---- */
    if (u.isColor) {
      const sw = SL.h('label', { class: 'color-sw', title: '选择颜色' });
      const ci = SL.h('input', { type: 'color' });
      ci.value = SL.rgb01ToHex(values[0], values[1], values[2]);
      ci.addEventListener('input', function () {
        const rgb = SL.hexToRgb01(ci.value);
        values[0] = rgb[0]; values[1] = rgb[1];
        if (n > 2) values[2] = rgb[2];
        sw.style.background = ci.value;
        fmtVals();
        ctx.onValueChange(u.name, values);
      });
      sw.appendChild(ci);
      ctrl.appendChild(sw);
      if (n >= 4) {
        // vec4 颜色才有 alpha 可调；vec3 不摆一个无效控件
        const alpha = sliderFor(u, 'a', values[3] == null ? 1 : values[3], function (v) {
          values[3] = v; fmtVals(); ctx.onValueChange(u.name, values);
        });
        alpha.el.style.flex = '1';
        ctrl.appendChild(alpha.el);
      }
      sw.style.background = ci.value;
      fmtVals();
    } else if (u.kind === 'bool') {
      const lab = SL.h('label', { class: 'switch-label' });
      const cb = SL.h('input', { type: 'checkbox' });
      cb.checked = !!values[0];
      cb.addEventListener('change', function () {
        values[0] = cb.checked ? 1 : 0;
        valEl.textContent = cb.checked ? 'true' : 'false';
        ctx.onValueChange(u.name, values);
      });
      lab.appendChild(cb);
      lab.appendChild(SL.h('span', { class: 'sw' }));
      lab.appendChild(SL.h('span', { text: '开关' }));
      ctrl.appendChild(lab);
      valEl.textContent = values[0] ? 'true' : 'false';
    } else if (n === 1) {
      const s = sliderFor(u, null, values[0], function (v) {
        values[0] = v; fmtVals(); ctx.onValueChange(u.name, values);
      });
      sliders.push(s);
      ctrl.appendChild(s.el);
      fmtVals();
    } else if (u.kind === 'mat') {
      ctrl.appendChild(SL.h('span', { class: 'uni-auto', text: '矩阵：暂不支持面板编辑' }));
      valEl.textContent = u.type;
    } else {
      const multi = SL.h('div', { class: 'uni-multi', style: 'width:100%' });
      const comps = 'xyzw';
      for (let i = 0; i < n; i++) {
        const cell = SL.h('div', { style: 'display:flex;align-items:center;gap:5px;min-width:0' });
        cell.appendChild(SL.h('span', {
          class: 'uni-auto', text: comps[i] || String(i),
          style: 'width:12px;text-align:center;background:transparent;border:0;padding:0;color:var(--text-4)'
        }));
        const s = sliderFor(u, comps[i], values[i], (function (idx) {
          return function (v) { values[idx] = v; fmtVals(); ctx.onValueChange(u.name, values); };
        })(i));
        sliders.push(s);
        cell.appendChild(s.el);
        multi.appendChild(cell);
      }
      ctrl.appendChild(multi);
      fmtVals();
    }

    /** 点击数值 → 变成输入框 */
    valEl.addEventListener('click', function () {
      if (u.kind === 'bool' || u.kind === 'mat' || u.isColor || !u.editable) return;
      if (valEl.querySelector('input')) return;
      const old = values.slice();
      const inp = SL.h('input', { class: 'uni-num', type: 'text', value: values.join(', ') });
      inp.style.width = (n > 1 ? 132 : 64) + 'px';
      valEl.textContent = '';
      valEl.appendChild(inp);
      inp.focus(); inp.select();
      let done = false;
      const commit = function (ok) {
        if (done) return; done = true;
        if (ok) {
          const parts = inp.value.split(/[,\s]+/).map(parseFloat).filter(function (v) { return isFinite(v); });
          if (parts.length) {
            for (let i = 0; i < n; i++) {
              const v = parts.length === 1 ? parts[0] : parts[i];
              values[i] = v == null ? old[i] : v;
            }
            sliders.forEach(function (s, i) { s.set(values[i]); });
            ctx.onValueChange(u.name, values);
          }
        }
        valEl.textContent = '';
        fmtVals();
      };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      inp.addEventListener('blur', function () { commit(true); });
    });

    // 打关键帧按钮：◇ = 还没有动画，◆ = 有动画，实心 = 当前时刻正好有一帧
    if (ctx.onKeyframe && u.kind !== 'mat') {
      const has = ctx.hasTrack ? ctx.hasTrack(u.name) : false;
      const at = ctx.keyAt ? ctx.keyAt(u.name) : false;
      const kf = SL.h('button', {
        class: 'kf-btn' + (has ? ' has' : '') + (at ? ' on' : ''),
        type: 'button',
        text: has ? '◆' : '◇',
        title: has
          ? (at ? '当前时刻已有关键帧，点一下删除' : '在当前位置再打一帧')
          : '在当前位置给 ' + u.name + ' 打关键帧'
      });
      kf.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        ctx.onKeyframe(u.name, values);
      });
      top.appendChild(kf);
    }

    return row;
  }

  /* ------------------------------ 采样器行 ------------------------------ */
  function renderSamplerRow(u, pass, ctx) {
    const label = (u.ann && u.ann.label) || u.name;
    const row = SL.h('div', { class: 'uni-row' });
    const top = SL.h('div', { class: 'uni-top' });
    const nameEl = SL.h('div', { class: 'uni-name', title: u.name + ' : ' + u.type });
    nameEl.appendChild(SL.h('span', { text: label }));
    if (label !== u.name) nameEl.appendChild(SL.h('span', { class: 'type', text: u.name }));
    top.appendChild(nameEl);
    row.appendChild(top);

    if (u.auto) top.appendChild(SL.h('span', { class: 'uni-auto', text: 'shadertoy' }));

    const binding = (pass.bindings && pass.bindings[u.name]) || defaultBinding(u.name);
    if (!pass.bindings) pass.bindings = {};
    pass.bindings[u.name] = binding;

    const ctrl = SL.h('div', { class: 'uni-ctrl' });
    const sel = SL.h('select', { class: 'sel', 'aria-label': u.name + ' 绑定' });
    const opts = [
      ['prev', ctx.isFirst ? '输入图（首个 Pass）' : '上一 Pass 输出'],
      ['self', '自身上一帧（反馈）'],
      ['asset', '纹理资源…'],
      ['pass', '指定 Pass…'],
      ['none', '无']
    ];
    opts.forEach(function (o) {
      const op = SL.h('option', { value: o[0], text: o[1] });
      if (binding.kind === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    ctrl.appendChild(sel);
    row.appendChild(ctrl);

    const extra = SL.h('div', { class: 'uni-ctrl', style: 'margin-top:4px' });
    row.appendChild(extra);

    function sync() {
      extra.innerHTML = '';
      if (binding.kind === 'asset') {
        const as = SL.h('select', { class: 'sel' });
        ctx.assets.items.forEach(function (a) {
          const op = SL.h('option', { value: a.id, text: a.name });
          if (binding.assetId === a.id) op.selected = true;
          as.appendChild(op);
        });
        if (!binding.assetId && ctx.assets.items[0]) binding.assetId = ctx.assets.items[0].id;
        as.addEventListener('change', function () {
          binding.assetId = as.value;
          ctx.onBindingChange(u.name, binding);
          sync();
        });
        extra.appendChild(as);
      } else if (binding.kind === 'pass') {
        const ps = SL.h('select', { class: 'sel' });
        const opSrc = SL.h('option', { value: '__source__', text: '源图（原始输入）' });
        if (binding.passId === '__source__') opSrc.selected = true;
        ps.appendChild(opSrc);
        let any = true;
        ctx.passes.forEach(function (p) {
          if (p.id === pass.id) return;
          const op = SL.h('option', { value: p.id, text: p.name });
          if (binding.passId === p.id) op.selected = true;
          ps.appendChild(op);
        });
        {
          if (!binding.passId) binding.passId = ps.options[0].value;
          ps.addEventListener('change', function () {
            binding.passId = ps.value;
            ctx.onBindingChange(u.name, binding);
            sync();
          });
          extra.appendChild(ps);
        }
      }
      const size = ctx.bindingSize ? ctx.bindingSize(binding) : null;
      if (size) extra.appendChild(SL.h('span', { class: 'uni-auto', text: size }));
      // 「上一 Pass 输出」到底是谁：取上一个渲染成功的 Pass（中间态也算），
      // 前面一个都没有时退化成输入图，直接写出来省得猜
      if (binding.kind === 'prev') {
        const idx = ctx.passes.findIndex(function (p) { return p.id === pass.id; });
        let up = null;
        for (let i = idx - 1; i >= 0; i--) {
          const p = ctx.passes[i];
          if (p.enabled !== false) { up = p; break; }
        }
        extra.appendChild(SL.h('span', {
          class: 'uni-auto' + (up ? '' : ' an'),
          text: up ? '← ' + up.name + (up.role === 'source' ? '（中间态）' : '') : '← 输入图',
          title: up ? '实际取「' + up.name + '」的输出' : '前面没有生效的 Pass，实际取的是管线输入图'
        }));
      }
      if (binding.kind === 'self') {
        extra.appendChild(SL.h('span', { class: 'uni-auto an', text: 'ping-pong' }));
      }
    }

    sel.addEventListener('change', function () {
      binding.kind = sel.value;
      // 切走之后把另一类绑定的残留清掉：否则 store 里会留着一个看不见的 assetId/passId，
      // 之后只看文件根本判断不出这一行到底在采样什么
      if (binding.kind === 'asset') {
        delete binding.passId;
        if (!binding.assetId && ctx.assets.items[0]) binding.assetId = ctx.assets.items[0].id;
      } else if (binding.kind === 'pass') {
        delete binding.assetId;
        if (!binding.passId) {
          const other = ctx.passes.filter(function (p) { return p.id !== pass.id; })[0];
          if (other) binding.passId = other.id;
        }
      } else {
        delete binding.assetId;
        delete binding.passId;
      }
      ctx.onBindingChange(u.name, binding);
      sync();
    });

    sync();
    return row;
  }

  /* -------------------------------- 主渲染 -------------------------------- */
  /**
   * @param {HTMLElement} host
   * @param {object} ctx {src, pass, passes, assets, uniforms, isFirst,
   *                      onValueChange, onBindingChange, bindingSize, onRefresh}
   */
  function render(host, ctx) {
    host.innerHTML = '';
    const uniforms = ctx.uniforms || [];
    const params = uniforms.filter(function (u) { return u.kind !== 'sampler'; });
    const samplers = uniforms.filter(function (u) { return u.kind === 'sampler'; });
    init(ctx.pass, uniforms);

    // 面板内改完一整批值后重画（优先用外部刷新，避免丢掉滚动位置以外的状态）
    const rerender = function () {
      if (ctx.onRefresh) ctx.onRefresh();
      else render(host, ctx);
    };

    // 自动 uniform 提示
    const autos = usedAuto(ctx.src || '');
    if (autos.length) {
      const sec = SL.h('div', { class: 'insp-section' });
      sec.appendChild(SL.h('div', { class: 'insp-head' }, SL.h('span', { text: '自动注入' }), SL.h('span', { class: 'count', text: String(autos.length) })));
      const wrap = SL.h('div', { class: 'insp-note', style: 'display:flex;flex-wrap:wrap;gap:4px;padding-top:2px' });
      autos.forEach(function (a) {
        wrap.appendChild(SL.h('span', { class: 'uni-auto an', text: a, title: '由引擎每帧自动赋值' }));
      });
      sec.appendChild(wrap);
      host.appendChild(sec);
    }

    // 自定义参数
    const sec = SL.h('div', { class: 'insp-section' });
    const head = SL.h('div', { class: 'insp-head' });
    head.appendChild(SL.h('span', { text: '参数' }));
    head.appendChild(SL.h('span', { class: 'count', text: String(params.length) }));
    if (params.length) {
      const tools = SL.h('div', { class: 'insp-tools' });
      const dice = SL.h('button', {
        class: 'tool-btn', title: '随机一组参数（R）', 'aria-label': '随机参数',
        html: SL.icon('dice', 12)
      });
      dice.addEventListener('click', function () {
        params.forEach(function (u) {
          if (u.kind === 'mat' || (u.ann && u.ann.hidden)) return;
          const r = rangeFor(u);
          const cnt = COMP[u.kind] || 1;
          const vals = [];
          for (let i = 0; i < cnt; i++) {
            let v = r.min + Math.random() * (r.max - r.min);
            if (u.kind === 'int' || u.kind === 'bool') v = Math.round(v);
            vals.push(+v.toFixed(4));
          }
          ctx.pass.values[u.name] = vals;
          ctx.onValueChange(u.name, vals);
        });
        rerender();
      });
      const reset = SL.h('button', {
        class: 'tool-btn', title: '全部复位为默认值', 'aria-label': '复位参数',
        html: SL.icon('reset', 12)
      });
      reset.addEventListener('click', function () {
        params.forEach(function (u) {
          const vals = defaultFor(u);
          ctx.pass.values[u.name] = vals;
          ctx.onValueChange(u.name, vals);
        });
        rerender();
      });
      tools.appendChild(dice);
      tools.appendChild(reset);
      head.appendChild(tools);
    }
    sec.appendChild(head);

    // 参数多了给一个就地筛选框（按名字或显示名）
    const rows = [];
    let filterEl = null;
    if (params.length > 5) {
      filterEl = SL.h('input', {
        class: 'uni-filter', type: 'search', placeholder: '筛选参数…（' + params.length + '）',
        'aria-label': '筛选参数'
      });
      const empty = SL.h('div', { class: 'uni-filter-empty', text: '没有匹配的参数', style: 'display:none' });
      filterEl.addEventListener('input', function () {
        const q = filterEl.value.trim().toLowerCase();
        let shown = 0;
        rows.forEach(function (r) {
          const hit = !q || r.key.indexOf(q) >= 0;
          r.el.style.display = hit ? '' : 'none';
          if (hit) shown++;
        });
        empty.style.display = shown ? 'none' : '';
      });
      sec.appendChild(filterEl);
      sec.appendChild(empty);
    }
    if (!params.length) {
      sec.appendChild(SL.h('div', {
        class: 'insp-empty',
        html: '这段代码没有可调参数。<br>写一个 uniform 并加上注解，就会出现在这里：<br><br>' +
          '<code>uniform float u_strength; // @range 0 1 @default 0.5</code><br>' +
          '<code>uniform vec3 u_tint; // @color</code><br><br>' +
          '支持下表的注解：<br>' +
          '<code>@range min max</code> 滑块范围<br>' +
          '<code>@step 0.01</code> 步长<br>' +
          '<code>@default 0.5</code> 初始值<br>' +
          '<code>@label 强度</code> 显示名<br>' +
          '<code>@color</code> 按颜色编辑'
      }));
    } else {
      params.forEach(function (u) {
        if (u.ann && u.ann.hidden) return;
        const row = renderRow(u, ctx.pass, ctx, rerender);
        rows.push({ el: row, key: (((u.ann && u.ann.label) || u.name) + ' ' + u.name).toLowerCase() });
        sec.appendChild(row);
      });
    }
    host.appendChild(sec);

    // 采样器
    if (samplers.length) {
      const s2 = SL.h('div', { class: 'insp-section' });
      const h2 = SL.h('div', { class: 'insp-head' });
      h2.appendChild(SL.h('span', { text: '采样器 / 纹理输入' }));
      h2.appendChild(SL.h('span', { class: 'count', text: String(samplers.length) }));
      s2.appendChild(h2);
      samplers.forEach(function (u) { s2.appendChild(renderSamplerRow(u, ctx.pass, ctx)); });
      s2.appendChild(SL.h('div', {
        class: 'insp-note',
        html: '声明 <code>uniform vec2 ' + (samplers[0].name) + 'Size;</code> 会自动填入所绑定纹理的尺寸。'
      }));
      host.appendChild(s2);
    }
  }

  SL.uniforms = {
    render: render,
    init: init,
    defaultFor: defaultFor,
    defaultBinding: defaultBinding,
    rangeFor: rangeFor,
    usedAuto: usedAuto
  };
})(window.SL);
