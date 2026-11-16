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
    App.assets.ensureLibrary(function () {
      // 图库图片是异步解码的：解完要重画一次，缩略图与纹理才会有内容
      App.needsRender = true;
      if (App.doc && App.doc.ui.tab === 'textures') renderInspector();
    });

    initEditor();
    bindTopbar();
    bindPipelineButtons();
    bindPreview();
    bindInspector();
    bindSplitters();
    bindKeyboard();
    bindCtxMenuGuard();
    bindDrop();
    bindTimeline();

    App.save = SL.debounce(function () {
      if (!App.doc) return;
      try {
        Promise.resolve(SL.store.save(App.doc)).then(flashSaved, function () {});
      } catch (e) { /* store 内部已提示 */ }
    }, 700);

    // 先探本地服务：有的话 passes/ library/ effects/ project.json 都以磁盘为准
    SL.server.init().then(function () {
      syncStoreMode();
      return Promise.all([SL.passes.sync(), reloadEffectIndex()]);
    }).then(function () {
      // 服务模式下 library/ 的真实内容要等探测完才读得到，这里补一次
      return App.assets.ensureLibrary(function () {
        App.needsRender = true;
        if (App.doc && App.doc.ui.tab === 'textures') renderInspector();
      });
    }).then(function () {
      return SL.store.load();
    }).then(function (doc) {
      App.__fresh = !doc;
      applyDoc(doc || SL.store.defaultState());
      bootDone();
    }).catch(function (err) {
      SL.ui.toast('读取本地工程失败，已用默认管线：' + (err && err.message ? err.message : err), 'warn');
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
      'tl-play': App.playing ? 'pause' : 'play',
      'tl-step': 'step',
      'tl-step-prev': 'step',
      'tl-reset': 'reset',
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
      // 播放控制那排小按钮用 16，其余 15，整体比之前大一号
      el.innerHTML = SL.icon(map[id], id.indexOf('tl-') === 0 ? 17 : 16);
    });
    const add2 = $('#btn-add-pass-2');
    if (add2) add2.innerHTML = '<span class="plus">+</span><span>插入 Pass</span>';
    const cmdk = $('#cmdk-btn-ic');
    if (cmdk) cmdk.innerHTML = SL.icon('search', 11);
    const saved = $('#save-state .ic');
    if (saved) saved.innerHTML = SL.icon('check', 11);
    const cmp = $('#compare-ic');
    if (cmp) cmp.innerHTML = SL.icon('split', 12);
    const libIc = $('#lib-btn-ic');
    if (libIc) libIc.innerHTML = SL.icon('grid', 13);
    const savePassIc = $('#save-pass-ic');
    if (savePassIc) savePassIc.innerHTML = SL.icon('save', 12);
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
    const effects = libraryEffects();
    const cnt = $('#lib-btn-count');
    if (cnt) cnt.textContent = effects.length ? String(effects.length) : '';
  }

  /** 顶栏的效果名（只读）：指到哪个效果 / 未落盘 / 当前管线 */
  function syncDocName() {
    const el = $('#doc-name');
    if (!el || !App.doc) return;
    const doc = App.doc;
    const eff = doc.effectId
      ? libraryEffects().filter(function (e) { return e.id === doc.effectId; })[0] : null;
    let name = '';
    if (eff) name = eff.name;
    else if (doc.effectName) name = doc.effectName;
    else if (doc.effectId) name = '（未落盘）' + doc.effectId;
    el.textContent = name;
    el.classList.toggle('hidden', !name);
    const title = eff
      ? (eff.name + (eff.desc ? ' · ' + eff.desc : '') + (doc.effectId ? '\n' + doc.effectId : ''))
      : (name || '当前管线');
    el.title = title + (doc.custom ? '\n（已修改）' : '');
  }

  /** 保存位置提示：磁盘（本地服务）还是浏览器本地 */
  function syncStoreMode() {
    const el = $('#store-mode');
    const st = $('#save-state');
    const disk = !!(SL.server && SL.server.on);
    if (el) {
      el.textContent = disk ? '磁盘' : '浏览器';
      el.classList.toggle('disk', disk);
      el.title = disk
        ? '保存到项目目录：passes/*.mjs 与 project.json（node server/index.mjs）'
        : '没有启动本地服务，改动只存在浏览器里；想落盘就跑 node server/index.mjs';
    }
    if (st) {
      st.title = disk
        ? '改动会自动存进 project.json（本地服务）'
        : '改动只存进浏览器本地（启动本地服务后可落盘）';
    }
  }

  /** 效果库索引（effects/index.js 由 node tools/lib.mjs build 生成） */
  function libraryEffects() {    return (window.SL_EFFECTS && Array.isArray(window.SL_EFFECTS.effects))
      ? window.SL_EFFECTS.effects : [];
  }

  /** 服务模式：把 /api/effects 的结果转成和 effects/index.js 一样的结构（shader 文本内联进 passes） */
  function effectsFromServer(list) {
    return (list || []).map(function (rec) {
      const eff = rec.effect || {};
      const shaders = rec.shaders || {};
      const passes = (eff.passes || []).map(function (p) {
        return Object.assign({}, p, { code: shaders[p.shader] || '' });
      });
      const assets = [];
      Object.keys(eff.inputs || {}).forEach(function (slot) {
        const v = String(eff.inputs[slot] || '');
        if (v.indexOf('builtin:') === 0) assets.push({ slot: slot, kind: 'builtin', builtin: v.slice(8) });
        else if (v.indexOf('library:') === 0) assets.push({ slot: slot, kind: 'library', libId: v.slice(8) });
        else if (v.indexOf('data:') === 0) assets.push({ slot: slot, kind: 'file', name: slot, dataURL: v });
        else assets.push({ slot: slot, kind: 'url', name: slot, url: 'effects/' + rec.id + '/' + v });
      });
      return Object.assign({}, eff, { id: rec.id, passes: passes, assets: assets });
    });
  }

  /** 服务模式：重新扫一遍 effects/（新建效果写盘后调用，不用再跑 build） */
  function reloadEffectIndex() {
    if (!(window.SL.server && SL.server.on)) return Promise.resolve(false);
    return SL.server.listEffects().then(function (list) {
      window.SL_EFFECTS = { builtAt: Date.now(), effects: effectsFromServer(list) };
      return true;
    });
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
    if (window.SL.server && SL.server.on) return;   // 服务模式每次从磁盘现读，不存在「过期」
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
    syncDocName();
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

  /** 管线真正出图的那一步：最后一个启用、且不是中间态的 Pass */
  function outputPass() {
    if (!App.doc) return null;
    let last = null;
    App.doc.passes.forEach(function (p) {
      if (p.enabled === false || p.role === 'source') return;
      last = p;
    });
    return last;
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
      if (dur > 0) {
        if (App.doc.loop) {
          // 有长度且勾了循环：时间在 [0, duration] 里绕圈，关键帧与 u_t01 一起回到起点
          if (App.time >= dur) App.time = App.time % dur;
        } else if (App.time >= dur) {
          // 一次性效果：走到末尾就停住，停在最后一帧而不是继续累加时间
          App.time = dur;
          App.playing = false;
          App.doc.ui.playing = false;
          syncPlayButton();
        }
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

  /* ========================================================================
     四之一、时间轴与关键帧
     - 没有 duration 的 shader：时间是无限递增的，时间轴是一扇跟着走的窗口
     - 有 duration 的 shader：默认循环，游标在 [0, duration] 内绕圈
     - 关键帧存在 doc.timeline[passId][uniformName] = [{t, v, e}]
     ====================================================================== */
  const EASES = ['linear', 'in', 'out', 'inout', 'step'];
  const EASE_LABEL = { linear: '线性', in: '缓入', out: '缓出', inout: '缓入缓出', step: '阶跃' };
  const TL_MIN_SPAN = 4;          // 时间轴最短显示 4 秒
  const TL_PAD = 96;              // 左侧留给轨道名（Pass · 参数名）的宽度
  const TL_TAIL = 20;             // 右侧留白，免得末尾的关键帧/游标贴边被裁
  let tlView = { start: 0, span: TL_MIN_SPAN };
  let tlSel = null;               // { passId, name, idx }
  let tlDrag = false;             // 正在拖动时间轴游标

  function easeFn(e, k) {
    if (e === 'in') return k * k;
    if (e === 'out') return 1 - (1 - k) * (1 - k);
    if (e === 'inout') return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (e === 'step') return 0;
    return k;
  }

  /** 在一组关键帧上取值（首尾之外各取端值） */
  function sampleTrack(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].t) return keys[0].v.slice();
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v.slice();
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    const k = span > 1e-6 ? (t - a.t) / span : 0;
    const f = easeFn(a.e || 'linear', SL.clamp(k, 0, 1));
    return a.v.map(function (x, j) {
      const y = b.v[j] == null ? x : b.v[j];
      return x + (y - x) * f;
    });
  }

  function tracksOf(passId) {
    const tl = (App.doc && App.doc.timeline) || {};
    return tl[passId] || {};
  }

  function trackOf(passId, name) {
    return tracksOf(passId)[name] || null;
  }

  /** 时间轴上所有关键帧里最大的 t */
  function lastKeyTime() {
    let max = 0;
    const tl = (App.doc && App.doc.timeline) || {};
    Object.keys(tl).forEach(function (pid) {
      const lanes = tl[pid] || {};
      Object.keys(lanes).forEach(function (n) {
        lanes[n].forEach(function (k) { if (k.t > max) max = k.t; });
      });
    });
    return max;
  }

  /** 在一组关键帧里找「当前时刻」那一帧（用于高亮 / 覆盖写） */
  function keyIndexAt(keys, t, eps) {
    if (!keys) return -1;
    const e = eps == null ? 0.02 : eps;
    for (let i = 0; i < keys.length; i++) if (Math.abs(keys[i].t - t) <= e) return i;
    return -1;
  }

  function ensureTimelineBucket(passId) {
    if (!App.doc.timeline) App.doc.timeline = {};
    if (!App.doc.timeline[passId]) App.doc.timeline[passId] = {};
    return App.doc.timeline[passId];
  }

  /** 打一帧：同一时刻已有就覆盖，没有就插入并保持按时间排序 */
  function setKeyframe(passId, name, t, values, ease) {
    const bucket = ensureTimelineBucket(passId);
    const keys = bucket[name] || (bucket[name] = []);
    const at = keyIndexAt(keys, t);
    const v = (values || []).map(Number);
    if (at >= 0) {
      keys[at].v = v;
      if (ease) keys[at].e = ease;
    } else {
      keys.push({ t: Math.max(0, t), v: v, e: ease || 'linear' });
      keys.sort(function (a, b) { return a.t - b.t; });
    }
    return keys;
  }

  function keyframeAt(passId, name, t) {
    const keys = trackOf(passId, name);
    const i = keyIndexAt(keys, t);
    return i >= 0 ? keys[i] : null;
  }

  function dropTrack(passId, name) {
    const bucket = ensureTimelineBucket(passId);
    delete bucket[name];
    if (!Object.keys(bucket).length) delete App.doc.timeline[passId];
    tlSel = null;
  }

  /** 把关键帧的值写回 pass.values（每帧渲染前调用；不写回去 shader 就看不到动画） */
  function applyTracks(t) {
    if (!App.doc || !App.doc.timeline) return;
    const tl = App.doc.timeline;
    App.doc.passes.forEach(function (pass) {
      const lanes = tl[pass.id];
      if (!lanes) return;
      Object.keys(lanes).forEach(function (name) {
        const vals = sampleTrack(lanes[name], t);
        if (vals) pass.values[name] = vals;
      });
    });
  }

  /** 给当前 Pass 的某个参数打帧（uniforms 面板上的 ◇ 按钮走这里） */
  function toggleKeyframe(passId, name, values) {
    const t = Math.round(App.time * 1000) / 1000;
    const keys = trackOf(passId, name);
    const at = keyIndexAt(keys, t);
    if (at >= 0) {
      keys.splice(at, 1);
      if (!keys.length) dropTrack(passId, name);
      SL.ui.toast('已删除 ' + name + ' 在 ' + t.toFixed(2) + 's 的关键帧', 'info');
    } else {
      setKeyframe(passId, name, t, values);
      SL.ui.toast('已给 ' + name + ' 打帧 @ ' + t.toFixed(2) + 's', 'ok');
    }
    App.playing = false;
    App.needsRender = true;
    syncTimeline();
    renderInspector();
    setDirty();
  }

  /* ---------------------------- 视图窗口 ---------------------------- */
  function computeTlView() {
    const dur = durationOf();
    if (dur > 0) { tlView = { start: 0, span: dur }; return; }
    const span = Math.max(TL_MIN_SPAN, lastKeyTime() * 1.15);
    tlView = { start: 0, span: span };
  }

  /** 时间轴「适应」：有 duration 用它，否则装下所有关键帧 */
  function fitTimeline() {
    const dur = durationOf();
    const span = dur > 0 ? dur : Math.max(TL_MIN_SPAN, lastKeyTime() * 1.15);
    tlView = { start: 0, span: span };
    syncTimeline();
  }

  function tlTimeToX(t) {
    const body = $('#tl-body');
    const w = Math.max(1, (body ? body.clientWidth : 600) - TL_PAD - TL_TAIL);
    return TL_PAD + ((t - tlView.start) / tlView.span) * w;
  }

  function tlXToTime(x) {
    const body = $('#tl-body');
    const w = Math.max(1, (body ? body.clientWidth : 600) - TL_PAD - TL_TAIL);
    return tlView.start + (Math.max(0, x - TL_PAD) / w) * tlView.span;
  }

  /* ---------------------------- 渲染 ---------------------------- */
  function syncTimeline() {
    if (!App.doc) return;
    const dur = durationOf();
    const box = $('#timeline');
    const body = $('#tl-body');
    if (!box || !body) return;

    const mode = $('#tl-mode');
    if (mode) {
      mode.textContent = dur > 0
        ? (App.doc.loop ? '循环 ' + dur.toFixed(2) + 's' : '一次性 ' + dur.toFixed(2) + 's')
        : '无限时间';
    }
    const loopBtn = $('#tl-loop');
    if (loopBtn) {
      loopBtn.hidden = !(dur > 0);
      loopBtn.setAttribute('aria-pressed', App.doc.loop ? 'true' : 'false');
      loopBtn.textContent = App.doc.loop ? '循环' : '单次';
    }

    computeTlView();
    // 时长输入框：没有焦点时才回写，免得打字被重置
    const durIn = $('#tl-dur');
    if (durIn && document.activeElement !== durIn) durIn.value = dur > 0 ? String(dur) : '0';
    body.style.setProperty('--tl-grid', (tlTimeToX(tlView.start + 1) - tlTimeToX(tlView.start)) + 'px');

    // 刻度
    const ruler = $('#tl-ruler');
    if (ruler) {
      ruler.innerHTML = '';
      const step = niceStep(tlView.span);
      const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
      let lastLabelX = -999;
      for (let t = 0; t <= tlView.span + 1e-6; t += step) {
        const x = tlTimeToX(t);
        ruler.appendChild(SL.h('div', { class: 'tl-tick', style: 'left:' + x + 'px' }));
        if (x - lastLabelX < 34) continue;   // 太挤就跳过这个标签，免得叠字
        lastLabelX = x;
        ruler.appendChild(SL.h('div', {
          class: 'tl-tick-label',
          style: 'left:' + x + 'px',
          text: t.toFixed(dec) + 's'
        }));
      }
    }

    // 轨道
    const lanes = $('#tl-lanes');
    if (lanes) {
      lanes.innerHTML = '';
      const rows = [];
      App.doc.passes.forEach(function (pass) {
        const t = tracksOf(pass.id);
        Object.keys(t).forEach(function (name) { rows.push({ pass: pass, name: name, keys: t[name] }); });
      });
      const empty = $('#tl-empty');
      if (empty) empty.classList.toggle('hidden', rows.length > 0);
      body.classList.toggle('no-lanes', rows.length === 0);
      body.style.height = rows.length ? (16 + rows.length * 17 + 6) + 'px' : '';
      const showPass = App.doc.passes.length > 1;
      rows.forEach(function (row) {
        const lane = SL.h('div', { class: 'tl-lane', 'data-pass': row.pass.id, 'data-name': row.name });
        lane.appendChild(SL.h('span', {
          class: 'tl-lane-name',
          text: (showPass ? row.pass.name + ' · ' : '') + row.name
        }));
        row.keys.forEach(function (k, idx) {
          const el = SL.h('div', {
            class: 'tl-key' + (k.e === 'step' ? ' e-step' : '') +
              (tlSel && tlSel.passId === row.pass.id && tlSel.name === row.name && tlSel.idx === idx ? ' on' : ''),
            style: 'left:' + tlTimeToX(k.t) + 'px',
            title: row.name + ' @ ' + k.t.toFixed(2) + 's = ' + k.v.map(function (v) { return SL.fmt(v, 3); }).join(', ')
          });
          el.addEventListener('pointerdown', function (ev) {
            ev.stopPropagation();
            openKeyMenu(ev, row.pass.id, row.name, idx);
          });
          lane.appendChild(el);
        });
        lanes.appendChild(lane);
      });
    }
    updatePlayhead();
    // 时间轴占了底部空间，把预览的悬浮工具条顶上去
    const pane = $('#preview-pane');
    if (pane) pane.style.setProperty('--tl-h', box.offsetHeight + 'px');
  }

  function niceStep(span) {
    const target = span / 6;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-3, target))));
    const n = target / pow;
    const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return mult * pow;
  }

  /* 时间文案：轨道/提示里统一用一位小数，够看又不啰嗦 */
  function fmtSec(t) {
    if (t >= 10) return t.toFixed(0) + 's';
    if (t >= 1) return t.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 's';
    return t.toFixed(2) + 's';
  }

  function updatePlayhead() {
    const head = $('#tl-playhead');
    if (!head) return;
    const x = tlTimeToX(App.time);
    const inside = x >= -1 && x <= ($('#tl-body') ? $('#tl-body').clientWidth + 1 : 1e9);
    head.style.display = inside ? '' : 'none';
    head.style.left = Math.round(x) + 'px';
    const tm = $('#tl-time');
    if (tm) {
      const dur = durationOf();
      tm.textContent = App.time.toFixed(2) + 's' + (dur > 0 ? ' / ' + dur.toFixed(2) + 's' : '');
    }
  }

  /** 拖动 / 点击时间轴 → 设时间（自动暂停，方便定帧调参） */
  function scrubTo(t) {
    const dur = durationOf();
    let nt = Math.max(0, t);
    if (dur > 0) {
      if (App.doc.loop) nt = ((nt % dur) + dur) % dur;
      else nt = Math.min(nt, dur);
    }
    App.time = nt;
    if (App.playing) {
      App.playing = false;
      App.doc.ui.playing = false;
      syncPlayButton();
    }
    App.needsRender = true;
    applyTracks(App.time);
    updatePlayhead();
  }

  function openKeyMenu(ev, passId, name, idx) {
    tlSel = { passId: passId, name: name, idx: idx };
    const keys = trackOf(passId, name);
    const key = keys && keys[idx];
    if (!key) return;
    const body = SL.h('div', { style: 'min-width:220px' });
    body.appendChild(SL.h('div', { class: 'ctxmenu-label', text: name + ' @ ' + key.t.toFixed(3) + 's' }));

    const rowEase = SL.h('div', { class: 'ctxmenu-item row', style: 'cursor:default;white-space:nowrap' });
    rowEase.appendChild(SL.h('span', { class: 'lbl', text: '到下一帧的缓动' }));
    const sel = SL.h('select', { class: 'sel', style: 'height:22px;flex:0 0 auto' });
    EASES.forEach(function (e) {
      sel.appendChild(SL.h('option', { value: e, text: EASE_LABEL[e] }));
    });
    sel.value = key.e || 'linear';
    sel.addEventListener('change', function () {
      key.e = sel.value;
      syncTimeline();
      setDirty();
    });
    rowEase.appendChild(sel);
    body.appendChild(rowEase);

    body.appendChild(SL.h('div', {
      class: 'ctxmenu-item',
      html: '<span class="lbl">跳到这一帧</span>'
    })).addEventListener('click', function () {
      App.time = key.t;
      App.playing = false;
      App.doc.ui.playing = false;
      syncPlayButton();
      App.needsRender = true;
      closePopover();
      syncTimeline();
    });

    body.appendChild(SL.h('div', { class: 'ctxmenu-sep' }));
    body.appendChild(SL.h('div', {
      class: 'ctxmenu-item',
      html: '<span class="lbl" style="color:var(--bad)">删除这个关键帧</span>'
    })).addEventListener('click', function () {
      keys.splice(idx, 1);
      if (!keys.length) dropTrack(passId, name);
      closePopover();
      syncTimeline();
      renderInspector();
      App.needsRender = true;
      setDirty();
    });

    popoverAt(ev, body);
  }

  let tlPop = null;
  function closePopover() {
    if (tlPop) { tlPop.remove(); tlPop = null; }
  }
  function popoverAt(ev, content) {
    closePopover();
    const pop = SL.h('div', { class: 'popover', style: 'position:fixed;z-index:1200;padding:4px;min-width:220px;animation:none' });
    pop.appendChild(content);
    document.body.appendChild(pop);
    const pad = 8;
    const r = pop.getBoundingClientRect();
    let x = ev.clientX + 8, y = ev.clientY + 8;
    if (x + r.width > innerWidth - pad) x = innerWidth - r.width - pad;
    if (y + r.height > innerHeight - pad) y = ev.clientY - r.height - 8;
    pop.style.left = Math.max(pad, x) + 'px';
    pop.style.top = Math.max(pad, y) + 'px';
    tlPop = pop;
    setTimeout(function () {
      document.addEventListener('pointerdown', function off(e) {
        if (tlPop && !tlPop.contains(e.target)) { closePopover(); document.removeEventListener('pointerdown', off, true); }
      }, true);
    }, 0);
  }

  function bindTimeline() {
    const body = $('#tl-body');
    if (body) {
      body.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.tl-key')) return;
        tlDrag = true;
        try { if (e.pointerId != null) body.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件拿不到 pointerId */ }
        scrubTo(tlXToTime(e.clientX - body.getBoundingClientRect().left));
      });
      body.addEventListener('pointermove', function (e) {
        if (!tlDrag) return;
        scrubTo(tlXToTime(e.clientX - body.getBoundingClientRect().left));
      });
      const stop = function () {
        if (!tlDrag) return;
        tlDrag = false;
        App.save && App.save();
      };
      body.addEventListener('pointerup', stop);
      body.addEventListener('pointercancel', stop);
      body.addEventListener('dblclick', function (e) {
        if (e.target.closest('.tl-key')) return;
        const lane = e.target.closest('.tl-lane');
        if (!lane) return;
        const passId = lane.dataset.pass, name = lane.dataset.name;
        const pass = App.doc.passes.filter(function (p) { return p.id === passId; })[0];
        if (!pass) return;
        const t = Math.max(0, tlXToTime(e.clientX - body.getBoundingClientRect().left));
        setKeyframe(passId, name, Math.round(t * 1000) / 1000, pass.values[name] || [0]);
        syncTimeline();
        setDirty();
      });
    }
    const loopBtn = $('#tl-loop');
    if (loopBtn) loopBtn.addEventListener('click', function () {
      App.doc.loop = !App.doc.loop;
      syncTimeline();
      setDirty();
      if (!App.doc.loop && durationOf() > 0 && App.time > durationOf()) App.time = durationOf();
    });

    // 播放控制（从顶栏搬进时间轴，和游标/时长挨在一起）
    const playBtn = $('#tl-play');
    if (playBtn) playBtn.addEventListener('click', function () { togglePlay(); });
    const stepBtn = $('#tl-step');
    if (stepBtn) stepBtn.addEventListener('click', function () { stepFrame(1); });
    const stepPrev = $('#tl-step-prev');
    if (stepPrev) stepPrev.addEventListener('click', function () { stepFrame(-1); });
    const resetBtn = $('#tl-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { resetTime(); });

    // 时长直接在时间轴上改：0 = 无限
    const durIn = $('#tl-dur');
    if (durIn) {
      const commitDur = function () {
        let v = Number(durIn.value);
        if (!isFinite(v) || v < 0) v = 0;
        v = Math.round(v * 100) / 100;
        App.doc.duration = v;
        if (v > 0 && App.time > v) App.time = App.doc.loop ? App.time % v : v;
        durIn.value = String(v);
        syncTimeline();
        setDirty();
        App.needsRender = true;
      };
      durIn.addEventListener('change', commitDur);
      durIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitDur(); durIn.blur(); }
        else if (e.key === 'Escape') { durIn.value = String(durationOf()); durIn.blur(); }
      });
    }

    const fitBtn = $('#tl-fit');
    if (fitBtn) fitBtn.addEventListener('click', fitTimeline);
    const colBtn = $('#tl-collapse');
    if (colBtn) colBtn.addEventListener('click', function () {
      const box = $('#timeline');
      box.classList.toggle('collapsed');
      colBtn.textContent = box.classList.contains('collapsed') ? '展开' : '收起';
    });
    const keyBtn = $('#tl-key');
    if (keyBtn) keyBtn.addEventListener('click', keyAllTracks);
  }

  /** 当前时刻给这个 Pass 的全部轨道补一帧（按钮和 K 键共用） */
  function keyAllTracks() {
    const pass = selectedPass();
    if (!pass) return;
    const lanes = tracksOf(pass.id);
    const names = Object.keys(lanes);
    if (!names.length) {
      SL.ui.toast('这个 Pass 还没有任何关键帧：先在参数名后面点 ◇ 打一帧，之后就能用「打帧」批量补', 'warn');
      return;
    }
    const t = Math.round(App.time * 1000) / 1000;
    names.forEach(function (n) {
      const vals = sampleTrack(lanes[n], t) || pass.values[n] || [0];
      setKeyframe(pass.id, n, t, vals);
    });
    syncTimeline();
    renderInspector();
    setDirty();
    SL.ui.toast('已在 ' + t.toFixed(2) + 's 为 ' + names.length + ' 个参数打帧', 'ok');
  }

  function renderFrame(dt) {
    const out = outputSize();
    const dur = durationOf();
    // 关键帧先写回 pass.values，shader 才能看到这一帧的动画值
    applyTracks(App.time);
    const state = {
      output: out,
      passes: App.doc.passes,
      time: App.time,
      mouse: App.mouse,
      // 预览跟着选中的 Pass 走：看到的就是这一阶段的输出（中间态显示它生成的图）
      viewPassId: App.viewPin || App.doc.selectedPassId || null,
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
    syncResolutionLabel(out);
    updatePlayhead();

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
    const sel = selectedPass();
    const fin = outputPass();
    if (!App.doc.passes.length) {
      vb.classList.add('hidden');
      return;
    }
    vb.classList.remove('hidden');
    const atFinal = !sel || !fin || sel.id === fin.id;
    vb.textContent = atFinal ? '整条管线' : ('预览 · ' + sel.name + (sel.role === 'source' ? '（中间态）' : ''));
    vb.title = atFinal
      ? '正在显示整条管线最后一步的结果'
      : ('正在显示「' + sel.name + '」这一阶段的输出；点一下回到整条管线');
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

  /* ========================================================================
     五、切换 / 时间
     ====================================================================== */
  function confirmDiscard() {
    if (!App.doc.custom) return Promise.resolve(true);
    return SL.ui.confirm({
      title: '替换当前管线？',
      message: '当前管线有没保存的改动，切换后会丢失。',
      detail: '需要保留的话，先用顶栏的「导出工程」存一份 JSON。',
      okLabel: '仍然切换',
      cancelLabel: '取消',
      danger: true
    });
  }

  /** 把管线重置成一条最朴素的起步管线（保留素材与界面偏好）。 */
  function resetPipeline() {
    confirmDiscard().then(function (ok) {
      if (!ok) return;
      const doc = SL.store.normalize(SL.store.defaultState(), { allowNewEffect: true });
      doc.assets = SL.deepClone(App.doc.assets || []);
      doc.ui = SL.deepClone(App.doc.ui);
      doc.resMode = App.doc.resMode;
      applyDoc(doc);
      App.time = 0;
      App.frame = 0;
      SL.store.save(doc);
      SL.ui.toast('已重置为默认管线');
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
    const b = $('#tl-play');
    if (!b) return;
    b.innerHTML = SL.icon(App.playing ? 'pause' : 'play', 14);
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
  }

  function resetTime() {
    App.time = 0;
    App.frame = 0;
    App.needsRender = true;
    syncScrub();
  }

  /* ========================================================================
     五之二、效果库：从 effects/ 的包加载到编辑器
     ====================================================================== */
  /** 把效果包解析成一份可用的文档（异步：文件型输入图要先注册成资源） */
  function buildDocFromEffect(eff) {
    const jobs = (eff.assets || []).map(function (a) {
      if (a.kind === 'builtin') return Promise.resolve({ slot: a.slot, assetId: 'b:' + a.builtin });
      if (a.kind === 'library') {
        // 公共图库只存引用：lib:<id> 在启动时已经建好条目
        const id = 'lib:' + a.libId;
        if (App.assets.byId(id)) return Promise.resolve({ slot: a.slot, assetId: id });
        return Promise.resolve({ slot: a.slot, assetId: null });
      }
      if (a.kind === 'url') {
        // 服务模式：效果包目录里的 input/xxx.png，直接当 URL 载入
        const existUrl = App.assets.items.filter(function (it) { return it.url === a.url; })[0];
        if (existUrl) return Promise.resolve({ slot: a.slot, assetId: existUrl.id });
        return App.assets.importURL(a.name, a.url).then(function (entry) {
          return { slot: a.slot, assetId: entry.id };
        }).catch(function () {
          return { slot: a.slot, assetId: null };
        });
      }
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
          role: p.role === 'source' ? 'source' : 'filter',
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
        timeline: SL.deepClone(eff.tracks || {}),
        // 打开效果时默认看最终结果：选中最后一个 Pass（中间态是 source 时才不会被选中）
        selectedPassId: passes.length ? passes[passes.length - 1].id : null,
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
      if (!ok) return false;
      return buildDocFromEffect(eff).then(function (doc) {
        const next = SL.store.normalize(doc, { allowNewEffect: true });
        next.ui.playing = true;
        next.ui.zoom = 1;
        applyDoc(next);
        App.time = 0;
        App.frame = 0;
        App.playing = true;
        syncPlayButton();
        syncScrub();
        const kb = eff.tags && eff.tags.length ? ' · ' + eff.tags.join(' / ') : '';
        SL.ui.toast(eff.name + kb + (eff.desc ? '\n' + eff.desc : ''), 'info');
        SL.store.save(next);
        return true;
      });
    });
  }

  /* ---------------------------- 时间轴（旧实现已换成上面的 syncTimeline） ---------------------------- */
  function syncScrub() { syncTimeline(); }

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
     五之四、新建效果：背景 Pass + 效果 Pass，并导出成效果包
     ====================================================================== */
  const NEW_BG_CODE = [
    '// 背景：把这张图铺满整个画面（想换图就在「纹理」页点别的素材）',
    'uniform sampler2D u_bg;',
    'uniform float u_zoom;   // @range 0.5 2 @step 0.01 @default 1 @label 缩放',
    '',
    'void main() {',
    '  vec2 uv = (vUv - 0.5) / u_zoom + 0.5;',
    '  fragColor = vec4(texture(u_bg, uv).rgb, 1.0);',
    '}'
  ].join('\n');

  const NEW_FX_CODE = [
    '// 效果：u_src 是上一个 Pass（背景）的输出，在这里加你要的效果',
    'uniform sampler2D u_src;',
    'uniform float u_gain;     // @range 0 2 @step 0.01 @default 1.0 @label 强度',
    'uniform float u_sweep;    // @range -0.3 1.3 @step 0.01 @default -0.2 @label 扫光位置',
    'uniform float u_strength; // @range 0 1 @step 0.01 @default 0.45 @label 光强',
    'uniform vec3  u_color;    // @color @label 光色',
    '',
    'void main() {',
    '  vec3 c = texture(u_src, vUv).rgb * u_gain;',
    '  // 斜向扫光：用 q*q 而不是 pow(q,2.0)——pow 的底数为负时 GLSL 未定义',
    '  float q = (vUv.x + vUv.y - u_sweep) / 0.18;',
    '  float band = exp(-q * q);',
    '  // 亮部才算光：按底图亮度收一点，避免暗处也被刷成一片白',
    '  float lum = sl_luma(c);',
    '  vec3 shine = u_color * band * (0.18 + 0.82 * lum) * u_strength;',
    '  fragColor = vec4(c + shine, 1.0);',
    '}'
  ].join('\n');

  function kebabId(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }

  function openNewEffect() {
    const body = SL.h('div', { style: 'display:grid;gap:11px;min-width:420px' });
    const field = function (label, el, hint) {
      const wrap = SL.h('div', { class: 'ef-row' });
      wrap.appendChild(SL.h('label', { text: label }));
      const box = SL.h('div', { style: 'display:flex;flex-direction:column;gap:3px;min-width:0' });
      box.appendChild(el);
      if (hint) box.appendChild(SL.h('div', { class: 'insp-note', style: 'padding:0', text: hint }));
      wrap.appendChild(box);
      return wrap;
    };

    const nameIn = SL.h('input', { class: 'inp', type: 'text', placeholder: '例如：刀光 · 横扫', value: '' });
    const idIn = SL.h('input', { class: 'inp', type: 'text', placeholder: 'my-effect', style: 'font-family:var(--mono)' });
    const tagsIn = SL.h('input', { class: 'inp', type: 'text', placeholder: '刀光, 一次性, alpha' });
    const alphaCb = SL.h('input', { type: 'checkbox' });
    const bgSel = SL.h('select', { class: 'sel' });
    App.assets.items.forEach(function (a) {
      bgSel.appendChild(SL.h('option', { value: a.id, text: a.name + '  ' + a.width + '×' + a.height }));
    });
    if (App.doc.source) bgSel.value = App.doc.source;

    nameIn.addEventListener('input', function () {
      if (!idIn.dataset.touched) idIn.value = kebabId(nameIn.value);
    });
    idIn.addEventListener('input', function () { idIn.dataset.touched = '1'; });

    body.appendChild(field('名称', nameIn));
    body.appendChild(field('效果 id', idIn, '会成为目录名：effects/<id>/，只能用 a-z 0-9 和短横线；留空就自动生成'));
    body.appendChild(field('标签', tagsIn, '逗号分隔，图库里按标签筛选用'));
    body.appendChild(field('背景图', bgSel, '第一个 Pass 用它铺底，第二个 Pass 在它上面做效果'));
    body.appendChild(field('输出', SL.h('label', { class: 'switch-label' }, alphaCb, SL.h('span', { class: 'sw' }), SL.h('span', { text: '透明背景（alpha）' }))));
    body.appendChild(SL.h('div', {
      class: 'insp-note', style: 'padding-top:2px',
      text: '时长在创建后到时间轴上改（0 = 无限时间）；打关键帧也在时间轴上。'
    }));

    const cancel = SL.h('button', { class: 'btn', text: '取消' });
    const ok = SL.h('button', { class: 'btn primary', text: '创建并打开' });
    const m = SL.ui.modal({ title: '新建效果', icon: 'plus', body: body, footer: [SL.h('span', { class: 'grow' }), cancel, ok] });
    cancel.addEventListener('click', m.close);

    ok.addEventListener('click', function () {
      const name = (nameIn.value || '').trim();
      if (!name) { SL.ui.toast('先给它起个名字', 'warn'); nameIn.focus(); return; }
      // 名称是中文时 kebabId 会得到空串，这时自动生成一个可用的 id
      const id = kebabId(idIn.value || '') || kebabId(name) || ('fx-' + Date.now().toString(36).slice(-5));
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { SL.ui.toast('id 只能是 a-z 0-9 和短横线', 'warn'); return; }
      const exists = (window.SL_EFFECTS && window.SL_EFFECTS.effects || []).some(function (e) { return e.id === id; });
      if (exists) { SL.ui.toast('效果库里已经有「' + id + '」了，换个 id', 'warn'); return; }

      const dur = 0;              // 新建时不设时长，到时间轴上改
      const loop = true;
      const bgId = bgSel.value;
      const doc = makeEffectDraft({
        id: id,
        name: name || id,
        tags: (tagsIn.value || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        duration: dur,
        loop: loop,
        alpha: alphaCb.checked,
        bgAssetId: bgId
      });
      const next = SL.store.normalize(doc, { allowNewEffect: true });
      next.ui.playing = true;
      next.ui.zoom = 1;
      applyDoc(next);
      App.time = 0;
      App.frame = 0;
      App.playing = true;
      syncPlayButton();
      syncTimeline();
      m.close();
      SL.store.save(next);
      offerEffectExport(id, name || id);
    });
  }

  /** 根据表单生成一份「背景 Pass + 效果 Pass」的草稿文档 */
  function makeEffectDraft(cfg) {
    const bgAsset = App.assets.byId(cfg.bgAssetId) || App.assets.items[0];
    const dur = Math.max(0, Number(cfg.duration) || 0);
    const passes = [{
      id: 'p1',
      name: '背景',
      code: NEW_BG_CODE,
      enabled: true,
      format: 'rgba8',
      scale: 1,
      filter: 'linear',
      wrap: 'clamp',
      bindings: { u_bg: { kind: 'asset', assetId: bgAsset ? bgAsset.id : 'b:testcard' } },
      values: { u_zoom: [1] }
    }, {
      id: 'p2',
      name: '效果',
      code: NEW_FX_CODE,
      enabled: true,
      format: 'rgba8',
      scale: 1,
      filter: 'linear',
      wrap: 'clamp',
      bindings: { u_src: { kind: 'prev' } },
      values: { u_gain: [1], u_sweep: [0.35], u_strength: [0.45], u_color: [1, 0.96, 0.88] }
    }];
    // 新效果默认无时长（无限时间）：不预置动画，先让画面是「有一条光带」的静止状态，
    // 想动起来就到时间轴上把时长改成 1.2 之类的值，再给 u_sweep 打两帧。
    const timeline = dur > 0 ? {
      p2: {
        u_sweep: [
          { t: 0, v: [-0.2], e: 'inout' },
          { t: dur, v: [1.4], e: 'inout' }
        ]
      }
    } : {};
    return {
      presetId: 'effect:' + cfg.id,
      effectId: cfg.id,
      effectBuiltAt: null,
      custom: false,
      source: bgAsset ? bgAsset.id : 'b:testcard',
      output: { w: 1280, h: 720 },
      resMode: App.doc.resMode,
      alpha: !!cfg.alpha,
      duration: dur,
      loop: cfg.loop,
      previewBg: App.doc.previewBg || 'checker',
      passes: passes,
      timeline: timeline,
      effectName: cfg.name || cfg.id,
      effectTags: cfg.tags || [],
      selectedPassId: 'p2',
      assets: SL.deepClone(App.doc.assets || []),
      ui: SL.deepClone(App.doc.ui || {})
    };
  }

  /** 把当前文档导出成效果包 JSON（交给 node tools/lib.mjs import 落盘） */
  function effectPackFromDoc(id, name) {
    // 文档里的 passId 可能不是 p1..pN，导出时按顺序重新编号
    const passIndex = {};
    App.doc.passes.forEach(function (p, i) { passIndex[p.id] = 'p' + (i + 1); });

    const inputs = {};
    const shaders = {};
    const passes = App.doc.passes.map(function (p, i) {
      const file = 'shaders/p' + (i + 1) + '.frag';
      shaders[file] = p.code;
      const bindings = {};
      Object.keys(p.bindings || {}).forEach(function (slot) {
        const b = p.bindings[slot];
        if (b.kind === 'asset') {
          const a = App.assets.byId(b.assetId);
          const inputName = slot.replace(/^u_/, '') || slot;
          if (a && a.kind === 'library') inputs[inputName] = 'library:' + a.libId;
          else if (a && a.kind === 'builtin') inputs[inputName] = 'builtin:' + a.builtin;
          else if (a && a.dataURL) inputs[inputName] = a.dataURL;   // 拖进来的图：内联，import 时落成 input/<名字>.png
          else return;                                              // 找不到图就不带这个绑定
          bindings[slot] = { kind: 'asset', input: inputName };
        } else if (b.kind === 'pass') {
          const target = b.passId === '__source__' ? 'p1' : (passIndex[b.passId] || 'p1');
          bindings[slot] = { kind: 'pass', pass: target };
        } else {
          bindings[slot] = { kind: b.kind };
        }
      });
      return { name: p.name, shader: file, format: p.format, scale: p.scale, bindings: bindings, values: p.values };
    });

    const eff = {
      id: id,
      name: name || App.doc.effectName || id,
      desc: '',
      tags: App.doc.effectTags || [],
      duration: App.doc.duration || 0,
      loop: App.doc.loop !== false,
      output: { w: App.doc.output.w, h: App.doc.output.h, alpha: !!App.doc.alpha },
      inputs: inputs,
      passes: passes,
      tracks: App.doc.timeline || {}
    };
    return { version: 1, effect: eff, shaders: shaders };
  }

  function offerEffectExport(id, name) {
    const body = SL.h('div', { style: 'display:grid;gap:10px;min-width:440px' });
    const onDisk = !!(window.SL.server && SL.server.on);

    if (onDisk) {
      body.appendChild(SL.h('p', {
        style: 'margin:0;font-size:12.5px;color:var(--text-2);line-height:1.7',
        html: '当前连着本地服务，可以直接把这条管线写进 <code>effects/' + id + '/</code>：'
      }));
      const saveBtn = SL.h('button', { class: 'btn primary', text: '写入 effects/ 并刷新效果库' });
      saveBtn.addEventListener('click', function () {
        saveBtn.disabled = true;
        const pack = effectPackFromDoc(id, name);
        SL.server.putEffect(id, pack.effect, pack.shaders).then(function () {
          return reloadEffectIndex();
        }).then(function () {
          SL.ui.toast('已写入 effects/' + id + '，效果库已更新', 'ok');
          m.close();
          if (typeof libraryOpen === 'function' && libraryOpen) renderLibrary();
        }).catch(function (e) {
          saveBtn.disabled = false;
          SL.ui.toast('写入失败：' + e.message, 'bad');
        });
      });
      body.appendChild(saveBtn);
      body.appendChild(SL.h('div', {
        class: 'insp-note', style: 'padding:0',
        text: '写盘后缩略图会自动重渲，不用再跑 build（build 只给双击 index.html 的离线模式用）。'
      }));
    } else {
      body.appendChild(SL.h('p', {
        style: 'margin:0;font-size:12.5px;color:var(--text-2);line-height:1.7',
        html: '已经在编辑器里打开了。要让它进「效果库」，用下面任意一种方式落盘：'
      }));
      const download = SL.h('button', { class: 'btn primary', text: '下载效果包 JSON' });
      download.addEventListener('click', function () {
        const pack = effectPackFromDoc(id, name);
        SL.io.download(id + '.effect.json', JSON.stringify(pack, null, 2), 'application/json');
        SL.ui.toast('已下载 ' + id + '.effect.json', 'ok');
      });
      body.appendChild(download);
    }

    const cmd = 'node tools/lib.mjs import ' + id + '.effect.json';
    const codeEl = SL.h('code', {
      style: 'display:block;padding:8px 10px;background:var(--bg-code);border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:11.5px;color:var(--text-2);user-select:all',
      text: cmd
    });
    const copyBtn = SL.h('button', { class: 'btn tiny', text: '复制命令' });
    body.appendChild(SL.h('div', { style: 'display:flex;gap:6px;align-items:center' }, copyBtn));
    body.appendChild(SL.h('div', { class: 'insp-note', style: 'padding:0', text: '或者下载 JSON 后手动落盘（离线模式 / 别的机器）：' }));
    body.appendChild(codeEl);
    copyBtn.addEventListener('click', function () {
      copyText(cmd);
    });

    const done = SL.h('button', { class: 'btn', text: '知道了' });
    const m = SL.ui.modal({ title: '保存这个效果', icon: 'download', body: body, footer: [SL.h('span', { class: 'grow' }), done] });
    done.addEventListener('click', m.close);
  }


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
      const fin = outputPass();
      if (!fin) return;
      selectPass(fin.id);
      App.needsRender = true;
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
    $('#btn-save-pass').addEventListener('click', function (e) {
      e.stopPropagation();
      openSavePass();
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
    item('在下方插入 Pass…', function () {
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
    if (App.viewPin === pass.id) App.viewPin = null;
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

  /** 把这个 Pass 的输出单独存成 PNG（临时固定到该 Pass 看一眼，再读画布） */
  function exportPassImage(pass) {
    const prevPin = App.viewPin;
    const wasPlaying = App.playing;
    App.viewPin = pass.id;
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
      App.viewPin = prevPin;
      App.playing = wasPlaying;
      App.needsRender = true;
      syncResolutionLabel();
    }
  }

  function duplicatePass(pass) {
    const copy = SL.deepClone(pass);
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

  function addPass(templateId) {
    if (!templateId) {
      openPassPicker();
      return;
    }
    const tpl = SL.passes.get(templateId);
    const built = SL.passes.build(templateId);
    if (!tpl || !built.length) {
      SL.ui.toast('没有这个 Pass 模板：' + templateId, 'bad');
      return;
    }
    const cur = selectedPass();
    // 中间态（生成类）不读输入，插到管线最前面才不会挡在消费它的 Pass 后面
    const isSource = tpl.role === 'source';
    const at = isSource ? 0 : (cur ? App.doc.passes.indexOf(cur) + 1 : App.doc.passes.length);
    built.forEach(function (bp, k) {
      bp.id = nextPassId();
      App.doc.passes.splice(at + k, 0, bp);
    });
    compileAll();
    selectPass(built[0].id);
    renderPipeline();
    syncResolutionLabel();
    setDirty();
    SL.ui.toast(isSource
      ? '已插入「' + tpl.name + '」到管线开头：它是中间态，在后面 Pass 的采样器里选「指定 Pass」就能采样它'
      : '已插入：' + tpl.name, 'ok');
    if (built.length === 1) App.editor.focus();
  }

  /* --------------------------- 常见 Pass 选择器 --------------------------- */

  let passPicker = null;

  function openPassPicker() {
    if (passPicker) return;
    let box;

    const LABELS = { '': '空白', '我的 Pass': '我的 Pass' };
    SL.passes.groups.forEach(function (g) { LABELS[g] = g; });

    const entries = [{ id: '', name: '空白 Pass', group: '', role: 'blank', desc: '一张白纸，自己写' }]
      .concat(SL.passes.mine().map(function (t) {
        return {
          id: t.id, name: t.name, group: '我的 Pass', role: t.role || 'filter',
          desc: t.desc || '自己存的模板', code: t.pass && t.pass.code, mine: true
        };
      }))
      .concat(SL.passes.list.map(function (t) {
        return {
          id: t.id, name: t.name, group: t.group, role: t.role || 'filter',
          desc: t.desc, code: t.pass && t.pass.code
        };
      }));

    /* 分组芯片：点一下只看这一类，再点「全部」回来 */
    const chipDefs = [{ key: '', label: '全部' }];
    if (SL.passes.mine().length) chipDefs.push({ key: '我的 Pass', label: '我的' });
    SL.passes.groups.forEach(function (g) { chipDefs.push({ key: g, label: g }); });
    let curGroup = '';

    function roleTag(e) {
      if (e.role === 'source') return '<i class="pp-tag src">中间态</i>';
      if (e.role === 'filter') return '<i class="pp-tag">叠加</i>';
      return '';
    }

    function rowHtml(e) {
      return '<span class="pp-ico">' + (e.id ? SL.icon('sliders', 13) : SL.icon('plus', 13)) + '</span>' +
        '<span class="pp-body"><span class="pp-name">' + SL.esc(e.name) + roleTag(e) + '</span>' +
        '<span class="pp-desc">' + SL.esc(e.desc || '') + '</span></span>';
    }

    const html =
      '<div class="pp-wrap">' +
      '<div class="pp-search"><input id="pp-input" type="text" placeholder="搜索 Pass（名称 / 说明）…" spellcheck="false" autocomplete="off"></div>' +
      '<div class="pp-chips" id="pp-chips"></div>' +
      '<div class="pp-list" id="pp-list"></div>' +
      '<div class="pp-foot">回车插入到当前 Pass 之后 · <b>中间态</b>不读输入，用「指定 Pass」被其他 Pass 采样 · Esc 取消</div>' +
      '</div>';

    passPicker = SL.ui.modal({
      title: '插入常见 Pass',
      icon: 'sliders',
      narrow: false,
      body: html,
      footer: null,
      onClose: function () { passPicker = null; }
    });

    const input = passPicker.body.querySelector('#pp-input');
    const listEl = passPicker.body.querySelector('#pp-list');
    const chipsEl = passPicker.body.querySelector('#pp-chips');
    let filtered = entries;
    let sel = 0;

    function drawChips() {
      chipsEl.innerHTML = '';
      chipDefs.forEach(function (c) {
        const n = c.key ? entries.filter(function (e) { return e.group === c.key; }).length : entries.length;
        const el = SL.h('button', {
          class: 'pp-chip' + (c.key === curGroup ? ' on' : ''),
          'data-key': c.key,
          html: SL.esc(c.label) + '<i>' + n + '</i>'
        });
        el.addEventListener('click', function () {
          curGroup = c.key;
          applyFilter();
          drawChips();
          input.focus();
        });
        chipsEl.appendChild(el);
      });
    }

    function applyFilter() {
      const q = input.value.trim().toLowerCase();
      filtered = entries.filter(function (e) {
        if (curGroup && e.group !== curGroup) return false;
        if (!q) return true;
        return (e.name + ' ' + (e.desc || '') + ' ' + (e.group || '') + ' ' +
          (e.code || '').toLowerCase()).indexOf(q) >= 0;
      });
      sel = 0;
      draw();
    }

    function draw() {
      listEl.innerHTML = '';
      if (!filtered.length) {
        listEl.appendChild(SL.h('div', { class: 'pp-empty', text: '没有匹配的 Pass' }));
        return;
      }
      let lastGroup = null;
      filtered.forEach(function (e, i) {
        if (e.group !== lastGroup) {
          lastGroup = e.group;
          listEl.appendChild(SL.h('div', { class: 'pp-group', text: LABELS[e.group] || e.group || '其它' }));
        }
        const row = SL.h('div', { class: 'pp-item' + (i === sel ? ' active' : '') + (e.mine ? ' mine' : ''), html: rowHtml(e) });
        row.addEventListener('click', function () { pick(i); });
        row.addEventListener('mouseenter', function () {
          sel = i;
          Array.prototype.forEach.call(listEl.querySelectorAll('.pp-item'), function (x, k) {
            x.classList.toggle('active', k === i);
          });
        });
        if (e.mine) {
          const del = SL.h('button', { class: 'pp-del', title: '删除这个自定义 Pass', html: SL.icon('trash', 12) });
          del.addEventListener('click', function (ev) {
            ev.stopPropagation();
            SL.ui.confirm({
              title: '删除自定义 Pass',
              message: '从「我的 Pass」里删掉「' + e.name + '」？',
              detail: '只会删掉模板，已经插进管线的 Pass 不受影响。',
              okLabel: '删除', danger: true
            }).then(function (ok) {
              if (!ok) return;
              SL.passes.remove(e.id);
              SL.ui.toast('已删除「' + e.name + '」', 'ok');
              // 确认框弹出时选择器可能已被覆盖层关掉，这里统一重开
              if (passPicker) passPicker.close();
              openPassPicker();
            });
          });
          row.appendChild(del);
        }
        listEl.appendChild(row);
      });
    }

    function pick(i) {
      const e = filtered[i];
      if (!e) return;
      const id = e.id;
      if (passPicker) { passPicker.close(); }
      if (id) addPass(id);
      else insertBlankPass();
    }

    input.addEventListener('input', applyFilter);

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); draw(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        // 左右键切分组，找得比敲字快
        ev.preventDefault();
        const at = chipDefs.findIndex(function (c) { return c.key === curGroup; });
        const next = (ev.key === 'ArrowRight' ? at + 1 : at - 1 + chipDefs.length) % chipDefs.length;
        curGroup = chipDefs[next].key;
        applyFilter();
        drawChips();
      }
      else if (ev.key === 'Enter') { ev.preventDefault(); pick(sel); }
    });

    drawChips();
    draw();
    setTimeout(function () { input.focus(); }, 30);
  }

  /** 把编辑器里的代码存成可复用的 Pass 模板（放在浏览器本地） */
  function openSavePass() {
    const pass = selectedPass();
    if (!pass) return;
    const code = App.editor ? App.editor.getValue() : pass.code;
    if (!code.trim()) { SL.ui.toast('这段代码是空的', 'info'); return; }

    // 不读 u_tex 就是中间态（生成器），读就是叠加态
    const dry = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const looksSource = !/\bu_tex\b/.test(dry);

    const field = function (label, el) {
      const wrap = SL.h('div', { class: 'ef-row' });
      wrap.appendChild(SL.h('label', { text: label }));
      wrap.appendChild(el);
      return wrap;
    };

    const nameIn = SL.h('input', { class: 'inp', type: 'text', value: pass.name || '', maxlength: '24', placeholder: '例如：扫描光' });
    const roleSel = SL.h('select', { class: 'inp' });
    roleSel.appendChild(SL.h('option', { value: 'filter', text: '叠加态 · 读上一 Pass 的输出' }));
    roleSel.appendChild(SL.h('option', { value: 'source', text: '中间态 · 自己生成图，供别的 Pass 采样' }));
    roleSel.value = looksSource ? 'source' : 'filter';
    const descIn = SL.h('input', { class: 'inp', type: 'text', maxlength: '60', placeholder: '一句话：干什么用的（会显示在选择器里）' });

    const body = SL.h('div', { style: 'display:grid;gap:11px;min-width:420px' });
    body.appendChild(field('名称', nameIn));
    body.appendChild(field('角色', roleSel));
    body.appendChild(field('说明', descIn));
    body.appendChild(SL.h('div', {
      class: 'sp-note',
      html: '存进浏览器的「我的 Pass」，以后在<b>插入 Pass → 我的</b>里就能找到；同名再存一次会覆盖。只存模板，不动当前管线。'
    }));

    const cancel = SL.h('button', { class: 'btn', text: '取消' });
    const ok = SL.h('button', { class: 'btn primary', text: '保存' });
    const m = SL.ui.modal({ title: '存为 Pass 模板', icon: 'save', body: body, footer: [SL.h('span', { class: 'grow' }), cancel, ok] });
    cancel.addEventListener('click', m.close);
    ok.addEventListener('click', function () {
      const name = (nameIn.value || '').trim();
      if (!name) { SL.ui.toast('给它起个名字', 'info'); nameIn.focus(); return; }
      const tpl = SL.passes.save({
        name: name,
        role: roleSel.value,
        desc: (descIn.value || '').trim(),
        code: code
      });
      m.close();
      SL.ui.toast('已存进「我的 Pass」：' + tpl.name, 'ok');
    });
    setTimeout(function () { nameIn.focus(); if (nameIn.select) nameIn.select(); }, 40);
  }

  /** 空白 Pass 走原来的模板 */
  function insertBlankPass() {    const cur = selectedPass();
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
    // 预览跟着选中走：选哪个 Pass 就看它这一阶段的画面
    App.needsRender = true;
    recompile.cancel();

    if (App.editor) {
      if (App.editor.getValue() !== pass.code) App.editor.setValue(pass.code, true);
    }
    if (!App.compiled[pass.id]) compilePass(pass);
    syncEditorChrome();
    renderInspector();
    syncResolutionLabel();
    if (!silent) {
      renderPipeline();
      // 让选中的 Pass 在左栏可见（Pass 多了以后键盘切换全靠这个）
      const item = $('#pass-list') && $('#pass-list').querySelector('.pass-item[data-id="' + pass.id + '"]');
      if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
      SL.store.save(App.doc);
    }
  }

  function bindPipelineButtons() {
    // 注意：不能直接把 addPass 当 handler，事件对象会被当成 templateId
    $('#btn-add-pass').addEventListener('click', function () { addPass(); });
    $('#btn-add-pass-2').addEventListener('click', function () { addPass(); });
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
        onValueChange: function (name, values) {
          // 这个参数已经有动画 → 拖动就是改当前时刻那一帧（自动打帧）
          if (trackOf(pass.id, name)) {
            setKeyframe(pass.id, name, Math.round(App.time * 1000) / 1000, values);
            syncTimeline();
          }
          App.needsRender = true;
          setDirty();
        },
        onBindingChange: function () {
          App.needsRender = true;
          setDirty();
        },
        hasTrack: function (name) { return !!trackOf(pass.id, name); },
        keyAt: function (name) { return !!keyframeAt(pass.id, name, App.time); },
        onKeyframe: function (name, values) { toggleKeyframe(pass.id, name, values); },
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

    // 资源列表：公共图库（library/ 里的素材）和用户导入的图分开列
    const cardGrid = function (items) {
      const grid = SL.h('div', { class: 'asset-grid' });
      items.forEach(function (a) {
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
          text: a.width + '×' + a.height + ' · ' + (a.kind === 'builtin' ? '内置' : a.kind === 'library' ? '图库' : '导入')
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
      return grid;
    };

    [{
      title: '公共图库',
      items: App.assets.items.filter(function (a) { return a.kind === 'library'; }),
      note: (window.SL.server && SL.server.on)
        ? 'library/ 目录里的文件：拖图进来会自动写盘。点缩略图直接当输入图。'
        : '放在 library/ 里的公共素材（跑过 node tools/lib.mjs build 才有）。点缩略图直接当输入图。'
    }, {
      title: '资源库',
      items: App.assets.items.filter(function (a) { return a.kind !== 'library'; }),
      note: null
    }].forEach(function (g) {
      if (!g.items.length) return;
      const sec = SL.h('div', { class: 'insp-section' });
      const hd = SL.h('div', { class: 'insp-head' });
      hd.appendChild(SL.h('span', { text: g.title }));
      hd.appendChild(SL.h('span', { class: 'count', text: String(g.items.length) }));
      sec.appendChild(hd);
      sec.appendChild(cardGrid(g.items));
      if (g.note) sec.appendChild(SL.h('div', { class: 'insp-note', text: g.note }));
      host.appendChild(sec);
    });

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
      const isLib = entry.kind === 'library';
      const del = SL.h('div', { class: 'ctxmenu-item', style: 'color:#ff9caa', text: isLib ? '从 library/ 删掉这个文件' : '删除这张贴图' });
      del.addEventListener('click', function () {
        pop.close();
        const finish = function () {
          App.assets.remove(entry.id);
          App.doc.assets = (App.doc.assets || []).filter(function (a) { return a.id !== entry.id; });
          if (App.doc.source === entry.id) App.doc.source = SL.assetDefaults.testcard;
          App.needsRender = true;
          refresh();
          setDirty();
        };
        // 图库条目在服务模式下对应磁盘上的真实文件，先删文件
        if (isLib && window.SL.server && SL.server.on && entry.note) {
          SL.server.delLibrary(entry.note).then(finish).catch(function (e) {
            SL.ui.toast('删除失败：' + e.message, 'bad');
          });
        } else {
          finish();
        }
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

  /** 上传到 library/ 用的文件名：保留扩展名，其余字符收敛到 [a-z0-9._-] */
  function safeLibName(file) {
    const ext = ((file.name || '').match(/\.[a-z0-9]+$/i) || ['.png'])[0].toLowerCase();
    const raw = String(file.name || 'image');
    let base = raw.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
      .replace(/[-.]{2,}/g, '-').slice(0, 40);
    // 纯中文名洗完之后几乎空了：用原名哈希兜底，避免都变成 1.png / 2.png
    if (base.replace(/[^a-z0-9]/g, '').length < 2) {
      let h = 2166136261;
      for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      base = 'img-' + h.toString(36).slice(0, 5) + '-' + Date.now().toString(36).slice(-3);
    }
    return base + ext;
  }

  function importFiles(files) {
    if (!files || !files.length) return;
    const imgs = files.filter(function (f) { return /^image\//.test(f.type); });
    if (!imgs.length) {
      SL.ui.toast('只能导入图片文件', 'warn');
      return;
    }

    // 服务模式：拖进来的图直接写进 library/，刷新后仍然是文件，不再是 base64
    if (window.SL.server && SL.server.on) {
      let names = [];
      let chain = Promise.resolve();
      imgs.forEach(function (f) {
        const name = safeLibName(f);
        names.push(name);
        chain = chain.then(function () { return SL.server.uploadLibrary(name, f); });
      });
      chain.then(function () {
        return App.assets.ensureLibrary(function () { App.needsRender = true; });
      }).then(function () {
        const libId = 'lib:' + SL.libIdFromFile(names[names.length - 1]);
        if (App.assets.byId(libId)) App.doc.source = libId;
        App.needsRender = true;
        renderInspector();
        setDirty();
        SL.ui.toast('已写入 library/：' + names.join('、'), 'ok');
      }).catch(function (err) {
        SL.ui.toast('上传失败：' + (err && err.message ? err.message : err), 'bad');
      });
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
    $('#btn-library').addEventListener('click', openLibrary);
    $('#btn-new-effect').addEventListener('click', function () {
      if (libraryOpen()) closeLibrary();
      openNewEffect();
    });
    $('#lib-close').addEventListener('click', closeLibrary);
    $('#lib-search').addEventListener('input', function (e) {
      libQuery = e.target.value || '';
      renderLibrary();
    });
    $('#btn-bg').addEventListener('click', cyclePreviewBg);

    $('#btn-shot').addEventListener('click', function () {
      try {
        const url = App.engine.screenshot();
        const a = document.createElement('a');
        a.href = url;
        a.download = 'shaderlab-' + (App.doc.effectId || 'shot') + '-' + stamp() + '.png';
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
      if (mod && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        openSavePass();
        return;
      }
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
        case 'v': case 'V': {
          e.preventDefault();
          const fin = outputPass();
          if (fin) { selectPass(fin.id); App.needsRender = true; }
          break;
        }
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
          e.preventDefault();
          if (e.shiftKey) insertBlankPass(); else openPassPicker();
          break;
        case 'k': case 'K':
          e.preventDefault(); keyAllTracks(); break;
        case 't': case 'T':
          e.preventDefault(); togglePass(selectedPass()); break;
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
    add('操作', '新建效果…', '', 'plus', openNewEffect, '背景 Pass + 效果 Pass 起步，可导出成效果包');
    add('操作', '导出效果包 JSON', '', 'download', function () {
      const id = App.doc.effectId || kebabId(App.doc.effectName || '') || ('fx-' + Date.now().toString(36).slice(-5));
      offerEffectExport(id, App.doc.effectName || id);
    }, '把当前文档重新打包，供 tools/lib.mjs import');
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
    add('操作', '插入常见 Pass…', 'N', 'sliders', openPassPicker, '调色 / 模糊 / 提取 / 合成 / 风格化 / 扭曲');
    add('操作', '新增空白 Pass', 'Shift+N', 'plus', insertBlankPass);
    add('操作', '重置为默认管线', '', 'reset', resetPipeline, '清空后只留一个基础调色 Pass');
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
    if (App.doc && selectedPass() && outputPass() && App.doc.selectedPassId !== outputPass().id) {
      add('操作', '回到整条管线', 'V', 'eye', function () {
        const fin = outputPass();
        if (fin) { selectPass(fin.id); App.needsRender = true; }
      });
    }

    SL.passes.list.forEach(function (tpl) {
      add('插入 Pass', tpl.name, tpl.group, 'sliders', function () { addPass(tpl.id); }, tpl.desc || '');
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
      class: 'cmdk-input', type: 'text', placeholder: '搜索命令、Pass、效果、贴图…',
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
    // 焦点可能被其他浮层抢走，Esc 在 document 上兜底
    document.addEventListener('keydown', cmdkEsc, true);
  }

  function cmdkEsc(e) {
    if (e.key !== 'Escape' || !cmdkEl) return;
    e.preventDefault();
    e.stopPropagation();
    closeCmdk();
  }

  function closeCmdk() {
    if (!cmdkEl) return;
    document.removeEventListener('keydown', cmdkEsc, true);
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
      '<li>左上「效果库」里挑一个例子（<kbd>Ctrl</kbd>+<kbd>L</kbd>）；想从零开始就按 <kbd>N</kbd> 挑一个常见 Pass。</li>',
      '<li>下方编辑器改 shader，改完自动重新编译（也可 <kbd>Ctrl</kbd>+<kbd>↵</kbd> 立即编译）。</li>',
      '<li>右侧「Uniforms」调参数、「纹理」换输入图；左栏按 <kbd>N</kbd> 插入调色 / 模糊 / 泛光等现成 Pass。</li>',
      '<li>要做动画：在这个参数名后面点 <code>◇</code> 打一帧，拖时间轴再改值就会自动补帧。</li>',
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
      '<h3>时间轴与关键帧</h3>',
      '<ul>',
      '<li>预览下方是时间轴：时长为 0 时时间一直递增（「无限时间」）；填了时长且打开「循环」时绕圈跑，关掉就播到末尾停住。</li>',
      '<li>点 / 拖时间轴定位；双击轨道在那一帧补一个关键帧；点关键帧改「到下一帧的缓动」（线性 / 缓入 / 缓出 / 缓入缓出 / 阶跃）。</li>',
      '<li>右侧每个参数后面有个 <code>◇</code>：点一下就在当前时刻打帧，变成 <code>◆</code> 表示这个参数有动画。' +
      '已经有动画的参数，直接拖滑块就会在当前时刻自动写帧。</li>',
      '<li>时间轴右侧的「打帧」按钮（或 <kbd>K</kbd>）把当前 Pass 的所有轨道在这一帧补齐。</li>',
      '</ul>',
      '<h3>公共图库与新建效果</h3>',
      '<p>素材图放到 <code>library/</code>（png / jpg / webp），跑一次 <code>node tools/lib.mjs build</code> 就会出现在「纹理」页的「公共图库」里，' +
      '可以直接当输入图或背景图用；效果包的 <code>inputs</code> 里写 <code>"library:文件名"</code> 也能引用它。</p>',
      '<p>新建效果：效果库面板右上角「＋ 新建效果」，或在命令面板里搜「新建效果」。' +
      '会得到两个 Pass——<b>p1 背景</b>（铺底图）和 <b>p2 效果</b>（在上一个 Pass 上做效果）；时长不在这里填，' +
      '创建后到时间轴上直接改（0 = 无限时间）再打关键帧。' +
      '做完点「导出效果包 JSON」下载，然后 <code>node tools/lib.mjs import 文件名.effect.json</code> + <code>build</code> 就进库了。</p>',
      '<h3>常见 Pass</h3>',
      '<p>按 <kbd>N</kbd>（或左栏「插入 Pass」）打开选择器，顶部芯片可以按分组过滤：生成 / 调色 / 模糊 / 提取 / 合成 / 风格化 / 扭曲。' +
      '一个模板就是一个 Pass，插进来之后就是普通 Pass，代码、参数、绑定都能改。</p>',
      '<p><b>叠加态</b>（调色 / 模糊 / 扭曲…）读上一 Pass 的输出再输出；' +
      '<b>中间态</b>（柏林噪声 / FBM / 沃罗诺伊 / 渐变…）不读输入、自己生成一张图，插到管线最前面但不参与主链——' +
      '在别的 Pass 的采样器里选「指定 Pass」指到它，才能拿来当噪声、遮罩或位移图。</p>',
      '<h3>播放与时长</h3>',
      '<p>播放 / 单帧 / 单帧后退 / 归零都在时间轴左边；「时长」输入框直接改这个管线的时长：' +
      '<code>0</code> 表示无限时间（u_time 一直涨），大于 0 时时间按它循环，并且可以给参数打关键帧。</p>',
      '<h3>预览与选中</h3>',
      '<p>预览默认跟着「当前选中的 Pass」走：点左栏哪个 Pass，画面上就是<b>跑到那一步为止</b>的结果，' +
      '所以点一个中间态（噪声 / FBM…）能直接看到它生成的纹理。' +
      '选中最后一步时预览的是整条管线（左上角显示「整条管线」）；点这个标签或按 <kbd>V</kbd> 随时跳回最后一步。</p>',
      '<h3>把代码存成 Pass</h3>',
      '<p>编辑器右上角「存为 Pass」（或 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>）能把当前这段 shader 存进「我的 Pass」：' +
      '填个名字，选「叠加态 / 中间态」，之后按 <kbd>N</kbd> 在选择器顶部的「我的」芯片里就能找到，插进来就是普通 Pass。' +
      '同名再存一次是更新；在选择器里把鼠标移到「我的」条目上，右边的垃圾桶可以删。</p>',
      '<h3>快捷键</h3>',
      '<table class="keys-grid">',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>命令面板：搜命令 / Pass 模板 / 效果 / 贴图</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>打开 / 关闭效果库</td></tr>',
      '<tr><td><kbd>Space</kbd></td><td>播放 / 暂停</td></tr>',
      '<tr><td><kbd>→</kbd> <kbd>←</kbd></td><td>单帧前进 / 后退</td></tr>',
      '<tr><td><kbd>R</kbd></td><td>时间归零</td></tr>',
      '<tr><td><kbd>F</kbd> / <kbd>0</kbd> / 双击预览</td><td>适应窗口 / 100% / 适应窗口</td></tr>',
      '<tr><td><kbd>B</kbd> 或按住 <kbd>\\</kbd></td><td>对比原始输入图</td></tr>',
      '<tr><td><kbd>Z</kbd></td><td>专注模式（只留预览，<kbd>Esc</kbd> 退出）</td></tr>',
      '<tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>上一个 / 下一个 Pass</td></tr>',
      '<tr><td><kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd></td><td>插入常见 Pass / 插入空白 Pass</td></tr>',
      '<tr><td><kbd>V</kbd></td><td>跳回最后一步（预览整条管线）</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd></td><td>把当前 shader 存成 Pass 模板</td></tr>',
      '<tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>复制当前 Pass</td></tr>',
      '<tr><td><kbd>K</kbd></td><td>当前时刻给这个 Pass 的所有轨道打帧</td></tr>',
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
    SL.passes.list.forEach(function (tpl) {
      const built = SL.passes.build(tpl.id);
      built.forEach(function (pass, i) {
        const res = App.engine.compile(pass.code, { isFirst: i === 0 });
        report.push({
          template: tpl.id, pass: pass.name, ok: res.ok,
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
    /** 把一个常见 Pass 模板应用到当前文档（清空管线后插入） */
    loadTemplate: function (id) {
      const built = SL.passes.build(id);
      if (!built.length) return null;
      const doc = SL.store.defaultState();
      doc.source = (App.doc && App.doc.source) || doc.source;
      doc.output = (App.doc && App.doc.output) || doc.output;
      doc.assets = SL.deepClone((App.doc && App.doc.assets) || []);
      doc.ui = SL.deepClone((App.doc && App.doc.ui) || {});
      doc.passes = built.map(function (bp, i) { bp.id = 'p' + (i + 1); return bp; });
      App.doc = SL.store.normalize(doc, { allowEmpty: false });
      App.time = 0; App.frame = 0;
      selectPass(App.doc.passes[0].id, true);
      compileAll();
      renderPipeline();
      renderInspector();
      syncStage();
      syncScrub();
      App.needsRender = true;
      updateDocBadge();
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
    // 当前文档打包成效果包（等价于点「下载效果包 JSON」）
    pack: function (id, name) {
      return effectPackFromDoc(id || App.doc.effectId || 'effect-draft', name || App.doc.effectName || '效果');
    },
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
