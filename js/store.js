/* ==========================================================================
   store.js — 文档状态、持久化、导入导出
   --------------------------------------------------------------------------
   · 状态即一份可 JSON 化的文档（passages 里带源码与参数值）
   · IndexedDB 自动保存（失败退回 localStorage），容量足够放导入的贴图
   · 导出/导入 .json：换机器、贴给别人
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  const DB_NAME = 'shader-lab';
  const DB_STORE = 'kv';
  const DB_KEY = 'doc';
  const LS_KEY = 'shader-lab:doc';
  const MAX_EDGE = 4096;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      req.onblocked = function () { reject(new Error('indexedDB blocked')); };
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readonly');
        const rq = tx.objectStore(DB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  function idbSet(key, val) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('aborted')); };
      });
    });
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ------------------------------ 默认文档 ------------------------------ */
  function defaultState() {
    // 没有「整条效果的预设」了：默认就是一条最朴素的起步管线
    const doc = SL.passes.defaultDoc();
    return {
      v: 1,
      presetId: '',
      custom: false,
      source: doc.source || SL.assetDefaults.testcard,
      output: { w: doc.output.w, h: doc.output.h },
      resMode: 'fit',
      effectId: null,
      alpha: false,
      duration: 0,
      loop: true,
      previewBg: 'checker',
      passes: doc.passes,
      selectedPassId: doc.passes[0] ? doc.passes[0].id : null,
      assets: [],
      ui: {
        playing: true,
        speed: 1,
        zoom: 1,
        tab: 'uniforms',
        leftW: null,
        rightW: null,
        editorH: null,
        editorFont: 12.5
      }
    };
  }

  /** 效果库里有哪些 id（index.js 由 tools/lib.mjs 生成，缺失时视作空库） */
  function effectIds() {
    const list = (window.SL_EFFECTS && window.SL_EFFECTS.effects) || [];
    return list.map(function (e) { return e.id; });
  }

  /** presetId 只认 'effect:<id>'（内置预设已移除） */
  function knownPreset(id) {
    if (typeof id !== 'string') return false;
    return id.indexOf('effect:') === 0 && effectIds().indexOf(id.slice(7)) >= 0;
  }

  /* ------------------------------ 规范化 ------------------------------ */
  function clampInt(v, def, min, max) {
    if (v === null || v === undefined || v === '') return def;
    const n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  const PASS_DEFAULTS = {
    format: 'rgba8', scale: 1, filter: 'linear', wrap: 'clamp'
  };

  /** 把任意来源的文档修成可用的形状；非法数据尽量修复而不是整份丢弃 */
  function normalize(input, opts) {
    opts = opts || {};
    const out = {};
    const base = defaultState();
    const src = input && typeof input === 'object' ? input : {};

    out.v = 1;
    const idOk = typeof src.effectId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(src.effectId);
    const isDraft = idOk && src.presetId === ('effect:' + src.effectId) &&
      (opts.allowNewEffect || (typeof src.effectName === 'string' && !!src.effectName.trim()));
    out.presetId = isDraft ? src.presetId : (knownPreset(src.presetId) ? src.presetId : base.presetId);
    out.effectId = out.presetId.indexOf('effect:') === 0 ? out.presetId.slice(7) : null;
    out.effectBuiltAt = out.effectId && typeof src.effectBuiltAt === 'string' ? src.effectBuiltAt : null;
    out.effectName = typeof src.effectName === 'string' ? src.effectName.slice(0, 60) : null;
    out.effectTags = Array.isArray(src.effectTags)
      ? src.effectTags.filter(function (t) { return typeof t === 'string' && t.trim(); }).map(function (t) { return t.trim().slice(0, 16); }).slice(0, 8)
      : [];
    out.custom = !!src.custom;

    out.source = typeof src.source === 'string' ? src.source : base.source;

    out.alpha = !!src.alpha;
    out.duration = (function () {
      const d = Number(src.duration);
      return isFinite(d) && d > 0 ? Math.min(3600, d) : 0;
    })();
    out.loop = src.loop !== false;
    out.previewBg = ['checker', 'dark', 'light', 'source'].indexOf(src.previewBg) >= 0 ? src.previewBg : 'checker';

    const w = clampInt(src.output && src.output.w, base.output.w, 16, MAX_EDGE);
    const h = clampInt(src.output && src.output.h, base.output.h, 16, MAX_EDGE);
    out.output = { w: w, h: h };
    out.resMode = src.resMode === 'custom' ? 'custom' : 'fit';

    /* Pass 列表 */
    let passes = [];
    if (Array.isArray(src.passes)) {
      const seen = {};
      src.passes.forEach(function (raw, i) {
        if (!raw || typeof raw !== 'object') return;
        if (typeof raw.code !== 'string') return;
        let id = typeof raw.id === 'string' && raw.id ? raw.id : ('p' + (i + 1));
        while (seen[id]) id = id + '_';
        seen[id] = 1;
        const p = {
          id: id,
          name: typeof raw.name === 'string' && raw.name ? raw.name : ('Pass ' + (i + 1)),
          code: raw.code,
          enabled: raw.enabled !== false,
          // 中间态（生成类）不参与主链，只供其他 Pass 采样
          role: raw.role === 'source' ? 'source' : 'filter',
          format: raw.format === 'hdr' ? 'hdr' : PASS_DEFAULTS.format,
          scale: (function () {
            const s = Number(raw.scale);
            if (!isFinite(s) || s <= 0) return 1;
            return Math.min(4, Math.max(0.05, s));
          })(),
          filter: raw.filter === 'nearest' ? 'nearest' : PASS_DEFAULTS.filter,
          wrap: (raw.wrap === 'repeat' || raw.wrap === 'mirror') ? raw.wrap : PASS_DEFAULTS.wrap,
          bindings: {},
          values: {}
        };
        if (raw.bindings && typeof raw.bindings === 'object') {
          Object.keys(raw.bindings).forEach(function (k) {
            const b = raw.bindings[k];
            if (!b || typeof b !== 'object') return;
            const kind = ['prev', 'self', 'asset', 'pass', 'none'].indexOf(b.kind) >= 0 ? b.kind : 'prev';
            // 只保留与该 kind 相关的字段：老文档里 common 会留下「kind=prev 却带 passId」，
            // 光看数据判断不出这一行到底采样什么，UI 也会显示互相矛盾的选项
            const nb = { kind: kind };
            if (kind === 'asset') {
              if (typeof b.assetId === 'string') nb.assetId = b.assetId;
            } else if (kind === 'pass') {
              if (typeof b.passId === 'string') nb.passId = b.passId;
            }
            p.bindings[k] = nb;
          });
        }
        if (raw.values && typeof raw.values === 'object') {
          Object.keys(raw.values).forEach(function (k) {
            const v = raw.values[k];
            if (Array.isArray(v)) {
              p.values[k] = v.map(function (x) { const n = Number(x); return isFinite(n) ? n : 0; });
            } else if (typeof v === 'number') {
              p.values[k] = [v];
            }
          });
        }
        passes.push(p);
      });
    }
    if (!passes.length && !opts.allowEmpty) {
      const fb = SL.passes.defaultDoc();
      passes = fb.passes;
      out.source = fb.source || base.source;
      out.output = { w: fb.output.w, h: fb.output.h };
    }
    out.passes = passes;

    const ids = passes.map(function (p) { return p.id; });
    out.selectedPassId = ids.indexOf(src.selectedPassId) >= 0 ? src.selectedPassId : (ids[0] || null);

    /* 用户资源 */
    out.assets = [];
    if (Array.isArray(src.assets)) {
      src.assets.forEach(function (a) {
        if (!a || typeof a !== 'object') return;
        if (!a.id || !a.dataURL) return;
        out.assets.push({
          id: String(a.id),
          name: String(a.name || '贴图'),
          kind: 'file',
          dataURL: String(a.dataURL),
          width: clampInt(a.width, 1, 1, MAX_EDGE),
          height: clampInt(a.height, 1, 1, MAX_EDGE),
          params: {
            filter: a.params && a.params.filter === 'nearest' ? 'nearest' : 'linear',
            wrap: a.params && a.params.wrap === 'repeat' ? 'repeat' : 'clamp'
          }
        });
      });
    }

    /* 关键帧轨道：只保留指向现存 Pass 的、结构合法的时间序列 */
    out.timeline = {};
    if (src.timeline && typeof src.timeline === 'object') {
      Object.keys(src.timeline).forEach(function (pid) {
        if (ids.indexOf(pid) < 0) return;
        const lanes = src.timeline[pid];
        if (!lanes || typeof lanes !== 'object') return;
        const clean = {};
        Object.keys(lanes).forEach(function (name) {
          const keys = lanes[name];
          if (!Array.isArray(keys)) return;
          const outKeys = [];
          keys.forEach(function (k) {
            if (!k || typeof k !== 'object') return;
            const t = Number(k.t);
            if (!isFinite(t) || t < 0) return;
            const v = Array.isArray(k.v) ? k.v.map(Number) : [Number(k.v)];
            if (!v.length || v.some(function (x) { return !isFinite(x); })) return;
            const e = ['linear', 'in', 'out', 'inout', 'step'].indexOf(k.e) >= 0 ? k.e : 'linear';
            outKeys.push({ t: t, v: v, e: e });
          });
          outKeys.sort(function (a, b) { return a.t - b.t; });
          if (outKeys.length) clean[name] = outKeys;
        });
        if (Object.keys(clean).length) out.timeline[pid] = clean;
      });
    }

    /* UI 状态 */
    const ui = src.ui && typeof src.ui === 'object' ? src.ui : {};
    out.ui = {
      playing: ui.playing !== false,
      speed: (function () { const s = Number(ui.speed); return isFinite(s) && s > 0 ? Math.min(8, s) : 1; })(),
      zoom: (function () { const z = Number(ui.zoom); return isFinite(z) && z > 0 ? Math.min(8, z) : 1; })(),
      tab: ['uniforms', 'textures', 'info'].indexOf(ui.tab) >= 0 ? ui.tab : 'uniforms',
      leftW: clampInt(ui.leftW, null, 180, 520),
      rightW: clampInt(ui.rightW, null, 240, 620),
      editorH: clampInt(ui.editorH, null, 0, 900),
      editorFont: (function () {
        const f = Number(ui.editorFont);
        return isFinite(f) ? Math.min(22, Math.max(10, Math.round(f * 2) / 2)) : 12.5;
      })()
    };

    return out;
  }

  /* ------------------------------ 读写 ------------------------------ */
  function load() {
    // 有本地服务时以 project.json 为准（它才是仓库里能看到的那份）
    const fromServer = (SL.server && SL.server.on)
      ? SL.server.getDoc().then(function (doc) { return doc ? normalize(doc) : null; }).catch(function () { return null; })
      : Promise.resolve(null);
    return fromServer.then(function (doc) {
      if (doc) return doc;
      return idbGet(DB_KEY).then(function (idbDoc) {
        if (idbDoc) return normalize(idbDoc);
        return loadLS();
      }).catch(function () {
        return loadLS();
      });
    });
  }

  function loadLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  let saveChain = Promise.resolve();

  function save(state) {
    const doc = JSON.parse(JSON.stringify(state));
    // 串行化写入，避免快速连续保存时的事务竞争
    saveChain = saveChain.then(function () {
      return idbSet(DB_KEY, doc).catch(function (err) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(doc));
          return 'ls';
        } catch (e2) {
          throw err;
        }
      });
    }).then(function (where) {
      // 有本地服务时再写一份到 project.json（可见、可提交、能 review）
      if (SL.server && SL.server.on) {
        SL.server.putDoc(doc).catch(function (err) {
          if (SL.ui && SL.ui.toast && SL.__lastDocError !== String(err && err.message)) {
            SL.__lastDocError = String(err && err.message);
            SL.ui.toast('写不进 project.json：' + (err && err.message ? err.message : err), 'warn');
          }
        });
      }
      return where;
    }).catch(function (err) {
      if (SL.__lastSaveError !== String(err && err.message)) {
        SL.__lastSaveError = String(err && err.message);
        if (SL.ui && SL.ui.toast) {
          SL.ui.toast('自动保存失败：' + (err && err.message ? err.message : err) + '（存储空间可能已满）', 'bad');
        }
      }
    });
    return saveChain;
  }

  function clear() {
    return idbDel(DB_KEY).then(function () {
      try { localStorage.removeItem(LS_KEY); } catch (_) { }
      return true;
    }).catch(function () { return false; });
  }

  /* ------------------------------ 导入导出 ------------------------------ */
  function exportDoc(state) {
    const doc = {
      app: 'shader-lab',
      v: 1,
      savedAt: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(state))
    };
    SL.io.download('shader-lab-' + timestamp() + '.json', JSON.stringify(doc, null, 2), 'application/json');
  }

  function timestamp() {
    const d = new Date();
    return d.getFullYear() + SL.pad2(d.getMonth() + 1) + SL.pad2(d.getDate()) + '-' +
      SL.pad2(d.getHours()) + SL.pad2(d.getMinutes());
  }

  /** 读取 .json 文件 → 规范化后的文档 */
  function importDoc(file) {
    return SL.io.readTextFile(file).then(function (text) {
      let data;
      try { data = JSON.parse(text); } catch (e) {
        throw new Error('不是合法的 JSON 文件');
      }
      const payload = data && data.state ? data.state : data;
      if (!payload || (!payload.passes && !payload.presetId)) {
        throw new Error('文件里没有可识别的管线数据');
      }
      return normalize(payload);
    });
  }

  SL.store = {
    MAX_EDGE: MAX_EDGE,
    defaultState: defaultState,
    normalize: normalize,
    load: load,
    save: save,
    clear: clear,
    exportDoc: exportDoc,
    importDoc: importDoc
  };
})(window.SL);
