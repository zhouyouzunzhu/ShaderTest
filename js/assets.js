/* ==========================================================================
   assets.js — 纹理资源：内置程序化图 + 用户图片
   --------------------------------------------------------------------------
   · 内置 5 张程序化贴图（测试卡 / 棋盘 / 噪声 / 渐变 / 圆形衰减）
   · 用户图片：拖拽、选择文件、粘贴，统一转成 dataURL 方便存工程
   · 惰性上传到 GPU；参数（过滤 / 平铺）修改后就地生效
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  const SIZE = 512;
  const MAX_IMPORT = 2048;   // 导入图片的最大边长（超过会等比缩放）

  /* ------------------------------ 程序化贴图 ------------------------------ */
  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function drawTestcard() {
    const S = SIZE;
    const c = newCanvas(S, S), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);

    // 上半：8 条彩条
    const bars = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#101010'];
    const bw = S / bars.length;
    bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw, 0, Math.ceil(bw), S * 0.4); });

    // 中上：灰阶阶梯
    const steps = 16, sw = S / steps;
    for (let i = 0; i < steps; i++) {
      const v = Math.round((i / (steps - 1)) * 255);
      g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      g.fillRect(i * sw, S * 0.4, Math.ceil(sw), S * 0.12);
    }

    // 中下：色相渐变
    const grad = g.createLinearGradient(0, 0, S, 0);
    for (let i = 0; i <= 12; i++) {
      const rgb = SL.hsvToRgb(i / 12, 0.85, 1);
      grad.addColorStop(i / 12, 'rgb(' + rgb.map((v) => Math.round(v * 255)).join(',') + ')');
    }
    g.fillStyle = grad;
    g.fillRect(0, S * 0.52, S, S * 0.1);

    // 下：网格 + 圆
    g.fillStyle = '#0a0d13';
    g.fillRect(0, S * 0.62, S, S * 0.38);
    g.strokeStyle = 'rgba(124,156,255,.55)';
    g.lineWidth = 1;
    for (let x = 0; x <= S; x += 32) {
      g.beginPath(); g.moveTo(x + 0.5, S * 0.62); g.lineTo(x + 0.5, S); g.stroke();
    }
    for (let y = S * 0.62; y <= S; y += 32) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(S, y + 0.5); g.stroke();
    }
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    const cx = S / 2, cy = S * 0.81;
    [30, 62, 96].forEach((r) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); });
    g.beginPath();
    g.moveTo(cx - 10, cy); g.lineTo(cx + 10, cy);
    g.moveTo(cx, cy - 10); g.lineTo(cx, cy + 10);
    g.stroke();

    // 四角标记 + 边框
    g.strokeStyle = '#ff4d6a';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, S - 3, S - 3);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.font = '600 22px Inter, sans-serif';
    g.fillText('ShaderLab', 16, S * 0.6 - 12);
    g.font = '12px monospace';
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillText('vUv 0,0  →  1,1', 16, S * 0.62 + 24);
    return c;
  }

  function drawChecker() {
    const S = SIZE, c = newCanvas(S, S), g = c.getContext('2d');
    const cell = 32;
    for (let y = 0; y < S / cell; y++) {
      for (let x = 0; x < S / cell; x++) {
        g.fillStyle = (x + y) % 2 ? '#e9eef9' : '#1a2130';
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    g.strokeStyle = 'rgba(46,230,197,.8)';
    g.lineWidth = 4;
    g.strokeRect(2, 2, S - 4, S - 4);
    return c;
  }

  function hash2(x, y, seed) {
    let h = x * 374761393 + y * 668265263 + seed * 144665;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  function valueNoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const cc = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return SL.lerp(SL.lerp(a, b, u), SL.lerp(cc, d, u), v);
  }

  function drawNoise() {
    const S = SIZE, c = newCanvas(S, S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0, amp = 0.5, f = 4 / S;
        for (let o = 0; o < 5; o++) {
          v += amp * valueNoise(x * f, y * f, o + 1);
          amp *= 0.5; f *= 2.03;
        }
        const n = Math.round(SL.clamp(v * 1.35, 0, 1) * 255);
        const i = (y * S + x) * 4;
        img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function drawGradient() {
    const S = SIZE, c = newCanvas(S, S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const rgb = SL.hsvToRgb((u * 0.8 + v * 0.2) % 1, 0.75, 1);
        const i = (y * S + x) * 4;
        img.data[i] = rgb[0] * 255;
        img.data[i + 1] = rgb[1] * 255;
        img.data[i + 2] = rgb[2] * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function drawCircle() {
    const S = SIZE, c = newCanvas(S, S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S - 0.5, v = y / S - 0.5;
        const d = Math.sqrt(u * u + v * v) * 2;
        const a = SL.clamp(1 - d, 0, 1);
        const soft = a * a * (3 - 2 * a);
        const i = (y * S + x) * 4;
        const val = Math.round(soft * 255);
        img.data[i] = val; img.data[i + 1] = val; img.data[i + 2] = val; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** 带透明通道的道具图：菱形主体 + 内圈亮环，用来验证 alpha 合成与描边 */
  function drawSprite() {
    const S = SIZE, c = newCanvas(S, S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1;
        const d = Math.abs(u) + Math.abs(v);                        // 菱形距离场（|u|+|v| = 常数 的等值线是菱形）
        const body = SL.clamp((0.68 - d) / 0.02, 0, 1);             // 主体：留在画面内，四周留白
        const ring = Math.exp(-Math.pow((d - 0.52) / 0.02, 2));     // 内圈亮环
        const core = SL.clamp(1 - d / 0.5, 0, 1);
        const i = (y * S + x) * 4;
        const k = Math.min(1, core * 0.5 + ring * 0.9);
        img.data[i] = Math.round(255 * k);
        img.data[i + 1] = Math.round(232 * k);
        img.data[i + 2] = Math.round(196 * k);
        img.data[i + 3] = Math.round(255 * body);
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  const BUILTINS = [
    { id: 'testcard', name: '测试卡', draw: drawTestcard, note: '色条 / 灰阶 / 网格' },
    { id: 'checker', name: '棋盘', draw: drawChecker, note: '32px 方格' },
    { id: 'noise', name: '分形噪声', draw: drawNoise, note: '5 层 value noise' },
    { id: 'gradient', name: '色相渐变', draw: drawGradient, note: '斜向色相' },
    { id: 'circle', name: '圆形衰减', draw: drawCircle, note: '中心亮，边缘黑' },
    { id: 'sprite', name: '徽记（透明底）', draw: drawSprite, note: '菱形 / 软边 / 带 alpha' }
  ];

  const builtinCache = {};

  /* ------------------------------ 资源仓库 ------------------------------ */
  class AssetStore {
    constructor(gl) {
      this.gl = gl || null;
      this.items = [];
      this.textures = new Map(); // entryId → {tex,w,h,filter,wrap}
      this.thumbs = new Map();
    }

    setGl(gl) { this.gl = gl; }

    /** 创建内置资源条目（不重复） */
    ensureBuiltins() {
      BUILTINS.forEach((b) => {
        const id = 'b:' + b.id;
        if (this.items.some((i) => i.id === id)) return;
        this.items.push({
          id: id, name: b.name, kind: 'builtin', builtin: b.id,
          width: SIZE, height: SIZE, note: b.note,
          params: { filter: 'linear', wrap: 'clamp' }
        });
      });
    }

    /**
     * 公共图库（library/index.js）：条目 id 稳定为 lib:<文件名>，图片异步解码，
     * 因此解码完要把 version 加一，让下一次 getTexture 重新上传。
     */
    ensureLibrary(onLoaded) {
      const lib = window.SL_LIBRARY;
      if (!lib || !Array.isArray(lib.items)) return;
      lib.items.forEach((item) => {
        const id = 'lib:' + item.id;
        if (this.items.some((i) => i.id === id)) return;
        const entry = {
          id: id,
          name: item.name || item.id,
          kind: 'library',
          libId: item.id,
          image: null,
          width: item.w || 0,
          height: item.h || 0,
          version: 0,
          note: item.file,
          params: { filter: 'linear', wrap: 'clamp' }
        };
        this.items.push(entry);
        const img = new Image();
        img.onload = () => {
          entry.image = img;
          entry.width = img.naturalWidth;
          entry.height = img.naturalHeight;
          entry.version = (entry.version || 0) + 1;
          if (this.thumbs.has(id)) this.thumbs.delete(id);
          if (typeof onLoaded === 'function') onLoaded(entry);
        };
        img.onerror = () => {
          entry.error = true;
        };
        img.src = item.dataURL;
      });
    }

    byId(id) {
      for (let i = 0; i < this.items.length; i++) if (this.items[i].id === id) return this.items[i];
      return null;
    }

    sourceCanvas(entry) {
      if (entry.kind !== 'builtin') return null;
      if (!builtinCache[entry.builtin]) {
        const def = BUILTINS.filter((b) => b.id === entry.builtin)[0];
        builtinCache[entry.builtin] = def ? def.draw() : drawChecker();
      }
      return builtinCache[entry.builtin];
    }

    /** 取得（必要时上传）GPU 纹理 */
    getTexture(entry) {
      if (!entry || !this.gl) return null;
      const cached = this.textures.get(entry.id);
      if (cached && cached.version === (entry.version || 0)) return cached;

      const gl = this.gl;
      const src = entry.kind === 'builtin' ? this.sourceCanvas(entry) : entry.image;
      if (!src) return null;

      let tex = cached ? cached.tex : gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch (e) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        return null;
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      const p = entry.params || {};
      const near = p.filter === 'nearest';
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
      const wm = p.wrap === 'repeat' ? gl.REPEAT : p.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wm);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wm);

      const natW = entry.kind === 'builtin' ? src.width : (src.naturalWidth || src.width);
      const natH = entry.kind === 'builtin' ? src.height : (src.naturalHeight || src.height);
      const rec = { tex: tex, w: natW, h: natH, version: entry.version || 0, filter: p.filter, wrap: p.wrap };
      this.textures.set(entry.id, rec);
      return rec;
    }

    /** 参数变更后仅重设纹理参数，不重新上传 */
    refreshParams(entry) {
      const rec = this.textures.get(entry.id);
      if (!rec || !this.gl) return;
      const gl = this.gl;
      const p = entry.params || {};
      const near = p.filter === 'nearest';
      gl.bindTexture(gl.TEXTURE_2D, rec.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
      const wm = p.wrap === 'repeat' ? gl.REPEAT : p.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wm);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wm);
    }

    /** 缩略图（dataURL），用于右栏与左栏 */
    thumb(entry) {
      if (!entry) return '';
      if (this.thumbs.has(entry.id)) return this.thumbs.get(entry.id);
      const src = entry.kind === 'builtin' ? this.sourceCanvas(entry) : entry.image;
      if (!src) return '';
      const W = 96, H = 64;
      const c = newCanvas(W, H), g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      const sw = entry.kind === 'builtin' ? src.width : (src.naturalWidth || src.width);
      const sh = entry.kind === 'builtin' ? src.height : (src.naturalHeight || src.height);
      const scale = Math.max(W / sw, H / sh);
      const dw = sw * scale, dh = sh * scale;
      try {
        g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } catch (e) {
        g.fillStyle = '#222'; g.fillRect(0, 0, W, H);
      }
      const url = c.toDataURL('image/jpeg', 0.72);
      this.thumbs.set(entry.id, url);
      return url;
    }

    /** 导入一个图片文件 */
    importFile(file) {
      const self = this;
      return new Promise(function (resolve, reject) {
        if (!file || !/^image\//.test(file.type)) {
          reject(new Error('不是图片文件'));
          return;
        }
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('读取失败'));
        fr.onload = function () {
          self.importDataURL(file.name || 'image', String(fr.result)).then(resolve, reject);
        };
        fr.readAsDataURL(file);
      });
    }

    /** 用 dataURL 导入（工程恢复 / 粘贴也用这条） */
    importDataURL(name, url) {
      const self = this;
      return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () {
          const w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, MAX_IMPORT / Math.max(w, h));
          const entry = {
            id: 'a:' + SL.uid('t'),
            name: String(name || 'image').replace(/\.[a-z0-9]+$/i, ''),
            kind: 'file',
            image: img,
            dataURL: url,
            width: Math.round(w * scale),
            height: Math.round(h * scale),
            srcWidth: w,
            srcHeight: h,
            params: { filter: 'linear', wrap: 'clamp' }
          };
          if (scale < 1) {
            // 大图缩放到 MAX_IMPORT 内，避免显存和工程体积爆掉
            const c = newCanvas(entry.width, entry.height);
            c.getContext('2d').drawImage(img, 0, 0, entry.width, entry.height);
            const small = new Image();
            small.onload = function () {
              entry.image = small;
              entry.dataURL = c.toDataURL('image/png');
              self.items.push(entry);
              resolve(entry);
            };
            small.src = c.toDataURL('image/png');
          } else {
            self.items.push(entry);
            resolve(entry);
          }
        };
        img.onerror = function () { reject(new Error('图片解码失败')); };
        img.src = url;
      });
    }

    remove(id) {
      const gl = this.gl;
      const rec = this.textures.get(id);
      if (rec && gl) gl.deleteTexture(rec.tex);
      this.textures.delete(id);
      this.thumbs.delete(id);
      this.items = this.items.filter((i) => i.id !== id);
    }

    /** 供渲染使用：id → {tex,w,h} */
    textureMap() {
      const map = {};
      this.items.forEach((e) => {
        const t = this.getTexture(e);
        if (t) map[e.id] = t;
      });
      return map;
    }

    dispose() {
      const gl = this.gl;
      this.textures.forEach((rec) => { if (gl) gl.deleteTexture(rec.tex); });
      this.textures.clear();
    }
  }

  SL.AssetStore = AssetStore;
  SL.ASSET_BUILTINS = BUILTINS;
  SL.assetDefaults = {
    testcard: 'b:testcard',
    noise: 'b:noise',
    gradient: 'b:gradient',
    checker: 'b:checker',
    circle: 'b:circle'
  };
})(window.SL);
