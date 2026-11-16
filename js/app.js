/* ==========================================================================
   app.js — 装配：把所有模块接成一个可用的工具
   --------------------------------------------------------------------------
   数据流：doc（可 JSON 化）→ 编译 → 每帧 engine.render
   · 任何改动先写回 doc，再触发「重编译 / 重绘 / 自动保存」
   · 预览缩放与平移用 CSS transform，不改变渲染分辨率
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  const $ = SL.$;
  const MAX_EDGE = 4096;

  const App = {
    doc: null,
    engine: null,
    assets: null,
    editor: null,
    compiled: {},        // passId → compile 结果
    parsed: {},          // passId → parseUniforms 结果
    autoCompile: true,
    time: 0,
    playing: true,
    speed: 1,
    frame: 0,
    lastTs: 0,
    mouse: [0, 0, 0, 0],
    needsRender: true,
    zoom: 1,
    panX: 0,
    panY: 0,
    fps: 0,
    fpsAcc: 0,
    fpsN: 0,
    fpsT: 0,
    msAcc: 0,
    lastPixel: null,
    save: null,
    booted: false,
    glError: null,
    compare: false,      // 对比原图（跳过管线直接显示输入）
    zen: false,          // 专注模式：只留预览
    passMs: {},          // passId → GPU 耗时
    pipelineT: 0,        // 上次刷新左栏耗时标签的时间
    savedT: 0,           // 「已保存」提示的淡出计时
    history: []          // 撤销栈（有限深度）
  };

  function dpr() {
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  }

  /* ========================================================================
     一、启动
     ====================================================================== */
  function init() {
    decorateIcons();
    fillPresetSelect();

    App.engine = new SL.Engine($('#gl'));
    if (!App.engine.ok) {
      App.glError = (App.engine.errors && App.engine.errors[0]) || 'WebGL2 上下文创建失败';
      showFallback(App.glError);
    }
    App.assets = new SL.AssetStore(App.engine.gl);
    App.assets.ensureBuiltins();

    initEditor();
    bindTopbar();
    bindPipelineButtons();
    bindPreview();
    bindInspector();
    bindSplitters();
    bindKeyboard();
    bindCtxMenuGuard();
    bindDrop();

    App.save = SL.debounce(function () {
      if (!App.doc) return;
      try {
        Promise.resolve(SL.store.save(App.doc)).then(flashSaved, function () {});
      } catch (e) { /* store 内部已提示 */ }
    }, 700);

    SL.store.load().then(function (doc) {
      App.__fresh = !doc;
      applyDoc(doc || SL.store.defaultState());
      bootDone();
    }).catch(function (err) {
      SL.ui.toast('读取本地工程失败，已用默认预设：' + (err && err.message ? err.message : err), 'warn');
      applyDoc(SL.store.defaultState());
      bootDone();
    });
  }

  function bootDone() {
    App.booted = true;
    App.needsRender = true;
    if (!App.engine.ok) return;
    requestAnimationFrame(loop);
    if (SL.test && SL.test.autoRun) runSelfTest();
    if (App.__fresh) {
      setTimeout(function () {
        SL.ui.toast('按 Ctrl+K 打开命令面板，? 看快捷键', 'info');
      }, 700);
    }
  }

  function showFallback(msg) {
    const box = $('#gl-fallback');
    box.innerHTML = '';
    box.classList.remove('hidden');
    box.appendChild(SL.h('h3', { text: '无法初始化 WebGL2' }));
    box.appendChild(SL.h('p', { text: msg }));
    box.appendChild(SL.h('p', {
      html: '这个工具用 WebGL2 跑多 Pass 着色器。请改用较新的 <b>Chrome / Edge / Firefox</b>，' +
        '并在设置里打开「使用硬件加速」。<code>chrome://gpu</code> 可以看到具体原因。'
    }));
    $('#preview-note').textContent = 'WebGL2 不可用';
  }

  function decorateIcons() {
    const map = {
      'btn-play': App.playing ? 'pause' : 'play',
      'btn-step': 'step',
      'btn-reset-time': 'reset',
      'btn-shot': 'camera',
      'btn-save': 'download',
      'btn-open': 'upload',
      'btn-help': 'help',
      'btn-add-pass': 'plus',
      'btn-add-pass-2': null,
      'zoom-out': 'zoomOut',
      'zoom-in': 'zoomIn',
      'zoom-fit': null,
      'zoom-100': null,
      'btn-snippets': null,
      'btn-compile': null
    };
    Object.keys(map).forEach(function (id) {
      const el = $('#' + id);
      if (!el || !map[id]) return;
      el.innerHTML = SL.icon(map[id], 15);
    });
    const add2 = $('#btn-add-pass-2');
    if (add2) add2.innerHTML = '<span class="plus">+</span><span>新增 Pass</span>';
    const cmdk = $('#cmdk-btn-ic');
    if (cmdk) cmdk.innerHTML = SL.icon('search', 11);
    const saved = $('#save-state .ic');
    if (saved) saved.innerHTML = SL.icon('check', 11);
    const cmp = $('#compare-ic');
    if (cmp) cmp.innerHTML = SL.icon('split', 12);
    const libIc = $('#lib-btn-ic');
    if (libIc) libIc.innerHTML = SL.icon('grid', 13);
    const bgIc = $('#bg-ic');
    if (bgIc) bgIc.innerHTML = SL.icon('image', 12);
    const libIco = $('#lib-ico');
    if (libIco) libIco.innerHTML = SL.icon('grid', 15);
    const libClose = $('#lib-close');
    if (libClose) libClose.innerHTML = SL.icon('x', 14);
  }

  /** 顶栏「已保存」闪一下，让自动保存可见 */
  function flashSaved() {
    const el = $('#save-state');
    if (!el) return;
    el.classList.add('saved');
    const tx = el.querySelector('.tx');
    if (tx) tx.textContent = '已保存';
    clearTimeout(App.savedT);
    App.savedT = setTimeout(function () {
      el.classList.remove('saved');
      if (tx) tx.textContent = '自动保存';
    }, 1400);
  }

  function fillPresetSelect() {
    const sel = $('#preset-select');
    sel.innerHTML = '';
    const g1 = SL.h('optgroup', { label: '内置预设' });
    SL.presets.list.forEach(function (p) {
      g1.appendChild(SL.h('option', { value: p.id, text: p.name, title: p.desc }));
    });
    sel.appendChild(g1);
    const effects = libraryEffects();
    if (effects.length) {
      const g2 = SL.h('optgroup', { label: '效果库' });
      effects.forEach(function (e) {
        g2.appendChild(SL.h('option', { value: 'effect:' + e.id, text: e.name, title: e.desc }));
      });
      sel.appendChild(g2);
    }
    const cnt = $('#lib-btn-count');
    if (cnt) cnt.textContent = effects.length ? String(effects.length) : '';
  }

  /** 效果库索引（effects/index.js 由 node tools/lib.mjs build 生成） */
  function libraryEffects() {
    return (window.SL_EFFECTS && Array.isArray(window.SL_EFFECTS.effects))
      ? window.SL_EFFECTS.effects : [];
  }

  /* ========================================================================
     二、文档
     ====================================================================== */
  function applyDoc(doc) {
    App.doc = doc;
    const ui = doc.ui || {};

    App.playing = ui.playing !== false;
    App.speed = ui.speed || 1;
    syncPlayButton();

    // 恢复用户导入的贴图（保留原 id，否则绑定会失效）
    const jobs = (doc.assets || []).map(function (a) {
      if (App.assets.byId(a.id)) return Promise.resolve();
      return App.assets.importDataURL(a.name, a.dataURL).then(function (entry) {
        entry.id = a.id;
        if (a.params) entry.params = a.params;
        App.assets.textures.delete(entry.id + ':pending');
      }).catch(function () { /* 单张失败不影响整体 */ });
    });

    Promise.all(jobs).then(function () {
      // 面板宽度与编辑器高度
      applyPanelSizes(ui);
      // 编辑器字号跟随上次使用
      if (App.editor) {
        const size = App.editor.setFontSize(ui.editorFont || 12.5);
        const fEl = $('#font-size');
        if (fEl) fEl.textContent = String(size);
      }
      $('#preset-select').value = doc.presetId;
      $('#auto-toggle').checked = true;
      applyPreviewBg();
      syncScrub();

      selectPass(doc.selectedPassId, true);
      compileAll();
      renderPipeline();
      renderInspector();
      syncStage();
      layoutZoom(true);
      App.needsRender = true;
      updateDocBadge();
      announceEffectUpdate();
    });
  }

  // 重新 build 过效果库后，浏览器里恢复的旧代码不会自动更新——提示一下
  function announceEffectUpdate() {
    const doc = App.doc;
    const idx = window.SL_EFFECTS;
    if (!doc || !doc.effectId || !idx || !idx.builtAt) return;
    if (!doc.effectBuiltAt || doc.effectBuiltAt === idx.builtAt) return;
    const id = doc.effectId;
    SL.ui.toast('「' + (updateDocBadgeName(id) || id) + '」在磁盘上更新过，当前显示的还是旧代码', 'info', {
      label: '重新载入',
      fn: function () { loadEffect(id, true); }
    });
  }

  function updateDocBadgeName(id) {
    const eff = libraryEffects().filter(function (e) { return e.id === id; })[0];
    return eff ? eff.name : '';
  }

  function applyPanelSizes(ui) {
    if (ui.leftW) document.documentElement.style.setProperty('--left-w', ui.leftW + 'px');
    if (ui.rightW) document.documentElement.style.setProperty('--right-w', ui.rightW + 'px');
    if (ui.editorH != null) {
      document.documentElement.style.setProperty('--editor-h', ui.editorH + 'px');
      $('#editor-pane').style.height = ui.editorH + 'px';
    }
    App.zoom = ui.zoom || 1;
  }

  function updateDocBadge() {
    const sel = $('#preset-select');
    const eff = App.doc.effectId
      ? libraryEffects().filter(function (e) { return e.id === App.doc.effectId; })[0] : null;
    const p = SL.presets.list.filter(function (x) { return x.id === App.doc.presetId; })[0];
    const title = eff ? (eff.name + ' · ' + (eff.desc || '')) : (p ? p.name + ' · ' + p.desc : '');
    sel.title = title + (App.doc.custom ? '（已修改）' : '');
    $('#pipeline-meta').textContent = SL.pipeline.metaText(App.doc.passes);
  }

  function setDirty() {
    if (!App.doc) return;
    App.doc.custom = true;
    App.needsRender = true;
    updateDocBadge();
    if (App.save) App.save();
  }

  function selectedPass() {
    if (!App.doc) return null;
    for (let i = 0; i < App.doc.passes.length; i++) {
      if (App.doc.passes[i].id === App.doc.selectedPassId) return App.doc.passes[i];
    }
    return App.doc.passes[0] || null;
  }

  /* ========================================================================
     三、编译
     ====================================================================== */
  function compilePass(pass) {
    if (!pass) return null;
    let res;
    if (!App.engine.ok) {
      res = {
        ok: false, log: App.glError || 'WebGL2 不可用',
        errors: [{ line: 0, rawLine: 0, message: App.glError || 'WebGL2 不可用', severity: 'error' }],
        built: { warnings: [], headerLines: 0 }, program: null, uniforms: []
      };
    } else {
      const idx = App.doc.passes.indexOf(pass);
      try {
        res = App.engine.compile(pass.code, {
          isFirst: idx === 0,
          isLast: idx === App.doc.passes.length - 1
        });
      } catch (e) {
        res = {
          ok: false, log: String(e && e.message || e),
          errors: [{ line: 0, rawLine: 0, message: String(e && e.message || e), severity: 'error' }],
          built: { warnings: [], headerLines: 0 }, program: null, uniforms: []
        };
      }
    }
    App.compiled[pass.id] = res;

    const parsed = SL.glsl.parseUniforms(pass.code);
    // Shadertoy 写法的 iChannel0..3 是构建器自动补的 uniform，这里补成可绑定的采样器，
    // 否则「Uniforms」页看不到它们、也没法换成别的贴图或中间 Pass。
    if (res && res.built && res.built.shadertoy) {
      for (let ci = 0; ci < 4; ci++) {
        const cn = 'iChannel' + ci;
        const exists = parsed.some(function (u) { return u.name === cn; });
        if (exists) continue;
        parsed.push({
          name: cn, type: 'sampler2D', kind: 'sampler', array: false, line: 0,
          ann: { label: 'iChannel' + ci }, isColor: false, editable: true, injected: true
        });
      }
    }
    App.parsed[pass.id] = parsed;
    SL.uniforms.init(pass, parsed);
    ensureBindings(pass, parsed);
    return res;
  }

  function ensureBindings(pass, uniforms) {
    if (!pass.bindings) pass.bindings = {};
    uniforms.forEach(function (u) {
      if (u.kind !== 'sampler') return;
      if (!pass.bindings[u.name]) pass.bindings[u.name] = SL.uniforms.defaultBinding(u.name);
    });
  }

  function compileAll() {
    App.doc.passes.forEach(compilePass);
    syncEditorChrome();
  }

  /** 编辑器内容变化 → 写回 doc → 延迟编译 */
  const recompile = SL.debounce(function () {
    const pass = selectedPass();
    if (!pass) return;
    compilePass(pass);
    syncEditorChrome();
    renderPipeline();
    renderInspector();
    App.needsRender = true;
  }, 380);

  function compileNow() {
    const pass = selectedPass();
    if (!pass) return;
    recompile.cancel();
    compilePass(pass);
    syncEditorChrome();
    renderPipeline();
    renderInspector();
    App.needsRender = true;
  }

  /* ========================================================================
     四、渲染循环
     ====================================================================== */
  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = App.lastTs ? Math.min(0.1, (ts - App.lastTs) / 1000) : 0.016;
    App.lastTs = ts;
    if (App.playing) {
      App.time += dt * App.speed;
      const dur = durationOf();
      // 一次性效果：走到末尾就停住，停在最后一帧而不是继续累加时间
      if (dur > 0 && !App.doc.loop && App.time >= dur) {
        App.time = dur;
        App.playing = false;
        App.doc.ui.playing = false;
        syncPlayButton();
        syncScrub();
      }
      App.needsRender = true;
    }
    if (!App.needsRender) return;
    App.needsRender = false;
    renderFrame(dt);
  }

  /** 一次性效果的时长；0 表示无限循环 */
  function durationOf() {
    if (!App.doc) return 0;
    const d = Number(App.doc.duration);
    return isFinite(d) && d > 0 ? d : 0;
  }

  function dateVec() {
    const d = new Date();
    return [d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()];
  }

  function sourceTex() {
    if (!App.doc) return null;
    const entry = App.assets.byId(App.doc.source) || App.assets.items[0];
    if (!entry) return null;
    return App.assets.getTexture(entry);
  }

  function renderFrame(dt) {
    const out = outputSize();
    const dur = durationOf();
    const state = {
      output: out,
      passes: App.doc.passes,
      time: App.time,
      mouse: App.mouse,
      viewPassId: App.doc.viewPassId,
      compare: App.compare,
      // 一次性效果的时间轴：u_t01 是 0→1 的归一化进度
      t01: dur > 0 ? SL.clamp(App.time / dur, 0, 1) : 0,
      duration: dur,
      playing: App.playing,
      // 透明输出时把清屏 alpha 设为 0，预览背景才能透出来
      clearAlpha: App.doc.alpha ? 0 : 1
    };
    const env = {
      source: sourceTex(),
      assets: App.assets.textureMap(),
      delta: dt,
      frame: App.frame++,
      date: dateVec()
    };
    let res;
    try {
      res = App.engine.render(state, env);
    } catch (e) {
      if (!App.__renderErr) {
        App.__renderErr = String(e && e.message || e);
        SL.ui.toast('渲染出错：' + App.__renderErr, 'bad');
      }
      return;
    }
    updateStats(res.ms, res.gpu);
    updateTimeReadout();
    syncResolutionLabel(out);
    if (dur > 0) syncScrub();

    // 逐 Pass 耗时：最多每 600ms 就地更新左栏标签（不重建列表，避免打断拖拽/改名）
    if (res.passMs) {
      App.passMs = res.passMs;
      const now = performance.now();
      if (now - App.pipelineT > 600) {
        App.pipelineT = now;
        updatePassTimes();
      }
    }
  }

  /** 只更新每个 Pass 条目的耗时徽标 */
  function updatePassTimes() {
    const list = $('#pass-list');
    if (!list) return;
    SL.$$('.pass-item', list).forEach(function (el) {
      const id = el.dataset.id;
      const tags = el.querySelector('.pass-tags');
      if (!tags) return;
      let t = tags.querySelector('.ptag.time');
      const ms = App.passMs[id];
      const pass = App.doc.passes.filter(function (p) { return p.id === id; })[0];
      if (ms == null || !pass || pass.enabled === false) {
        if (t) t.remove();
        return;
      }
      if (!t) {
        t = SL.h('span', { class: 'ptag time', title: '该 Pass 的 GPU 耗时' });
        tags.appendChild(t);
      }
      t.textContent = SL.fmt(ms, 2) + 'ms';
    });
  }

  function paneSize() {
    const el = $('#preview-pane');
    if (!el) return { w: 640, h: 360 };
    return {
      w: Math.max(64, el.clientWidth),
      h: Math.max(64, el.clientHeight)
    };
  }

  function outputSize() {
    let w, h;
    if (App.doc.resMode === 'custom') {
      w = App.doc.output.w;
      h = App.doc.output.h;
    } else {
      const p = paneSize();
      w = Math.round(p.w * dpr());
      h = Math.round(p.h * dpr());
    }
    return {
      w: SL.clamp(Math.round(w), 16, MAX_EDGE),
      h: SL.clamp(Math.round(h), 16, MAX_EDGE)
    };
  }

  /** 画布 CSS 尺寸 = 渲染尺寸 / dpr，缩放只作用于 transform */
  function syncStage() {
    const out = outputSize();
    const c = $('#gl');
    const cssW = out.w / dpr();
    const cssH = out.h / dpr();
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    $('#preview-stage').style.width = cssW + 'px';
    $('#preview-stage').style.height = cssH + 'px';
    syncResolutionLabel(out);
  }

  function syncResolutionLabel(out) {
    const o = out || outputSize();
    $('#res-label').textContent = o.w + ' × ' + o.h;
    const hdr = App.doc.passes.some(function (p) { return p.format === 'hdr' && p.enabled !== false; });
    const badge = $('#fmt-badge');
    badge.textContent = hdr ? 'HDR' : 'RGBA8';
    badge.title = hdr
      ? (App.engine.caps.hdr ? '至少一个 Pass 使用 RGBA16F 浮点缓冲' : '有 Pass 要求 HDR，但当前设备不支持 EXT_color_buffer_float，已退回 RGBA8')
      : '全部 Pass 使用 RGBA8 缓冲';
    const vb = $('#view-badge');
    if (App.doc.viewPassId) {
      vb.classList.remove('hidden');
      const p = App.doc.passes.filter(function (x) { return x.id === App.doc.viewPassId; })[0];
      vb.textContent = '查看：' + (p ? p.name : '中间 Pass') + ' ✕';
    } else {
      vb.classList.add('hidden');
    }
  }

  function updateStats(ms, gpu) {
    App.msAcc = ms;
    App.gpuTimer = gpu;
    App.fpsN++;
    const now = performance.now();
    if (!App.fpsT) App.fpsT = now;
    if (now - App.fpsT >= 400) {
      App.fps = Math.round((App.fpsN * 1000) / (now - App.fpsT));
      App.fpsN = 0;
      App.fpsT = now;
      $('#stat-fps').textContent = App.fps > 0 ? App.fps + ' fps' : '— fps';
      const el = $('#stat-ms');
      const v = ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
      el.textContent = (gpu ? 'GPU ' : 'CPU ') + v + ' ms';
      el.title = gpu
        ? 'GPU 执行耗时（EXT_disjoint_timer_query_webgl2 实测）'
        : '当前浏览器不支持 GPU 计时，显示的是 CPU 提交一帧的耗时';
    }
  }

  function updateTimeReadout() {
    $('#time-readout').textContent = App.time.toFixed(2) + 's';
  }

  /* ========================================================================
     五、预设 / 时间
     ====================================================================== */
  function confirmDiscard() {
    if (!App.doc.custom) return Promise.resolve(true);
    return SL.ui.confirm({
      title: '替换当前管线？',
      message: '当前管线有未保存到预设的改动，切换后会丢失。',
      detail: '需要保留的话，先用顶栏的「导出工程」存一份 JSON。',
      okLabel: '仍然切换',
      cancelLabel: '取消',
      danger: true
    });
  }

  function loadPreset(id) {
    if (!id) return;
    confirmDiscard().then(function (ok) {
      if (!ok) {
        $('#preset-select').value = App.doc.presetId;
        return;
      }
      const p = SL.presets.get(id);
      const doc = SL.store.defaultState(id);
      const keep = SL.deepClone(App.doc.assets || []);
      doc.assets = keep;
      doc.ui = SL.deepClone(App.doc.ui);
      doc.ui.playing = App.playing;
      doc.resMode = App.doc.resMode;
      const next = SL.store.normalize(doc);
      applyDoc(next);
      App.time = 0;
      App.frame = 0;
      $('#preset-select').value = id;
      const note = p.note;
      if (note) SL.ui.toast(note, 'info');
      SL.store.save(next);
    });
  }

  function togglePlay() {
    App.playing = !App.playing;
    App.doc.ui.playing = App.playing;
    // 一次性效果播放到结尾再按播放，从头开始
    if (App.playing) {
      const dur = durationOf();
      if (dur > 0 && !App.doc.loop && App.time >= dur - 1e-4) App.time = 0;
    }
    syncPlayButton();
    App.needsRender = true;
    App.save && App.save();
  }

  function syncPlayButton() {
    const b = $('#btn-play');
    if (!b) return;
    b.innerHTML = SL.icon(App.playing ? 'pause' : 'play', 15);
    b.title = App.playing ? '暂停 (Space)' : '播放 (Space)';
    b.classList.toggle('on', App.playing);
    const fps = $('#stat-fps');
    if (fps) {
      fps.textContent = App.playing ? (App.fps > 0 ? App.fps + ' fps' : '— fps') : '暂停';
      fps.title = App.playing ? '渲染帧率' : '时间已暂停，改参数时会补渲染一帧';
    }
  }

  function stepFrame(dir) {
    App.playing = false;
    App.doc.ui.playing = false;
    syncPlayButton();
    App.time = Math.max(0, App.time + (dir < 0 ? -1 : 1) / 60);
    App.needsRender = true;
    updateTimeReadout();
  }

  function resetTime() {
    App.time = 0;
    App.frame = 0;
    App.needsRender = true;
    updateTimeReadout();
    syncScrub();
  }

  /* ========================================================================
     五之二、效果库：从 effects/ 的包加载到编辑器
     ====================================================================== */
  /** 把效果包解析成一份可用的文档（异步：文件型输入图要先注册成资源） */
  function buildDocFromEffect(eff) {
    const jobs = (eff.assets || []).map(function (a) {
      if (a.kind === 'builtin') return Promise.resolve({ slot: a.slot, assetId: 'b:' + a.builtin });
      const exist = App.assets.items.filter(function (it) {
        return it.name === a.name && it.kind === 'file';
      })[0];
      if (exist) return Promise.resolve({ slot: a.slot, assetId: exist.id });
      return App.assets.importDataURL(a.name, a.dataURL).then(function (entry) {
        return { slot: a.slot, assetId: entry.id };
      });
    });

    return Promise.all(jobs).then(function (pairs) {
      const map = {};
      pairs.forEach(function (x) { if (x && x.assetId) map[x.slot] = x.assetId; });

      const passes = (eff.passes || []).map(function (p, i) {
        const bindings = {};
        Object.keys(p.bindings || {}).forEach(function (s) {
          const b = p.bindings[s];
          if (b.kind === 'asset') bindings[s] = { kind: 'asset', assetId: map[b.input] };
          else if (b.kind === 'pass') bindings[s] = { kind: 'pass', passId: b.pass };
          else bindings[s] = { kind: b.kind };
        });
        return {
          id: p.id || ('p' + (i + 1)),
          name: p.name || ('Pass ' + (i + 1)),
          code: p.code,
          enabled: true,
          format: p.format === 'hdr' ? 'hdr' : 'rgba8',
          scale: p.scale || 1,
          filter: 'linear',
          wrap: 'clamp',
          bindings: bindings,
          values: SL.deepClone(p.values || {})
        };
      });

      return {
        presetId: 'effect:' + eff.id,
        effectId: eff.id,
        effectBuiltAt: (window.SL_EFFECTS && window.SL_EFFECTS.builtAt) || null,
        custom: false,
        source: App.doc.source || 'b:testcard',
        output: { w: eff.output.w, h: eff.output.h },
        resMode: App.doc.resMode,
        alpha: !!eff.output.alpha,
        duration: eff.duration || 0,
        loop: eff.loop !== false,
        previewBg: App.doc.previewBg || 'checker',
        passes: passes,
        selectedPassId: passes[0] ? passes[0].id : null,
        assets: SL.deepClone(App.doc.assets || []),
        ui: SL.deepClone(App.doc.ui)
      };
    });
  }

  function loadEffect(id, skipConfirm) {
    const eff = libraryEffects().filter(function (e) { return e.id === id; })[0];
    if (!eff) {
      SL.ui.toast('效果库里没有「' + id + '」，先跑 node tools/lib.mjs build', 'warn');
      return Promise.resolve(false);
    }
    const ask = skipConfirm ? Promise.resolve(true) : confirmDiscard();
    return ask.then(function (ok) {
      if (!ok) {
        $('#preset-select').value = App.doc.presetId;
        return false;
      }
      return buildDocFromEffect(eff).then(function (doc) {
        const next = SL.store.normalize(doc);
        next.ui.playing = true;
        next.ui.zoom = 1;
        applyDoc(next);
        App.time = 0;
        App.frame = 0;
        App.playing = true;
        syncPlayButton();
        updateTimeReadout();
        syncScrub();
        $('#preset-select').value = next.presetId;
        const kb = eff.tags && eff.tags.length ? ' · ' + eff.tags.join(' / ') : '';
        SL.ui.toast(eff.name + kb + (eff.desc ? '\n' + eff.desc : ''), 'info');
        SL.store.save(next);
        return true;
      });
    });
  }

  /* ---------------------------- 时间轴 ---------------------------- */
  function syncScrub() {
    const row = $('#scrub-row');
    if (!row) return;
    const dur = durationOf();
    if (!(dur > 0)) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const t = SL.clamp(App.time, 0, dur);
    const el = $('#scrub');
    if (el && document.activeElement !== el) el.value = String(Math.round((t / dur) * 1000));
    $('#scrub-time').textContent = t.toFixed(2) + ' / ' + dur.toFixed(2) + 's';
    const nm = $('#scrub-name');
    if (nm) nm.textContent = App.playing ? '播放中' : '拖动查看';
  }

  /* ---------------------------- 预览背景 ---------------------------- */
  const BG_MODES = ['checker', 'dark', 'light', 'source'];
  const BG_LABEL = { checker: '棋盘', dark: '深色', light: '浅色', source: '输入图' };

  function applyPreviewBg() {
    const st = $('#preview-stage');
    if (!st || !App.doc) return;
    const mode = BG_MODES.indexOf(App.doc.previewBg) >= 0 ? App.doc.previewBg : 'checker';
    st.classList.remove('bg-checker', 'bg-dark', 'bg-light', 'bg-source');
    st.classList.add('bg-' + mode);
    st.classList.toggle('alpha', !!App.doc.alpha);
    if (mode === 'source') {
      const entry = App.assets.byId(App.doc.source);
      const url = entry ? App.assets.thumb(entry) : null;
      st.style.backgroundImage = url ? 'url("' + url + '")' : '';
    } else {
      st.style.backgroundImage = '';
    }
    const btn = $('#btn-bg');
    if (btn) {
      btn.setAttribute('aria-pressed', App.doc.alpha ? 'true' : 'false');
      btn.title = '预览背景：' + BG_LABEL[mode] + '（点一下切换；透明输出时才看得到）';
    }
    const lab = $('#bg-label');
    if (lab) lab.textContent = BG_LABEL[mode];
  }

  function cyclePreviewBg() {
    const cur = BG_MODES.indexOf(App.doc.previewBg) >= 0 ? App.doc.previewBg : 'checker';
    App.doc.previewBg = BG_MODES[(BG_MODES.indexOf(cur) + 1) % BG_MODES.length];
    applyPreviewBg();
    if (!App.doc.alpha) SL.ui.toast('当前管线输出不透明，背景被盖住了；要验证 alpha 请载入带透明的效果，或在分辨率菜单里打开透明输出', 'warn');
    setDirty();
  }

  /* ========================================================================
     五之三、图库浮层：网格 + 标签筛选 + 实时缩略图
     ====================================================================== */
  const libTags = [];      // 已选标签（空 = 全部）
  const libThumbs = {};    // effectId → dataURL
  let libQuery = '';

  function openLibrary() {
    const root = $('#library');
    if (!root) return;
    if (!root.dataset.ready) {
      const bd = SL.h('div', { class: 'lib-backdrop' });
      bd.addEventListener('pointerdown', closeLibrary);
      root.insertBefore(bd, root.firstChild);
      root.dataset.ready = '1';
    }
    root.classList.remove('hidden');
    renderLibrary();
    buildLibraryThumbs();
    const inp = $('#lib-search');
    if (inp) {
      inp.value = libQuery;
      setTimeout(function () { inp.focus(); inp.select(); }, 30);
    }
  }

  function closeLibrary() {
    const root = $('#library');
    if (root) root.classList.add('hidden');
  }

  function libraryOpen() {
    const root = $('#library');
    return !!root && !root.classList.contains('hidden');
  }

  function renderLibrary() {
    const grid = $('#lib-grid');
    if (!grid) return;
    const effects = libraryEffects();

    // 标签条
    const tagBox = $('#lib-tags');
    tagBox.innerHTML = '';
    const tags = [];
    effects.forEach(function (e) {
      (e.tags || []).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); });
    });
    tags.sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    if (tags.length) {
      const all = SL.h('button', { class: 'lib-tag' + (libTags.length ? '' : ' on'), type: 'button', text: '全部' });
      all.addEventListener('click', function () { libTags.length = 0; renderLibrary(); });
      tagBox.appendChild(all);
      tags.forEach(function (t) {
        const on = libTags.indexOf(t) >= 0;
        const b = SL.h('button', { class: 'lib-tag' + (on ? ' on' : ''), type: 'button', text: t });
        b.addEventListener('click', function () {
          const i = libTags.indexOf(t);
          if (i >= 0) libTags.splice(i, 1); else libTags.push(t);
          renderLibrary();
        });
        tagBox.appendChild(b);
      });
    }

    // 过滤
    const q = libQuery.trim().toLowerCase();
    const list = effects.filter(function (e) {
      if (libTags.length && !(e.tags || []).some(function (t) { return libTags.indexOf(t) >= 0; })) return false;
      if (!q) return true;
      const hay = (e.id + ' ' + e.name + ' ' + (e.desc || '') + ' ' + (e.tags || []).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    grid.innerHTML = '';
    if (!effects.length) {
      grid.appendChild(SL.h('div', {
        class: 'lib-empty',
        html: '效果库还是空的。<br>在 <code>effects/&lt;id&gt;/</code> 里放 <code>effect.json</code> + <code>shaders/*.frag</code>，' +
          '然后跑 <code>node tools/lib.mjs build</code>，刷新页面就能看到。'
      }));
    } else if (!list.length) {
      grid.appendChild(SL.h('div', { class: 'lib-empty', text: '没有匹配的效果，换个关键词或清掉标签过滤。' }));
    } else {
      list.forEach(function (e) { grid.appendChild(libCard(e)); });
    }

    $('#lib-count').textContent = list.length + (list.length !== effects.length ? ' / ' + effects.length : '');
    const built = window.SL_EFFECTS && window.SL_EFFECTS.builtAt;
    $('#lib-foot-right').textContent = built ? ('构建于 ' + new Date(built).toLocaleString()) : '';
  }

  function libCard(e) {
    const active = App.doc && App.doc.effectId === e.id;
    const card = SL.h('button', { class: 'lib-card' + (active ? ' on' : ''), type: 'button', 'data-id': e.id });
    const thumb = SL.h('div', { class: 'lib-thumb' });
    const url = libThumbs[e.id];
    if (url) thumb.appendChild(SL.h('img', { src: url, alt: e.name }));
    else thumb.appendChild(SL.h('span', { class: 'lib-thumb-empty', text: '渲染缩略图…' }));
    const dur = e.loop ? '循环' : (e.duration || 0).toFixed(2) + 's';
    thumb.appendChild(SL.h('span', { class: 'lib-badge', text: dur + (e.output && e.output.alpha ? ' · α' : '') }));
    card.appendChild(thumb);

    const meta = SL.h('div', { class: 'lib-meta' });
    meta.appendChild(SL.h('div', { class: 'lib-name', text: e.name }));
    if (e.desc) meta.appendChild(SL.h('div', { class: 'lib-desc', text: e.desc }));
    const tg = SL.h('div', { class: 'lib-card-tags' });
    (e.tags || []).slice(0, 4).forEach(function (t) { tg.appendChild(SL.h('span', { text: t })); });
    meta.appendChild(tg);
    card.appendChild(meta);
    card.title = e.name + (e.desc ? '\n' + e.desc : '') + '\n\n单击载入这个效果';
    card.addEventListener('click', function () {
      closeLibrary();
      loadEffect(e.id);
    });
    return card;
  }

  /** 给每张卡渲染一张实时缩略图（用主引擎离屏渲一帧，不落盘） */
  function buildLibraryThumbs() {
    const effects = libraryEffects();
    const todo = effects.filter(function (e) { return !libThumbs[e.id]; });
    let chain = Promise.resolve();
    todo.forEach(function (eff) {
      chain = chain.then(function () {
        return buildDocFromEffect(eff).then(function (doc) {
          const url = renderEffectThumb(doc);
          if (url) {
            libThumbs[eff.id] = url;
            const card = document.querySelector('.lib-card[data-id="' + eff.id + '"] .lib-thumb');
            if (card) {
              card.innerHTML = '';
              card.appendChild(SL.h('img', { src: url, alt: eff.name }));
              const dur = eff.loop ? '循环' : (eff.duration || 0).toFixed(2) + 's';
              card.appendChild(SL.h('span', { class: 'lib-badge', text: dur + (eff.output && eff.output.alpha ? ' · α' : '') }));
            }
          }
        }).catch(function () { /* 单个效果渲染失败不影响其他 */ });
      });
    });
    chain.then(function () { App.needsRender = true; });
  }

  function renderEffectThumb(doc) {
    if (!App.engine.ok) return null;
    const dur = doc.duration > 0 ? doc.duration : 0;
    // 一次性效果取 70% 处的瞬间（此时拖尾最长，一眼能看出走向），循环效果取 1.35s
    const t = dur > 0 && !doc.loop ? dur * 0.7 : 1.35;

    // 缩略图不经过 compilePass，这里补一次参数默认值（否则 uniform 全是 0，画面是空的）
    doc.passes.forEach(function (p) {
      if (p.values && Object.keys(p.values).length) return;
      const parsed = SL.glsl.parseUniforms(p.code || '');
      SL.uniforms.init(p, parsed);
    });
    const state = {
      output: { w: 176, h: 176 },
      passes: doc.passes,
      time: t,
      mouse: [0, 0, 0, 0],
      viewPassId: null,
      compare: false,
      t01: dur > 0 ? SL.clamp(t / dur, 0, 1) : 0,
      duration: dur,
      playing: false,
      clearAlpha: doc.alpha ? 0 : 1
    };
    const entry = App.assets.byId(doc.source) || App.assets.items[0];
    const env = {
      source: entry ? App.assets.getTexture(entry) : null,
      assets: App.assets.textureMap(),
      delta: 0.016,
      frame: 1,
      date: dateVec()
    };
    try {
      return App.engine.snapshot(state, env, 176);
    } catch (e) {
      return null;
    }
  }

  /* ========================================================================
     六、预览：缩放 / 平移 / 取色 / 截屏
     ====================================================================== */
  function stageBase() {
    const sc = $('#preview-scroll');
    const st = $('#preview-stage');
    const pw = sc.clientWidth, ph = sc.clientHeight;
    const sw = st.offsetWidth, sh = st.offsetHeight;
    return { pw: pw, ph: ph, sw: sw, sh: sh };
  }

  /** 缩放后画面在预览区里的居中偏移（不叠加用户平移） */
  function baseOffset() {
    const b = stageBase();
    return { bx: (b.pw - b.sw * App.zoom) / 2, by: (b.ph - b.sh * App.zoom) / 2 };
  }

  function applyTransform() {
    const base = baseOffset();
    const x = Math.round((base.bx + App.panX) * 100) / 100;
    const y = Math.round((base.by + App.panY) * 100) / 100;
    $('#preview-stage').style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + App.zoom + ')';
    $('#zoom-readout').textContent = Math.round(App.zoom * 100) + '%';
    App.doc.ui.zoom = App.zoom;
  }

  function layoutZoom(resetPan) {
    if (resetPan) { App.panX = 0; App.panY = 0; }
    applyTransform();
  }

  function zoomAt(z, cx, cy) {
    const next = SL.clamp(z, 0.05, 8);
    if (Math.abs(next - App.zoom) < 1e-4) return;
    if (cx == null) {
      App.zoom = next;
      applyTransform();
      App.save && App.save();
      return;
    }
    const sc = $('#preview-scroll');
    const r = sc.getBoundingClientRect();
    const b = stageBase();
    // 光标在预览区内的位置
    const px = cx - r.left, py = cy - r.top;
    // 当前画面左上角的实际位置（居中偏移 + 平移）
    const fx = (b.pw - b.sw * App.zoom) / 2 + App.panX;
    const fy = (b.ph - b.sh * App.zoom) / 2 + App.panY;
    const k = next / App.zoom;
    // 让光标下的那个点缩放后仍在原处
    App.panX = px - (px - fx) * k - (b.pw - b.sw * next) / 2;
    App.panY = py - (py - fy) * k - (b.ph - b.sh * next) / 2;
    App.zoom = next;
    applyTransform();
    App.save && App.save();
  }

  function fitView() {
    const base = stageBase();
    if (!base.sw || !base.sh) return;
    const z = Math.min(base.pw / base.sw, base.ph / base.sh);
    App.zoom = SL.clamp(z, 0.05, 8);
    App.panX = 0; App.panY = 0;
    applyTransform();
  }

  /** 换分辨率后：画面比预览区大就自动缩小到能看全，回到「适应窗口」则还原 1:1 */
  function autoFitAfterResize() {
    const base = stageBase();
    if (!base.sw || !base.sh) return;
    if (App.doc.resMode !== 'custom') {
      App.zoom = 1; App.panX = 0; App.panY = 0;
    } else if (base.sw > base.pw || base.sh > base.ph) {
      App.zoom = SL.clamp(Math.min(base.pw / base.sw, base.ph / base.sh), 0.05, 8);
      App.panX = 0; App.panY = 0;
    }
    applyTransform();
  }

  function bindPreview() {
    const pane = $('#preview-pane');
    const canvas = $('#gl');
    pane.addEventListener('wheel', function (e) {
      e.preventDefault();
      const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 18 : 1));
      zoomAt(App.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    // 中键 / 空格 + 拖动 = 平移
    let panning = false, space = false, lx = 0, ly = 0;
    pane.addEventListener('mousedown', function (e) {
      if (e.button === 1 || (e.button === 0 && space)) {
        e.preventDefault();
        panning = true; lx = e.clientX; ly = e.clientY;
        pane.classList.add('panning');
      }
    });
    window.addEventListener('mousemove', function (e) {
      if (!panning) return;
      App.panX += e.clientX - lx;
      App.panY += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      applyTransform();
    });
    window.addEventListener('mouseup', function () {
      if (!panning) return;
      panning = false;
      pane.classList.remove('panning');
      App.save && App.save();
    });
    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && !SL.isTypingTarget(e.target)) {
        space = true;
        if (!e.repeat) { e.preventDefault(); togglePlay(); }
      }
    });
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') space = false;
    });
    pane.addEventListener('mousedown', function (e) { if (e.button === 0 && !space) { /* 点击不做事，留给取色 */ } });

    // 取色 + 鼠标坐标
    let lastRead = 0;
    canvas.addEventListener('mousemove', function (e) {
      const r = canvas.getBoundingClientRect();
      const nx = (e.clientX - r.left) / Math.max(1, r.width);
      const ny = (e.clientY - r.top) / Math.max(1, r.height);
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      const cw = canvas.width, ch = canvas.height;
      App.mouse[0] = nx * cw;
      App.mouse[1] = (1 - ny) * ch;   // 与 vUv 一致：左下角原点
      App.needsRender = true;
      const now = performance.now();
      if (now - lastRead < 90) return;
      lastRead = now;
      const px = App.engine.readPixel(nx * cw, ny * ch);
      if (!px) return;
      App.mouse[2] = App.mouse[0];
      App.mouse[3] = App.mouse[1];
      showPixel(px);
    });
    canvas.addEventListener('mouseleave', function () {
      hideReadout();
    });
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      App.mouse[2] = App.mouse[0];
      App.mouse[3] = App.mouse[1];
    });

    // 缩放按钮
    $('#zoom-in').addEventListener('click', function () { zoomAt(App.zoom * 1.25); });
    $('#zoom-out').addEventListener('click', function () { zoomAt(App.zoom / 1.25); });
    $('#zoom-fit').addEventListener('click', fitView);
    $('#zoom-100').addEventListener('click', function () {
      App.zoom = 1; App.panX = 0; App.panY = 0; applyTransform(); App.save && App.save();
    });

    $('#view-badge').addEventListener('click', function () {
      App.doc.viewPassId = null;
      App.needsRender = true;
      renderPipeline();
      syncResolutionLabel();
    });

    // 对比原图 / 专注模式
    $('#btn-compare').addEventListener('click', function () { setCompare(!App.compare); });
    $('#btn-zen').addEventListener('click', function () { setZen(!App.zen); });

    // 双击预览 = 适应窗口
    pane.addEventListener('dblclick', function (e) {
      if (e.target.closest('.chip, .pane-top, .pane-bottom')) return;
      fitView();
    });

    // Shift + 点击 = 把这点的颜色复制成 #RRGGBB
    canvas.addEventListener('click', function (e) {
      if (!e.shiftKey || !App.lastPixel) return;
      const p = App.lastPixel;
      const hex = '#' + [p[0], p[1], p[2]].map(function (v) {
        return SL.pad2(Math.round(SL.clamp(v, 0, 1) * 255).toString(16));
      }).join('').toUpperCase();
      copyText(hex).then(function () {
        SL.ui.toast('已复制 ' + hex, 'ok');
      }).catch(function () {
        SL.ui.toast('复制失败：' + hex, 'warn');
      });
    });

    // 拖拽窗口 → 自适应分辨率
    let rzT = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rzT);
      rzT = setTimeout(function () {
        syncStage();
        applyTransform();
        App.needsRender = true;
      }, 160);
    });

    $('#res-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      openResMenu($('#res-btn'));
    });
  }

  function showPixel(px) {
    if (!px) { hideReadout(); return; }
    App.lastPixel = px;
    const hex = SL.rgb01ToHex(px[0], px[1], px[2]);
    const el = $('#hover-readout');
    el.classList.remove('hidden');
    el.innerHTML = '';
    el.appendChild(SL.h('span', { class: 'swatch', style: 'background:' + hex }));
    el.appendChild(SL.h('b', { text: hex.toUpperCase() }));
    el.appendChild(SL.h('span', {
      text: [px[0], px[1], px[2]].map(function (v) { return v.toFixed(3); }).join(' ')
    }));
  }

  function hideReadout() {
    const el = $('#hover-readout');
    if (!el) return;
    el.innerHTML = '';
    el.classList.add('hidden');
  }

  /** 对比模式：跳过整条管线直接显示输入图 */
  function setCompare(on) {
    App.compare = !!on;
    const btn = $('#btn-compare');
    if (btn) btn.setAttribute('aria-pressed', App.compare ? 'true' : 'false');
    App.needsRender = true;
  }

  /** 专注模式：收起左右栏与编辑器，只留预览 */
  function setZen(on) {
    App.zen = !!on;
    document.body.classList.toggle('zen', App.zen);
    const btn = $('#btn-zen');
    if (btn) btn.setAttribute('aria-pressed', App.zen ? 'true' : 'false');
    // 预览区尺寸变了，等一帧再重算画布
    requestAnimationFrame(function () {
      syncStage();
      applyTransform();
      App.needsRender = true;
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = SL.h('textarea', { style: 'position:fixed;top:-99px;left:0;opacity:0', value: text });
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? resolve() : reject(new Error('copy rejected'));
      } catch (e) { reject(e); }
    });
  }

  function openResMenu(anchor) {
    const wrap = SL.h('div', { style: 'min-width:190px' });
    const opts = [
      ['适应窗口', function () { setResMode('fit'); }],
      ['1280 × 720', function () { setCustomRes(1280, 720); }],
      ['1920 × 1080', function () { setCustomRes(1920, 1080); }],
      ['1080 × 1080', function () { setCustomRes(1080, 1080); }],
      ['2048 × 1152', function () { setCustomRes(2048, 1152); }]
    ];
    wrap.appendChild(SL.h('div', { class: 'ctxmenu-label', text: '输出分辨率' }));
    opts.forEach(function (o) {
      const it = SL.h('div', { class: 'ctxmenu-item', text: o[0] });
      it.addEventListener('click', function () { close(); o[1](); });
      wrap.appendChild(it);
    });
    const sep = SL.h('div', { class: 'ctxmenu-sep' });
    wrap.appendChild(sep);
    const custom = SL.h('div', { class: 'ctxmenu-item', text: '自定义尺寸…' });
    custom.addEventListener('click', function () { close(); openCustomRes(); });
    wrap.appendChild(custom);

    const sep2 = SL.h('div', { class: 'ctxmenu-sep' });
    wrap.appendChild(sep2);
    const alpha = SL.h('div', { class: 'ctxmenu-item row' },
      SL.h('span', { class: 'lbl', text: '透明输出（alpha）' }),
      SL.h('span', { class: 'key', text: App.doc.alpha ? '开' : '关' }));
    alpha.title = '开启后画布按 alpha 合成，预览背景（棋格 / 深色 / 浅色 / 输入图）会透出来';
    alpha.addEventListener('click', function () {
      close();
      App.doc.alpha = !App.doc.alpha;
      applyPreviewBg();
      App.needsRender = true;
      setDirty();
      SL.ui.toast(App.doc.alpha ? '已开启透明输出：用预览里的「背景」按钮检查 alpha' : '已关闭透明输出', 'info');
    });
    wrap.appendChild(alpha);

    const pop = SL.ui.popover(anchor, wrap, { align: 'left' });
    const close = pop.close;
  }

  function setResMode(mode) {
    App.doc.resMode = mode;
    syncStage();
    autoFitAfterResize();
    App.needsRender = true;
    setDirty();
  }

  function setCustomRes(w, h) {
    App.doc.resMode = 'custom';
    App.doc.output = { w: SL.clamp(Math.round(w), 16, MAX_EDGE), h: SL.clamp(Math.round(h), 16, MAX_EDGE) };
    syncStage();
    autoFitAfterResize();
    App.needsRender = true;
    setDirty();
  }

  function openCustomRes() {
    const wIn = SL.h('input', { class: 'uni-num', type: 'number', value: App.doc.output.w, min: 16, max: MAX_EDGE, style: 'width:90px' });
    const hIn = SL.h('input', { class: 'uni-num', type: 'number', value: App.doc.output.h, min: 16, max: MAX_EDGE, style: 'width:90px' });
    const body = SL.h('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)' },
      SL.h('span', { text: '宽' }), wIn, SL.h('span', { text: '×' }), SL.h('span', { text: '高' }), hIn);
    const ok = SL.h('button', { class: 'btn primary', text: '应用' });
    const cancel = SL.h('button', { class: 'btn', text: '取消' });
    const sp = SL.h('span', { class: 'grow' });
    const m = SL.ui.modal({ title: '自定义输出分辨率', icon: 'grid', body: body, footer: [sp, cancel, ok], narrow: true });
    cancel.addEventListener('click', m.close);
    ok.addEventListener('click', function () {
      const w = parseInt(wIn.value, 10), h = parseInt(hIn.value, 10);
      if (!isFinite(w) || !isFinite(h)) { SL.ui.toast('请输入有效数字', 'warn'); return; }
      setCustomRes(w, h);
      m.close();
    });
    setTimeout(function () { wIn.focus(); wIn.select(); }, 30);
  }

  /* ========================================================================
     七、编辑器
     ====================================================================== */
  function initEditor() {
    App.editor = new SL.CodeEditor({
      textarea: $('#code'),
      pre: $('#highlight'),
      gutter: $('#gutter'),
      errRows: $('#err-rows'),
      curLine: $('#cur-line'),
      fontSize: (App.doc && App.doc.ui && App.doc.ui.editorFont) || 12.5,
      onChange: function (code) {
        const pass = selectedPass();
        if (!pass) return;
        pass.code = code;
        setDirty();
        App.needsRender = true;
        updateEditorSub();
        if (App.autoCompile) recompile();
      },
      onCompile: function () { compileNow(); },
      onCursor: function (line, col) {
        const s = $('#editor-sub');
        s.dataset.cursor = line + ':' + col;
      }
    });

    $('#btn-compile').addEventListener('click', compileNow);
    $('#btn-snippets').addEventListener('click', function (e) {
      e.stopPropagation();
      openSnippets($('#btn-snippets'));
    });
    $('#auto-toggle').addEventListener('change', function (e) {
      App.autoCompile = e.target.checked;
      if (App.autoCompile) recompile();
    });
  }

  function updateEditorSub() {
    const pass = selectedPass();
    if (!pass) return;
    const out = outputSize();
    const sz = passSize(pass, out);
    const uni = App.parsed[pass.id] || [];
    const lines = (pass.code || '').split('\n').length;
    $('#editor-sub').textContent = sz.w + '×' + sz.h + ' · ' + (pass.format === 'hdr' ? 'RGBA16F' : 'RGBA8') +
      ' · ' + uni.length + ' uniform · ' + lines + ' 行';
  }

  function syncEditorChrome() {
    const pass = selectedPass();
    if (!pass) return;
    const res = App.compiled[pass.id];
    const dot = $('#compile-dot');
    const pill = $('#compile-pill');
    const errList = $('#err-list');
    dot.className = 'dot';
    pill.className = 'pill';

    $('#editor-title').textContent = pass.name;
    updateEditorSub();

    if (!res) {
      pill.textContent = '未编译';
      return;
    }
    const errs = (res.errors || []).filter(function (e) { return e.severity !== 'warn'; });
    const warns = (res.errors || []).filter(function (e) { return e.severity === 'warn'; });
    errList.innerHTML = '';

    if (res.ok) {
      dot.classList.add('ok');
      pill.classList.add('ok');
      const w = (res.built && res.built.warnings) || [];
      pill.textContent = w.length ? '编译通过 · ' + w.length + ' 条提示' : '编译通过';
    } else {
      dot.classList.add('bad');
      pill.classList.add('bad');
      pill.textContent = errs.length + ' 个错误';
    }
    if (warns.length && res.ok) {
      warns.slice(0, 3).forEach(function (w) {
        errList.appendChild(errItem(w, 'warn'));
      });
    }
    if (!res.ok) {
      errs.slice(0, 8).forEach(function (e) {
        errList.appendChild(errItem(e, 'error'));
      });
      if (errs.length > 8) {
        errList.appendChild(SL.h('div', { class: 'insp-note', text: '还有 ' + (errs.length - 8) + ' 条错误…' }));
      }
    }
    if (res.ok && res.built && res.built.warnings && res.built.warnings.length) {
      res.built.warnings.slice(0, 3).forEach(function (msg) {
        errList.appendChild(SL.h('div', { class: 'err-item warn' },
          SL.h('span', { class: 'loc', text: '提示' }),
          SL.h('span', { class: 'msg', text: msg })));
      });
    }

    App.editor.setErrors(res.ok ? [] : errs);
  }

  function errItem(e, sev) {
    const it = SL.h('div', { class: 'err-item' + (sev === 'warn' ? ' warn' : '') });
    it.appendChild(SL.h('span', { class: 'loc', text: e.line > 0 ? '第 ' + e.line + ' 行' : '—' }));
    it.appendChild(SL.h('span', { class: 'msg', text: e.message }));
    if (e.line > 0) {
      it.addEventListener('click', function () { App.editor.gotoLine(e.line); });
    }
    return it;
  }

  function openSnippets(anchor) {
    const wrap = SL.h('div', { style: 'min-width:260px;max-height:340px;overflow:auto' });
    wrap.appendChild(SL.h('div', { class: 'ctxmenu-label', text: '常用片段' }));
    SL.glsl.SNIPPETS.forEach(function (s) {
      const it = SL.h('div', { class: 'ctxmenu-item' });
      it.appendChild(SL.h('div', { text: s.label }));
      it.appendChild(SL.h('small', { text: s.desc }));
      it.addEventListener('click', function () {
        pop.close();
        App.editor.insert(s.code);
        compileNow();
      });
      wrap.appendChild(it);
    });
    const pop = SL.ui.popover(anchor, wrap, { align: 'right' });
  }

  /* ========================================================================
     八、管线面板
     ====================================================================== */
  function renderPipeline() {
    if (!App.doc) return;
    const errors = {};
    App.doc.passes.forEach(function (p) {
      const res = App.compiled[p.id];
      if (res && !res.ok) {
        errors[p.id] = (res.errors || []).filter(function (e) { return e.severity !== 'warn'; });
      }
    });
    SL.pipeline.render({
      list: $('#pass-list'),
      passes: App.doc.passes,
      selectedId: App.doc.selectedPassId,
      errors: errors,
      passMs: App.passMs,
      uniformsOf: function (id) { return App.parsed[id] || []; },
      onSelect: function (id) { selectPass(id); },
      onToggle: function (id) {
        const p = App.doc.passes.filter(function (x) { return x.id === id; })[0];
        if (!p) return;
        p.enabled = !p.enabled;
        App.needsRender = true;
        renderPipeline();
        setDirty();
      },
      onRename: function (id, name) {
        const p = App.doc.passes.filter(function (x) { return x.id === id; })[0];
        if (!p) return;
        p.name = name;
        if (App.doc.selectedPassId === id) $('#editor-title').textContent = name;
        renderPipeline();
        setDirty();
      },
      onReorder: function (fromId, toId, after) {
        const arr = App.doc.passes;
        const from = arr.findIndex(function (p) { return p.id === fromId; });
        let to = arr.findIndex(function (p) { return p.id === toId; });
        if (from < 0 || to < 0 || from === to) return;
        const item = arr.splice(from, 1)[0];
        to = arr.findIndex(function (p) { return p.id === toId; });
        arr.splice(after ? to + 1 : to, 0, item);
        App.needsRender = true;
        compileAll();
        renderPipeline();
        renderInspector();
        setDirty();
      },
      onMenu: function (id, x, y) { openPassMenu(id, x, y); },
      onAdd: function () { addPass(); }
    });
    $('#pass-count').textContent = App.doc.passes.length;
    $('#pipeline-meta').textContent = SL.pipeline.metaText(App.doc.passes);
  }

  function passSize(pass, out) {
    const o = out || outputSize();
    const s = pass.scale || 1;
    return { w: Math.max(1, Math.round(o.w * s)), h: Math.max(1, Math.round(o.h * s)) };
  }

  let ctxMenuOpen = false;
  function hideCtxMenu() {
    const menu = $('#ctxmenu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.innerHTML = '';
    ctxMenuOpen = false;
  }
  /** 右键菜单的「点外面 / Esc 关闭」只装一次，避免每次打开都叠一个监听 */
  function bindCtxMenuGuard() {
    document.addEventListener('pointerdown', function (e) {
      if (!ctxMenuOpen) return;
      const menu = $('#ctxmenu');
      if (menu && menu.contains(e.target)) return;
      hideCtxMenu();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (!ctxMenuOpen || e.key !== 'Escape') return;
      e.stopPropagation();
      hideCtxMenu();
    }, true);
  }

  function openPassMenu(id, x, y) {
    const pass = App.doc.passes.filter(function (p) { return p.id === id; })[0];
    if (!pass) return;
    const menu = $('#ctxmenu');
    menu.innerHTML = '';
    menu.classList.remove('hidden');
    ctxMenuOpen = true;

    function item(label, fn, danger, key) {
      const it = SL.h('div', { class: 'ctxmenu-item', style: danger ? 'color:#ff9caa' : null, title: label });
      it.appendChild(SL.h('span', { class: 'lbl', text: label }));
      if (key) it.appendChild(SL.h('span', { class: 'key', text: key }));
      it.addEventListener('click', function () { hideCtxMenu(); fn(); });
      menu.appendChild(it);
    }
    function sep() { menu.appendChild(SL.h('div', { class: 'ctxmenu-sep' })); }
    function label(text) { menu.appendChild(SL.h('div', { class: 'ctxmenu-label', text: text })); }

    label(pass.name + (pass.enabled === false ? '（已停用）' : ''));
    item((App.doc.viewPassId === pass.id ? '◉ ' : '') + '查看此 Pass 输出', function () {
      App.doc.viewPassId = pass.id;
      App.needsRender = true;
      renderPipeline();
      syncResolutionLabel();
    });
    item(pass.enabled === false ? '启用此 Pass' : '停用此 Pass', function () {
      togglePass(pass);
    }, false, 'Ctrl+E');
    item('重命名…', function () {
      SL.ui.prompt({
        title: '重命名 Pass', label: '名称', value: pass.name, okLabel: '保存'
      }).then(function (v) {
        if (v == null) return;
        const name = String(v).trim();
        if (!name) return;
        pass.name = name;
        if (App.doc.selectedPassId === pass.id) $('#editor-title').textContent = name;
        renderPipeline();
        setDirty();
      });
    });
    item('复制这个 Pass', function () { duplicatePass(pass); }, false, 'Ctrl+D');
    item('在下方插入 Pass', function () {
      App.doc.selectedPassId = pass.id;
      addPass();
    }, false, 'N');
    sep();
    label('缓冲格式');
    item(pass.format === 'hdr' ? '改用 RGBA8（默认）' : '改用 RGBA16F（HDR）', function () {
      pass.format = pass.format === 'hdr' ? 'rgba8' : 'hdr';
      App.needsRender = true;
      renderPipeline();
      syncResolutionLabel();
      setDirty();
    });
    label('分辨率倍率');
    [1, 0.5, 0.25].forEach(function (s) {
      item((s === 1 ? '1×' : s === 0.5 ? '1/2×（省一半显存）' : '1/4×') + (pass.scale === s ? ' ✓' : ''), function () {
        pass.scale = s;
        App.needsRender = true;
        renderPipeline();
        setDirty();
      });
    });
    sep();
    item('上移', function () { movePass(pass, -1); }, false, 'Ctrl+↑');
    item('下移', function () { movePass(pass, 1); }, false, 'Ctrl+↓');
    sep();
    item('只显示这个 Pass', function () {
      App.doc.passes.forEach(function (p) { p.enabled = (p.id === pass.id); });
      App.needsRender = true;
      renderPipeline();
      setDirty();
    });
    item('导出此 Pass 为 PNG', function () { exportPassImage(pass); });
    sep();
    item('删除此 Pass', function () { deletePass(pass); }, true, 'Del');

    const w = 210;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 320) + 'px';
  }

  /** 启用 / 停用某个 Pass（停用只是不参与渲染，代码和参数都留着） */
  function togglePass(pass) {
    if (!pass) return;
    pass.enabled = pass.enabled === false;
    App.needsRender = true;
    renderPipeline();
    syncResolutionLabel();
    setDirty();
    SL.ui.toast((pass.enabled === false ? '已停用「' : '已启用「') + pass.name + '」', 'info');
  }

  function movePass(pass, dir) {
    const arr = App.doc.passes;
    const i = arr.indexOf(pass);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    arr.splice(i, 1);
    arr.splice(j, 0, pass);
    App.needsRender = true;
    renderPipeline();
    setDirty();
  }

  function deletePass(pass) {
    const arr = App.doc.passes;
    if (arr.length <= 1) {
      SL.ui.toast('至少要保留一个 Pass', 'warn');
      return;
    }
    const i = arr.indexOf(pass);
    arr.splice(i, 1);
    if (App.doc.selectedPassId === pass.id) {
      const next = arr[Math.min(i, arr.length - 1)];
      App.doc.selectedPassId = next ? next.id : null;
    }
    if (App.doc.viewPassId === pass.id) App.doc.viewPassId = null;
    compileAll();
    selectPass(App.doc.selectedPassId, true);
    renderPipeline();
    syncResolutionLabel();
    setDirty();
    SL.ui.toast('已删除「' + pass.name + '」', 'info', {
      label: '撤销',
      fn: function () {
        App.doc.passes.splice(Math.min(i, App.doc.passes.length), 0, pass);
        compileAll();
        selectPass(pass.id);
        renderPipeline();
        renderInspector();
        App.needsRender = true;
        setDirty();
      }
    });
  }

  /** 把这个 Pass 的输出单独存成 PNG（临时切到该 Pass 看一眼，再读画布） */
  function exportPassImage(pass) {
    const prevView = App.doc.viewPassId;
    const wasPlaying = App.playing;
    App.doc.viewPassId = pass.id;
    App.playing = false;
    try {
      renderFrame(0);
      const url = App.engine.canvas.toDataURL('image/png');
      fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
        const safe = String(pass.name || pass.id).replace(/[^\w\u4e00-\u9fa5-]+/g, '-');
        SL.io.download('shaderlab-' + safe + '-' + stamp() + '.png', blob, 'image/png');
        SL.ui.toast('已导出「' + pass.name + '」', 'ok');
      }).catch(function (e) {
        SL.ui.toast('导出失败：' + (e && e.message || e), 'bad');
      });
    } finally {
      App.doc.viewPassId = prevView;
      App.playing = wasPlaying;
      App.needsRender = true;
      renderPipeline();
      syncResolutionLabel();
    }
  }

  function duplicatePass(pass) {    const copy = SL.deepClone(pass);
    copy.id = nextPassId();
    copy.name = pass.name + ' 副本';
    const i = App.doc.passes.indexOf(pass);
    App.doc.passes.splice(i + 1, 0, copy);
    compileAll();
    selectPass(copy.id);
    renderPipeline();
    setDirty();
  }

  function nextPassId() {
    let n = App.doc.passes.length + 1;
    const used = {};
    App.doc.passes.forEach(function (p) { used[p.id] = 1; });
    while (used['p' + n]) n++;
    return 'p' + n;
  }

  const NEW_PASS_CODE = [
    'uniform sampler2D u_tex;  // 上一 Pass 的输出（首个 Pass 时是「输入图」）',
    '',
    'uniform float u_gamma;  // @range 0.2 3 @step 0.01 @default 1 @label 伽马',
    'uniform float u_desat;  // @range 0 1 @step 0.01 @default 0 @label 去色',
    '',
    'void main() {',
    '  vec3 c = texture(u_tex, vUv).rgb;',
    '',
    '  // 起点：把这里换成你想测的算法',
    '  c = pow(max(c, 0.0), vec3(u_gamma));',
    '  c = mix(c, vec3(sl_luma(c)), u_desat);',
    '',
    '  fragColor = vec4(c, 1.0);',
    '}',
    ''
  ].join('\n');

  function addPass() {
    const cur = selectedPass();
    const pass = {
      id: nextPassId(),
      name: 'Pass ' + (App.doc.passes.length + 1),
      code: NEW_PASS_CODE,
      enabled: true,
      format: 'rgba8',
      scale: 1,
      filter: 'linear',
      wrap: 'clamp',
      bindings: {},
      values: {}
    };
    const i = cur ? App.doc.passes.indexOf(cur) : App.doc.passes.length - 1;
    App.doc.passes.splice(i + 1, 0, pass);
    compileAll();
    selectPass(pass.id);
    renderPipeline();
    setDirty();
    App.editor.focus();
  }

  function selectPass(id, silent) {
    if (!App.doc) return;
    let pass = null;
    for (let i = 0; i < App.doc.passes.length; i++) {
      if (App.doc.passes[i].id === id) { pass = App.doc.passes[i]; break; }
    }
    if (!pass) pass = App.doc.passes[0];
    if (!pass) return;
    App.doc.selectedPassId = pass.id;
    recompile.cancel();

    if (App.editor) {
      if (App.editor.getValue() !== pass.code) App.editor.setValue(pass.code, true);
    }
    if (!App.compiled[pass.id]) compilePass(pass);
    syncEditorChrome();
    renderInspector();
    if (!silent) {
      renderPipeline();
      // 让选中的 Pass 在左栏可见（Pass 多了以后键盘切换全靠这个）
      const item = $('#pass-list') && $('#pass-list').querySelector('.pass-item[data-id="' + pass.id + '"]');
      if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
      SL.store.save(App.doc);
    }
  }

  function bindPipelineButtons() {
    $('#btn-add-pass').addEventListener('click', addPass);
    $('#btn-add-pass-2').addEventListener('click', addPass);
  }

  /* ========================================================================
     九、检查器
     ====================================================================== */
  function bindInspector() {
    SL.$$('#inspector-tabs .tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.dataset.tab);
      });
    });
  }

  function setTab(tab) {
    App.doc.ui.tab = tab;
    SL.$$('#inspector-tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderInspector();
    App.save && App.save();
  }

  function renderInspector() {
    const pass = selectedPass();
    if (!pass) return;
    const tab = App.doc.ui.tab || 'uniforms';
    SL.$$('#inspector-tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const body = $('#inspector-body');
    const uni = App.parsed[pass.id] || [];
    const countEl = $('#uni-count');
    const params = uni.filter(function (u) { return u.kind !== 'sampler'; });
    countEl.textContent = params.length ? String(params.length) : '';
    countEl.classList.toggle('hidden', !params.length);
    countEl.title = params.length ? params.length + ' 个可调参数' : '';

    if (tab === 'uniforms') {
      SL.uniforms.render(body, {
        src: pass.code,
        pass: pass,
        passes: App.doc.passes,
        assets: App.assets,
        uniforms: uni,
        isFirst: App.doc.passes.indexOf(pass) === 0,
        onValueChange: function (name) {
          App.needsRender = true;
          setDirty();
        },
        onBindingChange: function () {
          App.needsRender = true;
          setDirty();
        },
        onRefresh: function () { renderInspector(); },
        bindingSize: bindingSize
      });
    } else if (tab === 'textures') {
      renderTextures(body);
    } else {
      renderInfo(body, pass);
    }
  }

  function bindingSize(binding) {
    if (!binding) return null;
    if (binding.kind === 'asset') {
      const a = App.assets.byId(binding.assetId);
      return a ? a.width + '×' + a.height : '缺失';
    }
    const out = outputSize();
    if (binding.kind === 'self' || binding.kind === 'prev') {
      const pass = selectedPass();
      if (!pass) return null;
      if (binding.kind === 'prev' && App.doc.passes.indexOf(pass) === 0) {
        const src = sourceTex();
        return src ? src.w + '×' + src.h + ' 输入图' : '输入图';
      }
      const sz = passSize(pass, out);
      return sz.w + '×' + sz.h;
    }
    if (binding.kind === 'pass') {
      if (binding.passId === '__source__') {
        const src = sourceTex();
        return src ? src.w + '×' + src.h : '源图';
      }
      const p = App.doc.passes.filter(function (x) { return x.id === binding.passId; })[0];
      if (!p) return '缺失';
      const sz = passSize(p, out);
      return sz.w + '×' + sz.h;
    }
    return null;
  }

  /* ------------------------------ 纹理页 ------------------------------ */
  function renderTextures(host) {
    host.innerHTML = '';

    const srcEntry = App.assets.byId(App.doc.source) || App.assets.items[0];
    const sec = SL.h('div', { class: 'insp-section' });
    const head = SL.h('div', { class: 'insp-head' });
    head.appendChild(SL.h('span', { text: '输入图' }));
    head.appendChild(SL.h('span', { class: 'count', text: srcEntry ? srcEntry.width + '×' + srcEntry.height : '无' }));
    sec.appendChild(head);

    if (srcEntry) {
      const sw = SL.h('div', { style: 'display:flex;gap:9px;padding:8px 12px 4px;align-items:center' });
      sw.appendChild(SL.h('img', {
        src: App.assets.thumb(srcEntry),
        style: 'width:64px;height:40px;object-fit:cover;border-radius:5px;border:1px solid var(--line);background:#000',
        alt: srcEntry.name
      }));
      const meta = SL.h('div', { style: 'min-width:0;flex:1' });
      meta.appendChild(SL.h('div', { style: 'font-size:11.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: srcEntry.name }));
      meta.appendChild(SL.h('div', { class: 'asset-meta', text: '首个 Pass 的 u_tex 默认取这张' }));
      sw.appendChild(meta);
      sec.appendChild(sw);
    }

    const selWrap = SL.h('div', { style: 'display:flex;gap:6px;padding:6px 12px 10px' });
    const sel = SL.h('select', { class: 'sel', style: 'flex:1' });
    App.assets.items.forEach(function (a) {
      const op = SL.h('option', { value: a.id, text: a.name + '  ' + a.width + '×' + a.height });
      if (srcEntry && a.id === srcEntry.id) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () {
      App.doc.source = sel.value;
      App.needsRender = true;
      renderTextures(host);
      renderInspector();
      setDirty();
    });
    selWrap.appendChild(sel);
    const imp = SL.h('button', { class: 'btn tiny primary', text: '导入…' });
    imp.addEventListener('click', function () { pickImages(); });
    selWrap.appendChild(imp);
    sec.appendChild(selWrap);
    host.appendChild(sec);

    // 资源库
    const sec2 = SL.h('div', { class: 'insp-section' });
    const h2 = SL.h('div', { class: 'insp-head' });
    h2.appendChild(SL.h('span', { text: '资源库' }));
    h2.appendChild(SL.h('span', { class: 'count', text: String(App.assets.items.length) }));
    sec2.appendChild(h2);

    const grid = SL.h('div', { class: 'asset-grid' });
    App.assets.items.forEach(function (a) {
      const isSrc = srcEntry && a.id === srcEntry.id;
      const card = SL.h('div', { class: 'asset' + (isSrc ? ' bound' : '') });
      const img = SL.h('img', { class: 'asset-thumb', src: App.assets.thumb(a), alt: a.name });
      img.addEventListener('click', function () {
        App.doc.source = a.id;
        App.needsRender = true;
        renderTextures(host);
        setDirty();
      });
      card.appendChild(img);
      const bodyEl = SL.h('div', { class: 'asset-body' });
      bodyEl.appendChild(SL.h('div', { class: 'asset-name', text: a.name, title: a.name }));
      bodyEl.appendChild(SL.h('div', {
        class: 'asset-meta',
        text: a.width + '×' + a.height + ' · ' + (a.kind === 'builtin' ? '内置' : '导入')
      }));
      card.appendChild(bodyEl);

      const acts = SL.h('div', { class: 'asset-acts' });
      const useBtn = SL.h('button', { class: 'btn tiny' + (isSrc ? ' primary' : ''), text: isSrc ? '使用中' : '用作输入' });
      useBtn.addEventListener('click', function () {
        App.doc.source = a.id;
        App.needsRender = true;
        renderTextures(host);
        setDirty();
      });
      acts.appendChild(useBtn);
      const moreBtn = SL.h('button', { class: 'btn tiny', text: '参数' });
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAssetMenu(a, moreBtn, function () { renderTextures(host); });
      });
      acts.appendChild(moreBtn);
      card.appendChild(acts);
      grid.appendChild(card);
    });
    sec2.appendChild(grid);
    host.appendChild(sec2);

    host.appendChild(SL.h('div', {
      class: 'insp-note',
      html: '把图片直接拖进窗口就能导入。<br>每个 Pass 的采样器在「Uniforms」页里单独选择绑定哪张。'
    }));
  }

  function openAssetMenu(entry, anchor, refresh) {
    const wrap = SL.h('div', { style: 'min-width:180px' });
    wrap.appendChild(SL.h('div', { class: 'ctxmenu-label', text: entry.name }));
    const filters = [['linear', '线性过滤（平滑）'], ['nearest', '最近邻（像素风）']];
    filters.forEach(function (f) {
      const it = SL.h('div', { class: 'ctxmenu-item', text: f[1] + (entry.params.filter === f[0] ? ' ✓' : '') });
      it.addEventListener('click', function () {
        entry.params.filter = f[0];
        App.assets.refreshParams(entry);
        pop.close();
        App.needsRender = true;
        refresh();
        setDirty();
      });
      wrap.appendChild(it);
    });
    wrap.appendChild(SL.h('div', { class: 'ctxmenu-sep' }));
    [['clamp', '边缘钳制（clamp）'], ['repeat', '平铺（repeat）']].forEach(function (f) {
      const it = SL.h('div', { class: 'ctxmenu-item', text: f[1] + (entry.params.wrap === f[0] ? ' ✓' : '') });
      it.addEventListener('click', function () {
        entry.params.wrap = f[0];
        App.assets.refreshParams(entry);
        pop.close();
        App.needsRender = true;
        refresh();
        setDirty();
      });
      wrap.appendChild(it);
    });
    if (entry.kind !== 'builtin') {
      wrap.appendChild(SL.h('div', { class: 'ctxmenu-sep' }));
      const del = SL.h('div', { class: 'ctxmenu-item', style: 'color:#ff9caa', text: '删除这张贴图' });
      del.addEventListener('click', function () {
        pop.close();
        App.assets.remove(entry.id);
        App.doc.assets = (App.doc.assets || []).filter(function (a) { return a.id !== entry.id; });
        if (App.doc.source === entry.id) App.doc.source = SL.assetDefaults.testcard;
        App.needsRender = true;
        refresh();
        setDirty();
      });
      wrap.appendChild(del);
    }
    const pop = SL.ui.popover(anchor, wrap, { align: 'right' });
  }

  function pickImages() {
    const inp = SL.h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      const files = Array.prototype.slice.call(inp.files || []);
      importFiles(files);
      inp.remove();
    });
    inp.click();
  }

  function importFiles(files) {
    if (!files || !files.length) return;
    const imgs = files.filter(function (f) { return /^image\//.test(f.type); });
    if (!imgs.length) {
      SL.ui.toast('只能导入图片文件', 'warn');
      return;
    }
    let chain = Promise.resolve();
    imgs.forEach(function (f) {
      chain = chain.then(function () {
        return App.assets.importFile(f).then(function (entry) {
          // 记进文档，便于自动保存与导出
          App.doc.assets = App.doc.assets || [];
          App.doc.assets.push({
            id: entry.id, name: entry.name, kind: 'file',
            dataURL: entry.dataURL, width: entry.width, height: entry.height,
            params: entry.params
          });
          if (!App.assets.byId(App.doc.source)) App.doc.source = entry.id;
        });
      });
    });
    chain.then(function () {
      App.needsRender = true;
      if (App.doc.ui.tab === 'textures') renderInspector();
      renderInspector();
      setDirty();
      SL.ui.toast('已导入 ' + imgs.length + ' 张贴图', 'ok');
    }).catch(function (err) {
      SL.ui.toast('导入失败：' + (err && err.message ? err.message : err), 'bad');
    });
  }

  /* ------------------------------- 信息页 ------------------------------- */
  function renderInfo(host, pass) {
    host.innerHTML = '';
    const out = outputSize();
    const sz = passSize(pass, out);
    const res = App.compiled[pass.id];
    const uni = App.parsed[pass.id] || [];

    function kv(rows) {
      const g = SL.h('div', { style: 'display:grid;grid-template-columns:92px minmax(0,1fr);gap:5px 10px;padding:6px 12px 12px;font-size:11.5px' });
      rows.forEach(function (r) {
        g.appendChild(SL.h('div', { style: 'color:var(--text-4)', text: r[0] }));
        const v = SL.h('div', { style: 'color:var(--text-2);overflow-wrap:anywhere;min-width:0' });
        if (r[1] instanceof Node) v.appendChild(r[1]);
        else v.textContent = r[1];
        g.appendChild(v);
      });
      return g;
    }

    const s1 = SL.h('div', { class: 'insp-section' });
    s1.appendChild(SL.h('div', { class: 'insp-head' }, SL.h('span', { text: '当前 Pass' })));
    s1.appendChild(kv([
      ['名称', pass.name],
      ['尺寸', sz.w + ' × ' + sz.h + (pass.scale !== 1 ? '（' + pass.scale + '× 输出）' : '')],
      ['缓冲格式', pass.format === 'hdr' ? 'RGBA16F（HDR）' : 'RGBA8'],
      ['过滤 / 包裹', (pass.filter === 'nearest' ? 'nearest' : 'linear') + ' / ' + pass.wrap],
      ['uniform', uni.length + ' 个（着色器里存活 ' + (res && res.uniforms ? res.uniforms.length : 0) + ' 个）'],
      ['代码行数', (pass.code || '').split('\n').length],
      ['编译', res ? (res.ok ? '通过' : '失败') : '未编译']
    ]));
    host.appendChild(s1);

    const s2 = SL.h('div', { class: 'insp-section' });
    s2.appendChild(SL.h('div', { class: 'insp-head' }, SL.h('span', { text: '管线' })));
    const chain = SL.h('div', { style: 'display:flex;flex-direction:column;gap:3px;padding:4px 12px 12px;font-family:var(--mono);font-size:10.5px;color:var(--text-3)' });
    let bytes = 0;
    App.doc.passes.forEach(function (p, i) {
      const s = passSize(p, out);
      const bpp = p.format === 'hdr' ? 8 : 4;
      const self = p.bindings && Object.keys(p.bindings).some(function (k) { return p.bindings[k].kind === 'self'; });
      const b = s.w * s.h * bpp * (self ? 2 : 1);
      bytes += b;
      chain.appendChild(SL.h('div', {
        style: 'display:flex;justify-content:space-between;gap:8px' + (p.enabled === false ? ';opacity:.45' : ''),
        html: '<span>' + (i === 0 ? '输入 → ' : '') + SL.esc(p.name) + '</span><span>' + s.w + '×' + s.h + '</span>'
      }));
    });
    chain.appendChild(SL.h('div', {
      style: 'display:flex;justify-content:space-between;gap:8px;color:var(--text-4);border-top:1px solid var(--line-soft);padding-top:4px;margin-top:2px',
      html: '<span>显存估算</span><span>' + (bytes / 1048576).toFixed(1) + ' MB</span>'
    }));
    s2.appendChild(chain);
    host.appendChild(s2);

    const caps = App.engine.caps || {};
    const s3 = SL.h('div', { class: 'insp-section' });
    s3.appendChild(SL.h('div', { class: 'insp-head' }, SL.h('span', { text: 'WebGL 设备' })));
    s3.appendChild(kv([
      ['渲染器', caps.renderer || '—'],
      ['厂商', caps.vendor || '—'],
      ['版本', caps.version || '—'],
      ['GLSL', caps.shading || '—'],
      ['最大纹理', caps.maxTexture ? caps.maxTexture + ' px' : '—'],
      ['纹理单元', caps.maxUnits ? String(caps.maxUnits) : '—'],
      ['浮点缓冲', caps.hdr ? '支持 RGBA16F' : '不支持（HDR 会退回 8bit）'],
      ['线性浮点', caps.floatLinear ? '支持' : '不支持']
    ]));
    host.appendChild(s3);

    host.appendChild(SL.h('div', {
      class: 'insp-note',
      html: '自动 uniform：<code>u_time u_delta u_frame u_resolution u_texel u_aspect u_mouse u_date</code><br>' +
        'Shadertoy 写法也可用：<code>iTime iResolution iFrame iMouse iChannel0…</code>'
    }));
  }

  /* ========================================================================
     十、顶栏动作
     ====================================================================== */
  function bindTopbar() {
    $('#preset-select').addEventListener('change', function (e) {
      const v = e.target.value;
      if (v.indexOf('effect:') === 0) loadEffect(v.slice(7));
      else loadPreset(v);
    });
    $('#btn-play').addEventListener('click', togglePlay);
    $('#btn-step').addEventListener('click', stepFrame);
    $('#btn-reset-time').addEventListener('click', resetTime);

    $('#btn-library').addEventListener('click', openLibrary);
    $('#lib-close').addEventListener('click', closeLibrary);
    $('#lib-search').addEventListener('input', function (e) {
      libQuery = e.target.value || '';
      renderLibrary();
    });
    $('#btn-bg').addEventListener('click', cyclePreviewBg);

    const scrub = $('#scrub');
    if (scrub) {
      scrub.addEventListener('input', function (e) {
        const dur = durationOf();
        if (!(dur > 0)) return;
        App.playing = false;
        App.doc.ui.playing = false;
        syncPlayButton();
        App.time = (Number(e.target.value) / 1000) * dur;
        App.needsRender = true;
        syncScrub();
      });
      scrub.addEventListener('change', function () { App.save && App.save(); });
    }

    $('#btn-shot').addEventListener('click', function () {
      try {
        const url = App.engine.screenshot();
        const a = document.createElement('a');
        a.href = url;
        a.download = 'shaderlab-' + App.doc.presetId + '-' + stamp() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        SL.ui.toast('已保存 PNG（' + App.engine.canvas.width + '×' + App.engine.canvas.height + '）', 'ok');
      } catch (e) {
        SL.ui.toast('截图失败：' + (e && e.message ? e.message : e), 'bad');
      }
    });

    $('#btn-save').addEventListener('click', function () {
      SL.store.exportDoc(App.doc);
      SL.ui.toast('工程已导出为 JSON', 'ok');
    });

    $('#btn-open').addEventListener('click', function () { $('#file-open').click(); });
    $('#file-open').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      SL.store.importDoc(f).then(function (doc) {
        applyDoc(doc);
        SL.store.save(doc);
        SL.ui.toast('已载入工程', 'ok');
      }).catch(function (err) {
        SL.ui.toast('打开失败：' + (err && err.message ? err.message : err), 'bad');
      });
      e.target.value = '';
    });

    $('#btn-help').addEventListener('click', openHelp);
    $('#btn-cmdk').addEventListener('click', openCmdk);

    // 编辑器状态行的小工具
    $('#btn-goto').addEventListener('click', promptGoto);
    $('#btn-font-minus').addEventListener('click', function () { bumpFont(-0.5); });
    $('#btn-font-plus').addEventListener('click', function () { bumpFont(0.5); });
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + SL.pad2(d.getMonth() + 1) + SL.pad2(d.getDate()) + '-' +
      SL.pad2(d.getHours()) + SL.pad2(d.getMinutes()) + SL.pad2(d.getSeconds());
  }

  /* ========================================================================
     十一、分隔条
     ====================================================================== */
  function bindSplitters() {
    function dragV(el, which) {
      el.addEventListener('mousedown', function (e) {
        e.preventDefault();
        const startX = e.clientX;
        const left = $('#left'), right = $('#right');
        const startW = which === 'left' ? left.offsetWidth : right.offsetWidth;
        document.body.style.userSelect = 'none';
        el.classList.add('dragging');

        function move(ev) {
          const dx = ev.clientX - startX;
          if (which === 'left') {
            const w = SL.clamp(startW + dx, 180, 520);
            document.documentElement.style.setProperty('--left-w', w + 'px');
            App.doc.ui.leftW = Math.round(w);
          } else {
            const w = SL.clamp(startW - dx, 240, 620);
            document.documentElement.style.setProperty('--right-w', w + 'px');
            App.doc.ui.rightW = Math.round(w);
          }
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.userSelect = '';
          el.classList.remove('dragging');
          App.save && App.save();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
    dragV($('#split-left'), 'left');
    dragV($('#split-right'), 'right');

    const se = $('#split-editor');
    se.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const startY = e.clientY;
      const pane = $('#editor-pane');
      const startH = pane.offsetHeight;
      document.body.style.userSelect = 'none';
      se.classList.add('dragging');

      function move(ev) {
        const h = SL.clamp(startH - (ev.clientY - startY), 0, window.innerHeight - 220);
        pane.style.height = h + 'px';
        document.documentElement.style.setProperty('--editor-h', h + 'px');
        App.doc.ui.editorH = Math.round(h);
        if (App.editor) App.editor.measure();
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.userSelect = '';
        se.classList.remove('dragging');
        App.save && App.save();
        App.needsRender = true;
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    document.body.addEventListener('mousemove', function (e) {
      if (e.buttons) return;
      // 悬停到分隔线时改光标（CSS 已处理 cursor，这里只处理边缘判定）
    });
  }

  /* ========================================================================
     十二、键盘 / 拖拽 / 帮助
     ====================================================================== */
  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      const typing = SL.isTypingTarget(e.target);
      const mod = SL.hasMod(e);

      // 命令面板：任何地方都能开
      if (mod && (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openCmdk();
        return;
      }
      // 效果库
      if (mod && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (libraryOpen()) closeLibrary(); else openLibrary();
        return;
      }
      // 效果库里 Esc 先关浮层，别被专注模式抢走
      if (e.key === 'Escape' && libraryOpen()) {
        e.preventDefault();
        closeLibrary();
        return;
      }
      // 全局：编译 / 导出 / 字号 / 跳行
      if (mod && e.key === 'Enter') { e.preventDefault(); compileNow(); return; }
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        SL.store.exportDoc(App.doc);
        SL.ui.toast('工程已导出为 JSON', 'ok');
        return;
      }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); bumpFont(0.5); return; }
      if (mod && e.key === '-') { e.preventDefault(); bumpFont(-0.5); return; }
      if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); promptGoto(); return; }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        const p = selectedPass();
        if (p) duplicatePass(p);
        return;
      }
      if (mod && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        togglePass(selectedPass());
        return;
      }
      if (typing) return;

      // 预览对比：按住 \ 临时看原图（和 B 键切换等价）
      if (e.key === '\\') {
        if (!e.repeat) { e.preventDefault(); setCompare(!App.compare); }
        return;
      }

      switch (e.key) {
        case ' ':
          break;                                // 空格播放/暂停在 bindPreview 里
        case 'ArrowRight':
          e.preventDefault(); stepFrame(); break;
        case 'ArrowLeft':
          e.preventDefault(); stepFrame(-1); break;
        case 'r': case 'R':
          e.preventDefault(); resetTime(); break;
        case '?':
          e.preventDefault(); openHelp(); break;
        case 'f': case 'F':
          e.preventDefault(); fitView(); break;
        case '0':
          e.preventDefault();
          App.zoom = 1; App.panX = 0; App.panY = 0; applyTransform(); break;
        case 'b': case 'B':
          e.preventDefault(); setCompare(!App.compare); break;
        case 'z': case 'Z':
          e.preventDefault(); setZen(!App.zen); break;
        case 'Escape':
          if (App.zen) { setZen(false); e.preventDefault(); }
          break;
        case '[':
          e.preventDefault(); cyclePass(-1); break;
        case ']':
          e.preventDefault(); cyclePass(1); break;
        case 'n': case 'N':
          e.preventDefault(); addPass(); break;
        case 'Delete':
          e.preventDefault(); deletePass(selectedPass()); break;
        case '1': e.preventDefault(); setTab('uniforms'); break;
        case '2': e.preventDefault(); setTab('textures'); break;
        case '3': e.preventDefault(); setTab('info'); break;
        case 'ArrowUp':
          if (mod) { e.preventDefault(); moveSelected(-1); }
          break;
        case 'ArrowDown':
          if (mod) { e.preventDefault(); moveSelected(1); }
          break;
        default:
          break;
      }
    });

    document.addEventListener('sl:save', function () {
      if (App.doc) SL.store.save(App.doc);
    });

    window.addEventListener('pagehide', function () {
      if (App.doc) SL.store.save(App.doc);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && App.doc) SL.store.save(App.doc);
    });
  }

  /* -------- 键盘辅助：字号 / 跳行 / 切 Pass / 移动 Pass -------- */
  function bumpFont(delta) {
    if (!App.editor) return;
    const size = App.editor.setFontSize(App.editor.fontPx + delta);
    App.doc.ui.editorFont = size;
    const el = $('#font-size');
    if (el) el.textContent = String(size);
    setDirty();
  }

  function promptGoto() {
    const total = App.editor ? App.editor.getValue().split('\n').length : 1;
    SL.ui.prompt({
      title: '跳到行',
      label: '行号（1 – ' + total + '）',
      value: '',
      placeholder: String(App.editor ? cursorLine() : 1),
      okLabel: '定位',
      validate: function (v) {
        const n = parseInt(v, 10);
        return isFinite(n) && n >= 1 && n <= total ? '' : '请输入 1 到 ' + total + ' 之间的行号';
      }
    }).then(function (v) {
      if (v == null) return;
      App.editor.gotoLine(parseInt(v, 10));
    });
  }

  function cursorLine() {
    if (!App.editor) return 1;
    const ta = App.editor.ta;
    return ta.value.slice(0, ta.selectionStart).split('\n').length;
  }

  function cyclePass(dir) {
    const list = App.doc.passes;
    if (!list.length) return;
    let i = list.findIndex(function (p) { return p.id === App.doc.selectedPassId; });
    if (i < 0) i = 0;
    const next = list[(i + dir + list.length) % list.length];
    if (next) selectPass(next.id);
  }

  function moveSelected(dir) {
    const arr = App.doc.passes;
    const i = arr.findIndex(function (p) { return p.id === App.doc.selectedPassId; });
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const item = arr.splice(i, 1)[0];
    arr.splice(j, 0, item);
    App.needsRender = true;
    compileAll();
    renderPipeline();
    renderInspector();
    setDirty();
  }

  function bindDrop() {
    function hasFiles(e) {
      if (!e.dataTransfer) return false;
      const t = e.dataTransfer.types;
      if (!t) return false;
      for (let i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      importFiles(Array.prototype.slice.call(e.dataTransfer.files || []));
    });
    window.addEventListener('paste', function (e) {
      if (SL.isTypingTarget(e.target)) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && /^image\//.test(items[i].type)) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) importFiles(files);
    });
  }

  /* ========================================================================
     命令面板（Ctrl+K）
     ====================================================================== */
  let cmdkEl = null;
  let cmdkInput = null;
  let cmdkListEl = null;
  let cmdkRows = [];
  let cmdkSel = 0;
  let cmdkAll = [];

  function cmdkEntries() {
    const out = [];
    const add = function (group, label, hint, icon, run, desc) {
      out.push({ group: group, label: label, hint: hint || '', icon: icon || 'bolt', run: run, desc: desc || '' });
    };

    add('操作', '打开效果库', 'Ctrl+L', 'grid', openLibrary);
    add('操作', '切换预览背景', '', 'image', cyclePreviewBg);
    add('操作', '播放 / 暂停', 'Space', 'play', togglePlay);
    add('操作', '单步前进', '→', 'step', function () { stepFrame(1); });
    add('操作', '单步后退', '←', 'step', function () { stepFrame(-1); });
    add('操作', '时间归零', 'R', 'reset', resetTime);
    add('操作', '适应窗口', 'F', 'fit', fitView);
    add('操作', '按 100% 显示', '0', 'square', function () {
      App.zoom = 1; App.panX = 0; App.panY = 0; applyTransform();
    });
    add('操作', App.compare ? '关闭原图对比' : '对比原图', 'B', 'split', function () { setCompare(!App.compare); });
    add('操作', App.zen ? '退出专注模式' : '进入专注模式', 'Z', 'zen', function () { setZen(!App.zen); });
    add('操作', '新增 Pass', 'N', 'plus', addPass);
    add('操作', '重新编译当前 Pass', 'Ctrl+↵', 'bolt', compileNow);
    add('操作', '重命名当前 Pass…', '', 'code', function () {
      const p = selectedPass();
      if (!p) return;
      SL.ui.prompt({ title: '重命名 Pass', label: '名称', value: p.name, okLabel: '保存' }).then(function (v) {
        if (v == null || !String(v).trim()) return;
        p.name = String(v).trim();
        if (App.doc.selectedPassId === p.id) $('#editor-title').textContent = p.name;
        renderPipeline();
        setDirty();
      });
    });
    add('操作', '启用 / 停用当前 Pass', 'Ctrl+E', 'eye', function () { togglePass(selectedPass()); });
    add('操作', '复制当前 Pass', 'Ctrl+D', 'copy', function () { duplicatePass(selectedPass()); });
    add('操作', '导出当前 Pass 为 PNG', '', 'download', function () { exportPassImage(selectedPass()); });
    add('操作', '编辑器字号 +', 'Ctrl++', 'code', function () { bumpFont(0.5); });
    add('操作', '编辑器字号 −', 'Ctrl+-', 'code', function () { bumpFont(-0.5); });
    add('操作', '截屏保存 PNG', '', 'camera', function () { $('#btn-shot').click(); });
    add('操作', '导出工程 JSON', 'Ctrl+S', 'download', function () { $('#btn-save').click(); });
    add('操作', '打开工程…', '', 'upload', function () { $('#btn-open').click(); });
    add('操作', '导入图片…', '', 'image', function () { pickImages(); });
    add('操作', '快捷键与说明', '?', 'keyboard', openHelp);
    add('操作', '跳到行…', 'Ctrl+G', 'code', promptGoto);
    if (App.doc && App.doc.viewPassId) {
      add('操作', '清除中间 Pass 查看', '', 'eye', function () {
        App.doc.viewPassId = null; App.needsRender = true; renderPipeline(); syncResolutionLabel();
      });
    }

    (SL.presets.list || []).forEach(function (p) {
      add('预设', p.name, '', 'grid', function () {
        const sel = $('#preset-select');
        sel.value = p.id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, p.desc || '');
    });

    libraryEffects().forEach(function (e) {
      add('效果库', e.name, e.loop ? '循环' : ((e.duration || 0).toFixed(2) + 's'), 'bolt', function () {
        loadEffect(e.id);
      }, e.desc || '');
    });

    (App.doc ? App.doc.passes : []).forEach(function (p, i) {
      add('Pass', (i + 1) + ' · ' + (p.name || 'Pass'), p.enabled === false ? '已停用' : '', 'code', function () {
        selectPass(p.id);
      });
    });

    (App.assets ? App.assets.items : []).forEach(function (a) {
      add('输入图', a.name, a.width + '×' + a.height, 'image', function () {
        App.doc.source = a.id;
        App.needsRender = true;
        renderInspector();
        setDirty();
      });
    });

    return out;
  }

  function openCmdk() {
    if (cmdkEl) { closeCmdk(); return; }
    cmdkAll = cmdkEntries();
    cmdkSel = 0;

    const panel = SL.h('div', { class: 'cmdk-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },);
    const row = SL.h('div', { class: 'cmdk-input-row' });
    row.appendChild(SL.h('span', { class: 'ic', html: SL.icon('search', 14) }));
    cmdkInput = SL.h('input', {
      class: 'cmdk-input', type: 'text', placeholder: '搜索命令、预设、Pass、贴图…',
      'aria-label': '搜索命令', autocomplete: 'off', spellcheck: 'false'
    });
    row.appendChild(cmdkInput);
    row.appendChild(SL.h('span', { class: 'hint', text: 'Esc' }));
    panel.appendChild(row);

    cmdkListEl = SL.h('div', { class: 'cmdk-list', role: 'listbox' });
    panel.appendChild(cmdkListEl);

    const foot = SL.h('div', { class: 'cmdk-foot' });
    foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span>';
    panel.appendChild(foot);

    const backdrop = SL.h('div', { class: 'cmdk-backdrop' });
    cmdkEl = SL.h('div', { id: 'cmdk' }, backdrop, panel);
    document.body.appendChild(cmdkEl);

    backdrop.addEventListener('click', closeCmdk);
    cmdkInput.addEventListener('input', function () { renderCmdkList(cmdkInput.value); });
    cmdkInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdkSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdkSel(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runCmdkSel(); }
      else if (e.key === 'Tab') { e.preventDefault(); moveCmdkSel(e.shiftKey ? -1 : 1); }
    });

    renderCmdkList('');
    requestAnimationFrame(function () { cmdkInput.focus(); });
  }

  function closeCmdk() {
    if (!cmdkEl) return;
    cmdkEl.remove();
    cmdkEl = null;
    cmdkInput = null;
    cmdkListEl = null;
    cmdkRows = [];
    $('#btn-cmdk') && $('#btn-cmdk').focus({ preventScroll: true });
  }

  function renderCmdkList(query) {
    if (!cmdkListEl) return;
    const q = String(query || '').trim().toLowerCase();
    const hits = cmdkAll.filter(function (it) {
      if (!q) return true;
      return (it.label + ' ' + it.group + ' ' + it.desc).toLowerCase().indexOf(q) >= 0;
    });
    cmdkRows = hits;
    cmdkListEl.innerHTML = '';
    if (!hits.length) {
      cmdkListEl.appendChild(SL.h('div', { class: 'cmdk-empty', text: '没有匹配项' }));
      return;
    }
    if (cmdkSel >= hits.length) cmdkSel = 0;
    let group = '';
    hits.forEach(function (it, i) {
      if (it.group !== group) {
        group = it.group;
        cmdkListEl.appendChild(SL.h('div', { class: 'cmdk-group', text: group }));
      }
      const el = SL.h('div', {
        class: 'cmdk-item' + (i === cmdkSel ? ' active' : ''),
        role: 'option',
        'aria-selected': i === cmdkSel ? 'true' : 'false'
      });
      el.appendChild(SL.h('span', { class: 'ic', html: SL.icon(it.icon, 13) }));
      el.appendChild(SL.h('span', { class: 't', text: it.label }));
      if (it.desc) el.appendChild(SL.h('span', { class: 'd', text: it.desc }));
      if (it.hint) el.appendChild(SL.h('span', { class: 'hint', text: it.hint }));
      el.addEventListener('mouseenter', function () {
        cmdkSel = i;
        highlightCmdkSel();
      });
      el.addEventListener('click', function () { cmdkSel = i; runCmdkSel(); });
      cmdkListEl.appendChild(el);
    });
    highlightCmdkSel();
  }

  function highlightCmdkSel() {
    if (!cmdkListEl) return;
    const items = cmdkListEl.querySelectorAll('.cmdk-item');
    items.forEach(function (el, i) {
      el.classList.toggle('active', i === cmdkSel);
      el.setAttribute('aria-selected', i === cmdkSel ? 'true' : 'false');
      if (i === cmdkSel) {
        const top = el.offsetTop - cmdkListEl.clientHeight / 2 + el.offsetHeight / 2;
        if (Math.abs(top - cmdkListEl.scrollTop) > 4) cmdkListEl.scrollTop = Math.max(0, top);
      }
    });
  }

  function moveCmdkSel(dir) {
    if (!cmdkRows.length) return;
    cmdkSel = (cmdkSel + dir + cmdkRows.length) % cmdkRows.length;
    highlightCmdkSel();
  }

  function runCmdkSel() {
    const it = cmdkRows[cmdkSel];
    if (!it) return;
    closeCmdk();
    // 让命令在下一帧跑，避免焦点还卡在已移除的输入框上
    setTimeout(function () {
      try { it.run(); } catch (err) { SL.ui.toast('执行失败：' + (err && err.message || err), 'bad'); }
    }, 0);
  }

  function openHelp() {
    const body = SL.h('div', { class: 'help-body' });
    body.innerHTML = [
      '<h3>三步上手</h3>',
      '<ol>',
      '<li>左上「预设」挑一个示例，先看效果。</li>',
      '<li>下方编辑器改 shader，改完自动重新编译（也可 <kbd>Ctrl</kbd>+<kbd>↵</kbd> 立即编译）。</li>',
      '<li>右侧「Uniforms」调参数、「纹理」换输入图；左栏「新增 Pass」搭后处理链。</li>',
      '</ol>',
      '<h3>着色器里能直接用东西</h3>',
      '<table>',
      '<tr><th>名字</th><th>类型 / 含义</th></tr>',
      '<tr><td><code>vUv</code></td><td>归一化坐标，左下角 (0,0)</td></tr>',
      '<tr><td><code>fragColor</code></td><td>vec4 输出</td></tr>',
      '<tr><td><code>u_time</code> / <code>iTime</code></td><td>float 秒</td></tr>',
      '<tr><td><code>u_delta</code></td><td>float 上一帧耗时（秒）</td></tr>',
      '<tr><td><code>u_frame</code> / <code>iFrame</code></td><td>帧计数</td></tr>',
      '<tr><td><code>u_resolution</code> / <code>iResolution</code></td><td>当前 Pass 像素尺寸</td></tr>',
      '<tr><td><code>u_texel</code></td><td>1/尺寸，做邻域采样用</td></tr>',
      '<tr><td><code>u_aspect</code></td><td>宽高比</td></tr>',
      '<tr><td><code>u_mouse</code> / <code>iMouse</code></td><td>vec4：xy 当前坐标（像素、左下原点），zw 按下位置</td></tr>',
      '<tr><td><code>u_date</code></td><td>vec4：年、月、日、秒</td></tr>',
      '<tr><td><code>u_t01</code> / <code>u_duration</code> / <code>u_playing</code></td><td>一次性效果的时间轴：0→1 进度 / 时长 / 是否在播</td></tr>',
      '<tr><td><code>PI</code> <code>TAU</code></td><td>常量</td></tr>',
      '<tr><td><code>sl_luma()</code> <code>sl_rotate()</code> <code>sl_hash21()</code></td><td>常用函数</td></tr>',
      '<tr><td><code>sl_easeInOut()</code> <code>sl_easeOut()</code> <code>sl_easeIn()</code> <code>sl_pulse()</code></td><td>缓动与脉冲</td></tr>',
      '</table>',
      '<p class="tip">写 <code>#version 300 es</code>、声明 <code>in vec2 vUv</code>/<code>out vec4</code> 都可以省略，构建器会补；' +
      '旧写法 <code>varying</code>、<code>texture2D</code>、<code>gl_FragColor</code> 会被自动改写。</p>',
      '<h3>参数注解</h3>',
      '<p>给 uniform 加注释，就会在右侧变成滑块：</p>',
      '<pre class="codeblock">uniform float u_strength; // @range 0 1 @step 0.01 @default 0.5 @label 强度\nuniform vec3  u_tint;     // @color\nuniform float u_hidden;   // @hidden</pre>',
      '<h3>多 Pass 与纹理输入</h3>',
      '<p>每个 <code>sampler2D</code> 在「Uniforms」里单独选来源：</p>',
      '<ul>',
      '<li><b>上一 Pass</b>：链式后处理；首个 Pass 得到的是左侧「输入图」。</li>',
      '<li><b>自身上一帧</b>：反馈，引擎自动 ping-pong 两块缓冲（残影、流体）。</li>',
      '<li><b>纹理资源</b>：任意导入的图片，可做噪声/遮罩/LUT。</li>',
      '<li><b>指定 Pass / 源图</b>：跨 Pass 取结果（bloom 合成就是这么做的）。</li>',
      '</ul>',
      '<p>再声明一个 <code>uniform vec2 u_texSize;</code> 就能自动拿到所绑定纹理的尺寸。</p>',
      '<h3>效果库（effects/）</h3>',
      '<p>顶栏「效果库」或 <kbd>Ctrl</kbd>+<kbd>L</kbd> 打开。每个效果是一个目录：</p>',
      '<pre class="codeblock">effects/slash-arc/\n  effect.json      # 名称 / 标签 / 时长 / 是否循环 / 输出尺寸与 alpha\n  shaders/*.frag   # 每个 Pass 一个文件\n  input/*.png      # 可选：这个效果要用的贴图</pre>',
      '<p>加完效果跑一次 <code>node tools/lib.mjs build</code>（会校验并生成 <code>effects/index.js</code>），刷新页面即可在图库看到；' +
      '想从头写一个新效果用 <code>node tools/new.mjs 新效果id</code>。</p>',
      '<h3>一次性效果与透明输出</h3>',
      '<p>效果包里写 <code>"loop": false</code> + <code>"duration"</code> 时，预览下方会出现时间轴，拖到任意时刻定格；' +
      'shader 里用 <code>u_t01</code>（0→1）驱动扫光进度，别再用 u_time 取模。</p>',
      '<p><code>"output": { "alpha": true }</code> 表示输出带透明通道，预览会叠在背景上（棋盘格 / 深色 / 浅色 / 输入图，用预览右上角的「背景」按钮切）。</p>',
      '<h3>快捷键</h3>',
      '<table class="keys-grid">',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>命令面板：搜命令 / 预设 / 效果 / Pass / 贴图</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>打开 / 关闭效果库</td></tr>',
      '<tr><td><kbd>Space</kbd></td><td>播放 / 暂停</td></tr>',
      '<tr><td><kbd>→</kbd> <kbd>←</kbd></td><td>单帧前进 / 后退</td></tr>',
      '<tr><td><kbd>R</kbd></td><td>时间归零</td></tr>',
      '<tr><td><kbd>F</kbd> / <kbd>0</kbd> / 双击预览</td><td>适应窗口 / 100% / 适应窗口</td></tr>',
      '<tr><td><kbd>B</kbd> 或按住 <kbd>\\</kbd></td><td>对比原始输入图</td></tr>',
      '<tr><td><kbd>Z</kbd></td><td>专注模式（只留预览，<kbd>Esc</kbd> 退出）</td></tr>',
      '<tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>上一个 / 下一个 Pass</td></tr>',
      '<tr><td><kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>新增 Pass / 复制当前 Pass</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>E</kbd> / <kbd>Del</kbd></td><td>启用或停用 / 删除当前 Pass</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd></td><td>上移 / 下移当前 Pass</td></tr>',
      '<tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>切到 Uniforms / 纹理 / 信息</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>↵</kbd></td><td>立即编译</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>导出工程 JSON</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>G</kbd></td><td>跳到行</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>-</kbd></td><td>编辑器字号</td></tr>',
      '<tr><td><kbd>Shift</kbd>+拖动滑块</td><td>方向键微调（1/10 步长）</td></tr>',
      '<tr><td>双击参数名</td><td>复位这个参数</td></tr>',
      '<tr><td>滚轮 / 中键拖动</td><td>缩放 / 平移预览</td></tr>',
      '<tr><td><kbd>Shift</kbd>+点击预览</td><td>复制该点颜色</td></tr>',
      '</table>',
      '<h3>保存</h3>',
      '<p>所有改动会自动存进浏览器本地（IndexedDB）。换机器或备份用顶栏的导出/导入 JSON；建议定期导出一份。</p>'
    ].join('');
    SL.ui.modal({ title: 'ShaderLab 使用说明', icon: 'help', body: body, footer: null });
  }

  /* ========================================================================
     十三、自检钩子（供自动化验证用）
     ====================================================================== */
  function runSelfTest() {
    const report = [];
    SL.presets.ids.forEach(function (id) {
      const p = SL.presets.get(id);
      p.passes.forEach(function (pass) {
        const res = App.engine.compile(pass.code, { isFirst: p.passes.indexOf(pass) === 0 });
        report.push({
          preset: id, pass: pass.name, ok: res.ok,
          errors: (res.errors || []).map(function (e) { return e.line + ': ' + e.message; })
        });
      });
    });
    App.__selfTest = report;
  }

  SL.test = {
    autoRun: false,
    report: function () { return App.__selfTest || []; },
    checkAll: runSelfTest,
    loadPreset: function (id) {
      const doc = SL.store.defaultState(id);
      doc.assets = SL.deepClone((App.doc && App.doc.assets) || []);
      doc.ui = SL.deepClone((App.doc && App.doc.ui) || {});
      App.doc = SL.store.normalize(doc);
      App.time = 0; App.frame = 0;
      selectPass(App.doc.passes[0].id, true);
      compileAll();
      renderPipeline();
      renderInspector();
      syncStage();
      App.needsRender = true;
      $('#preset-select').value = id;
      return App.doc.passes.map(function (p) {
        const r = App.compiled[p.id];
        return { name: p.name, ok: r.ok, errors: (r.errors || []).map(function (e) { return e.line + ': ' + e.message; }) };
      });
    },
    state: function () { return App; },
    pixel: function (x, y) { return App.engine.readPixel(x, y); },
    // 效果库：给自动化 / AI 用的入口
    effects: function () { return libraryEffects(); },
    effectDoc: function (id) {
      const eff = libraryEffects().filter(function (e) { return e.id === id; })[0];
      if (!eff) return Promise.resolve(null);
      return buildDocFromEffect(eff).then(function (doc) { return SL.store.normalize(doc); });
    },
    loadEffect: loadEffect,
    thumb: function (id) {
      return SL.test.effectDoc(id).then(function (doc) {
        return doc ? renderEffectThumb(doc) : null;
      });
    }
  };

  window.SL.app = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.SL);
