/* ==========================================================================
   engine.js — WebGL2 多 Pass 后处理引擎
   --------------------------------------------------------------------------
   · 全屏三角形 + 片元着色器，每个 Pass 渲染到自己的 FBO
   · 自采样（反馈）通过 ping-pong 双缓冲实现
   · 支持 RGBA8 / RGBA16F（HDR，需要 EXT_color_buffer_float）
   · 程序按源码字符串缓存，实时重编译不闪屏（编译失败保留上一帧输出）
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  const VS_SRC = [
    '#version 300 es',
    'precision highp float;',
    'out vec2 vUv;',
    'void main(){',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  vUv = p;',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  const BLIT_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'uniform sampler2D u_tex;',
    'out vec4 oColor;',
    'void main(){',
    '  vec4 c = texture(u_tex, vUv);',
    '  oColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0));',
    '}'
  ].join('\n');

  /* --------------------------- 自动 uniform 求值 --------------------------- */
  function autoValue(name, ctx) {
    switch (name) {
      case 'u_time': case 'iTime': return [ctx.time];
      case 'u_delta': case 'iTimeDelta': return [ctx.delta];
      case 'u_frame': return [ctx.frame];
      case 'iFrame': return [ctx.frame | 0];
      case 'u_resolution': return [ctx.w, ctx.h];
      case 'iResolution': return [ctx.w, ctx.h, 1];
      case 'u_texel': return [1 / ctx.w, 1 / ctx.h];
      case 'u_aspect': return [ctx.w / Math.max(1, ctx.h)];
      case 'u_mouse': return [ctx.mouse[0], ctx.mouse[1], ctx.mouse[2], ctx.mouse[3]];
      case 'iMouse': return [ctx.mouse[0], ctx.mouse[1], ctx.mouse[2], ctx.mouse[3]];
      case 'u_date': case 'iDate': return [ctx.date[0], ctx.date[1], ctx.date[2], ctx.date[3]];
      case 'iSampleRate': return [ctx.sampleRate || 44100];
      // 一次性效果的时间轴：u_t01 是 0→1 的归一化进度，u_playing 表示是否在播
      case 'u_t01': return [ctx.t01 == null ? 0 : ctx.t01];
      case 'u_progress': return [ctx.t01 == null ? 0 : ctx.t01];
      case 'u_duration': return [ctx.duration == null ? 0 : ctx.duration];
      case 'u_playing': return [ctx.playing ? 1 : 0];
      default: return null;
    }
  }

  const MAX_PROGRAMS = 40;

  class Engine {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = null;
      this.ok = false;
      this.errors = [];
      this.caps = {};
      this.programs = new Map();   // userCode → entry
      this.failCache = new Map();  // userCode → 编译失败记录
      this.targets = new Map();    // passId → rt
      this.frame = 0;
      this.usageClock = 0;
      this.init();
    }

    /* ------------------------------ 初始化 ------------------------------ */
    init() {
      const canvas = this.canvas;
      const attrs = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
        desynchronized: false
      };
      const gl = canvas.getContext('webgl2', attrs);
      if (!gl) {
        this.errors.push('当前浏览器无法创建 WebGL2 上下文。请用 Chrome / Edge / Firefox 的较新版本打开，并确认没有停用硬件加速。');
        return;
      }
      this.gl = gl;

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.caps.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      this.caps.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      this.caps.version = gl.getParameter(gl.VERSION);
      this.caps.shading = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      this.caps.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.caps.maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
      this.caps.hdr = !!gl.getExtension('EXT_color_buffer_float');
      this.caps.floatLinear = !!gl.getExtension('OES_texture_float_linear');
      this.caps.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);

      // GPU 计时（Chrome 支持；不支持时退回 CPU 提交耗时）
      // 逐 Pass 各发一个查询，既拿到总数也能看到每个 Pass 的开销
      this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.passQueries = [];
      this.passMs = {};
      this.gpuMs = 0;
      this.gpuMeasured = false;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DITHER);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      this.vs = this.compileShader(gl.VERTEX_SHADER, VS_SRC);
      if (!this.vs.ok) {
        this.errors.push('内置顶点着色器编译失败：' + this.vs.log);
        return;
      }
      const blit = this.buildProgram(this.vs.shader, BLIT_FS);
      if (!blit.ok) {
        this.errors.push('内置合成着色器编译失败：' + blit.log);
        return;
      }
      this.blitProg = blit.program;
      this.blitTexLoc = gl.getUniformLocation(blit.program, 'u_tex');

      // 1×1 黑色兜底纹理
      this.blackTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.blackTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.vao = gl.createVertexArray();
      this.ok = true;
    }

    compileShader(type, src) {
      const gl = this.gl;
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) || '(无编译日志)';
        gl.deleteShader(s);
        return { ok: false, log: log };
      }
      return { ok: true, shader: s };
    }

    buildProgram(vs, fsSrc) {
      const gl = this.gl;
      const f = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
      if (!f.ok) return { ok: false, log: f.log };
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, f.shader);
      gl.linkProgram(prog);
      gl.deleteShader(f.shader);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || '(无链接日志)';
        gl.deleteProgram(prog);
        return { ok: false, log: log };
      }
      return { ok: true, program: prog };
    }

    /** 读取程序里所有 active uniform */
    introspect(program) {
      const gl = this.gl;
      const list = [];
      const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info) continue;
        const base = info.name.replace(/\[0\]$/, '');
        const loc = gl.getUniformLocation(program, info.name);
        if (!loc) continue;
        list.push({ name: base, type: info.type, size: info.size, loc: loc });
      }
      return list;
    }

    /* ---------------------------- 编译 & 缓存 ---------------------------- */
    /**
     * 编译一段用户片元代码（带缓存）。
     * @returns {{ok:boolean, log:string, errors:Array, built:object, program:WebGLProgram|null, uniforms:Array}}
     */
    compile(userCode, opts) {
      const cached = this.programs.get(userCode);
      if (cached) {
        cached.lastUsed = ++this.usageClock;
        const b = cached.built;
        return {
          ok: cached.ok, log: cached.log,
          errors: SL.glsl.parseLog(cached.log, b.headerLines),
          built: b, program: cached.program, uniforms: cached.uniforms
        };
      }
      // 失败也缓存：实时编辑时不会每帧重试同一段坏代码
      const fail = this.failCache.get(userCode);
      if (fail) {
        fail.lastUsed = ++this.usageClock;
        return {
          ok: false, log: fail.log,
          errors: SL.glsl.parseLog(fail.log, fail.built.headerLines),
          built: fail.built, program: null, uniforms: []
        };
      }
      const built = SL.glsl.build(userCode, opts);
      const res = this.buildProgram(this.vs.shader, built.source);
      if (!res.ok) {
        this.failCache.set(userCode, { built: built, log: res.log, lastUsed: ++this.usageClock });
        if (this.failCache.size > 80) {
          const arr = Array.from(this.failCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
          arr.slice(0, arr.length - 80).forEach(([k]) => this.failCache.delete(k));
        }
        return {
          ok: false, log: res.log,
          errors: SL.glsl.parseLog(res.log, built.headerLines),
          built: built, program: null, uniforms: []
        };
      }
      const entry = {
        built: built,
        ok: true,
        log: '',
        program: res.program,
        uniforms: this.introspect(res.program),
        lastUsed: ++this.usageClock
      };
      this.programs.set(userCode, entry);
      this.evictPrograms();
      return {
        ok: entry.ok, log: entry.log,
        errors: [],
        built: built, program: entry.program, uniforms: entry.uniforms
      };
    }

    evictPrograms() {
      const gl = this.gl;
      if (this.programs.size <= MAX_PROGRAMS) return;
      const arr = Array.from(this.programs.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const drop = arr.slice(0, arr.length - MAX_PROGRAMS);
      drop.forEach(([k, e]) => {
        if (e.program) gl.deleteProgram(e.program);
        this.programs.delete(k);
      });
    }

    /* ---------------------------- 渲染目标 ---------------------------- */
    createTarget(w, h, format, filter, wrap) {
      const gl = this.gl;
      const hdr = format === 'hdr' && this.caps.hdr;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (hdr) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      const wm = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wm);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wm);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        return null;
      }
      return { tex: tex, fbo: fbo, w: w, h: h, format: hdr ? 'hdr' : 'rgba8' };
    }

    getTarget(passId, w, h, format, filter, wrap) {
      let rt = this.targets.get(passId);
      const fmt = format === 'hdr' && this.caps.hdr ? 'hdr' : 'rgba8';
      if (rt && rt.w === w && rt.h === h && rt.format === fmt) {
        // 参数变化（过滤/平铺）就地更新即可
        if (rt.filter !== filter || rt.wrap !== wrap) {
          this.applyTexParams(rt.a.tex, filter, wrap);
          this.applyTexParams(rt.b.tex, filter, wrap);
          rt.filter = filter;
          rt.wrap = wrap;
        }
        return rt;
      }
      if (rt) this.disposeTarget(rt);
      const a = this.createTarget(w, h, fmt, filter, wrap);
      const b = this.createTarget(w, h, fmt, filter, wrap);
      if (!a || !b) {
        if (a) this.disposeTarget({ a: a, b: a });
        return null;
      }
      rt = { a: a, b: b, cur: 'a', w: w, h: h, format: fmt, filter: filter, wrap: wrap };
      this.targets.set(passId, rt);
      return rt;
    }

    applyTexParams(tex, filter, wrap) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      const wm = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wm);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wm);
    }

    disposeTarget(rt) {
      const gl = this.gl;
      ['a', 'b'].forEach((k) => {
        if (!rt[k]) return;
        gl.deleteFramebuffer(rt[k].fbo);
        gl.deleteTexture(rt[k].tex);
      });
    }

    pruneTargets(aliveIds) {
      const keep = {};
      aliveIds.forEach((id) => (keep[id] = 1));
      this.targets.forEach((rt, id) => {
        if (!keep[id]) {
          this.disposeTarget(rt);
          this.targets.delete(id);
        }
      });
    }

    /* ------------------------------ 设置 uniform ------------------------------ */
    setByType(loc, type, v) {
      const gl = this.gl;
      const a = Array.isArray(v) ? v : [v];
      switch (type) {
        case gl.FLOAT: gl.uniform1f(loc, a[0] || 0); break;
        case gl.FLOAT_VEC2: gl.uniform2f(loc, a[0] || 0, a[1] || 0); break;
        case gl.FLOAT_VEC3: gl.uniform3f(loc, a[0] || 0, a[1] || 0, a[2] || 0); break;
        case gl.FLOAT_VEC4: gl.uniform4f(loc, a[0] || 0, a[1] || 0, a[2] || 0, a[3] || 0); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(loc, a[0] || 0); break;
        case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2i(loc, a[0] | 0, a[1] | 0); break;
        case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3i(loc, a[0] | 0, a[1] | 0, a[2] | 0); break;
        case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4i(loc, a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(loc, a[0] >>> 0); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, a.slice(0, 4)); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, a.slice(0, 9)); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, a.slice(0, 16)); break;
        default: break;
      }
    }

    /**
     * @param entry 程序缓存项
     * @param ctx   {time,delta,frame,w,h,mouse,date,values,samplers,fallback}
     *              samplers: name → {tex,w,h}
     */
    applyUniforms(entry, ctx) {
      const gl = this.gl;
      let unit = 0;
      const list = entry.uniforms;
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        const name = rec.name;
        if (rec.type === gl.SAMPLER_2D || rec.type === gl.SAMPLER_CUBE ||
            rec.type === gl.SAMPLER_3D || rec.type === gl.SAMPLER_2D_ARRAY) {
          const sinfo = (ctx.samplers && ctx.samplers[name]) || null;
          const tex = sinfo && sinfo.tex ? sinfo.tex : ctx.fallback;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(rec.loc, unit);
          unit++;
          continue;
        }
        // 采样器尺寸联动：u_tex → u_texSize / u_texTexel
        if (/Size$/.test(name)) {
          const base = name.slice(0, -4);
          const si = ctx.samplers && ctx.samplers[base];
          if (si) { this.setByType(rec.loc, rec.type, [si.w, si.h]); continue; }
        }
        if (/Texel$/.test(name)) {
          const base = name.slice(0, -5);
          const si = ctx.samplers && ctx.samplers[base];
          if (si) { this.setByType(rec.loc, rec.type, [1 / si.w, 1 / si.h]); continue; }
        }
        const auto = autoValue(name, ctx);
        if (auto) { this.setByType(rec.loc, rec.type, auto); continue; }
        const v = ctx.values ? ctx.values[name] : null;
        if (v != null) this.setByType(rec.loc, rec.type, v);
      }
    }

    /* -------------------------------- 渲染 -------------------------------- */
    /**
     * @param {object} state 管线状态（见 store.js 的默认结构）
     * @param {object} env   {source: {tex,w,h}, assets: {id: {tex,w,h}}, textures: fn}
     * @returns {{ms:number, drawn:number, skipped:number, finalTex:object|null}}
     */
    render(state, env) {
      const gl = this.gl;
      if (!this.ok) return { ms: 0, drawn: 0, skipped: 0, finalTex: null };
      this.pollGpuTimer();
      const t0 = performance.now();
      const W = Math.max(1, state.output.w | 0);
      const H = Math.max(1, state.output.h | 0);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      this.frame++;

      // 输出带 alpha 的效果时，清屏 alpha 用 0，让画布透明处能透出预览背景
      const clearA = state.clearAlpha == null ? 1 : state.clearAlpha;

      // 对比模式：跳过整条管线，直接把原始输入贴到画布，
      // 用来一眼判断「算法到底改了什么」。
      if (state.compare) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, clearA);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (env.source) {
          gl.useProgram(this.blitProg);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, env.source.tex);
          gl.uniform1i(this.blitTexLoc, 0);
          gl.bindVertexArray(this.vao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindVertexArray(null);
        }
        const cms = performance.now() - t0;
        return { ms: cms, gpu: false, cpuMs: cms, drawn: 0, skipped: 0, finalTex: null, compare: true };
      }

      const passes = state.passes.filter((p) => p.enabled);

      // 已删除的 Pass 不再保留计时样本
      for (const id in this.passMs) {
        if (!state.passes.some((p) => p.id === id)) delete this.passMs[id];
      }
      this.pruneTargets(state.passes.map((p) => p.id));
      const outputs = {}; // passId → {tex,w,h}
      let prevOut = env.source || null;
      let drawn = 0, skipped = 0;
      let lastOut = null;

      for (let i = 0; i < passes.length; i++) {
        const p = passes[i];
        const pw = Math.max(1, Math.round(W * (p.scale == null ? 1 : p.scale)));
        const ph = Math.max(1, Math.round(H * (p.scale == null ? 1 : p.scale)));
        const entry = this.compile(p.code, { isFirst: i === 0 });
        if (!entry.ok) { skipped++; if (prevOut) lastOut = prevOut; continue; }

        const rt = this.getTarget(p.id, pw, ph, p.format, p.filter, p.wrap);
        if (!rt) { skipped++; if (prevOut) lastOut = prevOut; continue; }

        // —— 解析采样器绑定 ——
        const bindings = p.bindings || {};
        const samplers = {};
        let needsSelf = false;
        Object.keys(bindings).forEach((sname) => {
          const b = bindings[sname];
          if (!b || b.kind === 'none') return;
          if (b.kind === 'self') { needsSelf = true; return; }
          if (b.kind === 'asset') {
            const t = env.assets && env.assets[b.assetId];
            samplers[sname] = t || null;
            return;
          }
          if (b.kind === 'pass') {
            // passId === '__source__' 表示直接取管线原始输入（用于「原图 + 效果」合成）
            const t = b.passId === '__source__' ? env.source : outputs[b.passId];
            if (t) samplers[sname] = t;
            return;
          }
          // prev
          const t = i === 0 ? env.source : outputs[passes[i - 1].id] || env.source;
          if (t) samplers[sname] = t;
        });
        // 兜底：声明了 sampler 但完全没配置绑定 → prev
        entry.uniforms.forEach((u) => {
          if (u.type !== gl.SAMPLER_2D && u.type !== gl.SAMPLER_CUBE) return;
          if (samplers[u.name]) return;
          if (bindings[u.name]) return;
          const t = i === 0 ? env.source : outputs[passes[i - 1].id] || env.source;
          if (t) samplers[u.name] = t;
        });

        // —— 选目标（反馈时 ping-pong，写旧读新） ——
        let dstSlot = rt.cur;
        if (needsSelf) {
          dstSlot = rt.cur === 'a' ? 'b' : 'a';
          samplers.__self__ = { tex: rt[rt.cur].tex, w: rt.w, h: rt.h };
          Object.keys(bindings).forEach((sname) => {
            const b = bindings[sname];
            if (b && b.kind === 'self') samplers[sname] = samplers.__self__;
          });
        }
        const dst = rt[dstSlot];

        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, pw, ph);
        gl.clearColor(0, 0, 0, clearA);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(entry.program);
        gl.bindVertexArray(this.vao);

        let pq = null;
        if (this.timer) {
          pq = gl.createQuery();
          try { gl.beginQuery(this.timer.TIME_ELAPSED_EXT, pq); } catch (e) { pq = null; }
        }

        const date = env.date || [1970, 0, 1, 0];
        const ctx = {
          time: state.time, delta: env.delta || 0, frame: env.frame || 0,
          t01: state.t01, duration: state.duration, playing: state.playing,
          w: pw, h: ph,
          mouse: this.scaleMouse(state.mouse, W, H, pw, ph),
          date: date,
          values: p.values || {},
          samplers: samplers,
          fallback: this.blackTex
        };
        this.applyUniforms(entry, ctx);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        if (pq) {
          try {
            gl.endQuery(this.timer.TIME_ELAPSED_EXT);
            this.passQueries.push({ q: pq, id: p.id });
          } catch (e) { /* 查询被丢弃不影响渲染 */ }
        }

        if (needsSelf) rt.cur = dstSlot;
        const out = { tex: dst.tex, w: pw, h: ph };
        outputs[p.id] = out;
        if (i === passes.length - 1) lastOut = out;
        prevOut = out;
        drawn++;
      }

      // —— 输出到画布 ——
      let finalTex = lastOut;
      if (state.viewPassId) {
        const v = outputs[state.viewPassId];
        if (v) finalTex = v;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, clearA);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (finalTex) {
        gl.useProgram(this.blitProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, finalTex.tex);
        gl.uniform1i(this.blitTexLoc, 0);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
      }
      const cpuMs = performance.now() - t0;

      // 总 GPU 耗时 = 各 Pass 实测之和（最后的 blit 只画一个全屏三角形，忽略不计）
      let sum = 0, measured = 0;
      for (let i = 0; i < passes.length; i++) {
        const v = this.passMs[passes[i].id];
        if (v != null) { sum += v; measured++; }
      }
      if (measured) { this.gpuMs = sum; this.gpuMeasured = true; }
      return {
        ms: measured ? sum : cpuMs,
        gpu: measured > 0,
        cpuMs: cpuMs,
        drawn: drawn, skipped: skipped, finalTex: finalTex,
        passMs: this.passMs
      };
    }

    /** 轮询已完成的 GPU 计时查询，结果异步到达，按 Pass id 归位 */
    pollGpuTimer() {
      const t = this.timer;
      if (!t || !this.passQueries.length) return;
      const gl = this.gl;
      let disjoint = false;
      try { disjoint = !!gl.getParameter(t.GPU_DISJOINT_EXT); } catch (e) { disjoint = false; }
      if (disjoint) {
        // 计时器被别的上下文扰动，这一批样本全部不可信
        while (this.passQueries.length) {
          const it = this.passQueries.shift();
          try { gl.deleteQuery(it.q); } catch (e) { /* 忽略 */ }
        }
        return;
      }
      while (this.passQueries.length) {
        const it = this.passQueries[0];
        let ready = false;
        try { ready = !!gl.getQueryParameter(it.q, gl.QUERY_RESULT_AVAILABLE); } catch (e) { ready = true; }
        if (!ready) break;
        try { this.passMs[it.id] = gl.getQueryParameter(it.q, gl.QUERY_RESULT) / 1e6; } catch (e) { /* 忽略单次失败 */ }
        try { gl.deleteQuery(it.q); } catch (e) { /* 忽略 */ }
        this.passQueries.shift();
      }
      while (this.passQueries.length > 32) {
        const it = this.passQueries.shift();
        try { gl.deleteQuery(it.q); } catch (e) { /* 忽略 */ }
      }
    }

    scaleMouse(mouse, W, H, pw, ph) {
      if (!mouse) return [0, 0, 0, 0];
      const kx = pw / W, ky = ph / H;
      return [mouse[0] * kx, mouse[1] * ky, mouse[2] * kx, mouse[3] * ky];
    }

    /* ------------------------------ 读像素 / 截图 ------------------------------ */
    /** 读取画布像素（x,y 以左上角为原点，单位 CSS 像素对应画布像素） */
    readPixel(x, y) {
      const gl = this.gl;
      if (!this.ok) return null;
      const W = this.canvas.width, H = this.canvas.height;
      x = SL.clamp(Math.floor(x), 0, W - 1);
      y = SL.clamp(Math.floor(y), 0, H - 1);
      const buf = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0] / 255, buf[1] / 255, buf[2] / 255, buf[3] / 255];
    }

    screenshot() {
      const W = this.canvas.width, H = this.canvas.height;
      const gl = this.gl;
      const buf = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        img.data.set(buf.subarray(src, src + W * 4), y * W * 4);
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    }

    /**
     * 用当前管线渲染一张方形缩略图并返回 dataURL。
     * 图库页用它做实时预览：临时把画布尺寸改成 size，读完立刻还原。
     */
    snapshot(state, env, size) {
      if (!this.ok) return null;
      const oldW = this.canvas.width, oldH = this.canvas.height;
      const st = Object.assign({}, state, {
        output: { w: size, h: size },
        viewPassId: null,
        compare: false
      });
      this.render(st, env);
      const W = this.canvas.width, H = this.canvas.height;
      const gl = this.gl;
      const buf = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g2 = c.getContext('2d');
      const img = g2.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        img.data.set(buf.subarray(src, src + W * 4), y * W * 4);
      }
      g2.putImageData(img, 0, 0);
      const url = c.toDataURL('image/png');
      this.canvas.width = oldW; this.canvas.height = oldH;
      return url;
    }
  }

  SL.Engine = Engine;
})(window.SL);
