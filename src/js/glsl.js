/* ==========================================================================
   glsl.js — 源码解析 / 组装 / 高亮 / 报错定位
   --------------------------------------------------------------------------
   用户只写「片元着色器主体」，本模块负责：
   1. 补 #version / precision / vUv / fragColor（不重复声明）
   2. 兼容 GLSL1 写法（varying / texture2D / gl_FragColor）
   3. 自动声明被引用但未声明的内置 uniform（u_time 等）
   4. 识别 Shadertoy 风格 mainImage() 并注入包装
   5. 解析 uniform 声明 + // @range 之类的注解，供右侧面板生成控件
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  /* ------------------------------ 词法表 ------------------------------ */
  const KEYWORDS = ('if else for while do return break continue discard struct ' +
    'uniform in out inout const precision layout switch case default ' +
    'lowp mediump highp invariant centroid flat smooth noperspective ' +
    'true false').split(' ');

  const TYPES = ('void float int uint bool vec2 vec3 vec4 ivec2 ivec3 ivec4 ' +
    'uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 ' +
    'mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 ' +
    'sampler2D samplerCube sampler3D sampler2DArray').split(' ');

  const BUILTINS = ('radians degrees sin cos tan asin acos atan sinh cosh tanh ' +
    'pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ' +
    'ceil fract mod min max clamp mix step smoothstep length distance dot cross ' +
    'normalize faceforward reflect refract matrixCompMult outerProduct transpose ' +
    'determinant inverse lessThan lessThanEqual greaterThan greaterThanEqual ' +
    'equal notEqual any all not texture textureLod textureProj textureGrad ' +
    'textureOffset texelFetch texelFetchOffset textureSize dFdx dFdy fwidth ' +
    'packSnorm2x16 unpackSnorm2x16 packHalf2x16 unpackHalf2x16 ' +
    'floatBitsToInt intBitsToFloat uintBitsToFloat floatBitsToUint ' +
    'isnan isinf').split(' ');

  const SET_KEY = {}; KEYWORDS.forEach((k) => (SET_KEY[k] = 1));
  const SET_TYPE = {}; TYPES.forEach((k) => (SET_TYPE[k] = 1));
  const SET_BUILTIN = {}; BUILTINS.forEach((k) => (SET_BUILTIN[k] = 1));

  /* --------------------------- 内置 uniform --------------------------- */
  /** 引擎每帧自动喂值的 uniform：name → type */
  const AUTO_UNIFORMS = {
    u_time: 'float',
    u_delta: 'float',
    u_frame: 'float',
    u_resolution: 'vec2',
    u_texel: 'vec2',
    u_aspect: 'float',
    u_mouse: 'vec4',
    u_date: 'vec4',
    u_t01: 'float',
    u_duration: 'float',
    u_playing: 'float'
  };

  /** Shadertoy 兼容名 */
  const SHADERTOY_UNIFORMS = {
    iTime: 'float',
    iTimeDelta: 'float',
    iFrame: 'int',
    iResolution: 'vec3',
    iMouse: 'vec4',
    iDate: 'vec4',
    iSampleRate: 'float',
    iChannelTime: 'float[4]',
    iChannelResolution: 'vec3[4]'
  };

  const PRELUDE = [
    '#ifndef PI',
    '#define PI 3.141592653589793',
    '#endif',
    '#ifndef TAU',
    '#define TAU 6.283185307179586',
    '#endif',
    '#ifndef SHADERLAB_COMMON',
    '#define SHADERLAB_COMMON',
    'mat2 sl_rotate(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }',
    'float sl_luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
    'float sl_hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float sl_easeInOut(float t){ return t * t * (3.0 - 2.0 * t); }',
    'float sl_easeOut(float t){ return 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 3.0); }',
    'float sl_easeIn(float t){ return pow(clamp(t, 0.0, 1.0), 3.0); }',
    'float sl_pulse(float t, float peak){ float d = (t - peak) / 0.18; return exp(-d * d); }',
    '#endif'
  ];

  /* ------------------------------ 源码组装 ------------------------------ */
  const RE_VERSION = /^[ \t]*#[ \t]*version\b[^\n]*$/m;
  const RE_HAS_VUV = /\bin\s+(?:(?:highp|mediump|lowp)\s+)?vec2\s+vUv\b/;
  const RE_HAS_FRAGCOLOR = /\bout\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+fragColor\b/;
  const RE_USER_OUT = /^[ \t]*out\s+(?:(?:highp|mediump|lowp)\s+)?vec4\s+([A-Za-z_]\w*)\s*;/gm;

  /** 去掉括号内的内容（函数形参里的 out 不算全局输出声明）。 */
  function stripParens(src) {
    let out = '';
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    return out;
  }

  /** 源码里是否已经手写过 `out vec4 xxx;` 这类全局输出声明。 */
  const hasGlobalOut = (src, name) =>
    new RegExp('\\bout\\s+(?:(?:highp|mediump|lowp)\\s+)?vec4\\s+' + name + '\\b').test(stripParens(src));

  function legacyFix(src) {
    return src
      .replace(/^[ \t]*#[ \t]*extension[ \t]+GL_OES_standard_derivatives[^\n]*$/gm, '// [ShaderLab] 已移除 GLSL1 扩展指令')
      .replace(/^[ \t]*#[ \t]*extension[ \t]+GL_EXT_shader_texture_lod[^\n]*$/gm, '// [ShaderLab] 已移除 GLSL1 扩展指令')
      .replace(/\bvarying\b/g, 'in')
      .replace(/\battribute\b/g, 'in')
      .replace(/\btexture2D\s*\(/g, 'texture(')
      .replace(/\btextureCube\s*\(/g, 'texture(')
      .replace(/\bgl_FragData\s*\[\s*0\s*\]/g, 'fragColor')
      .replace(/\bgl_FragColor\b/g, 'fragColor');
  }

  const RE_DECL = (name) => new RegExp('\\buniform\\s+(?:(?:highp|mediump|lowp)\\s+)?[A-Za-z0-9_]+\\s+' + name + '\\b');

  /**
   * 把用户源码组装成可编译的片元着色器。
   * @param {string} raw 用户在编辑器里写的代码
   * @param {{isFirst?:boolean}} [opts]
   * @returns {{source:string, headerLines:number, shadertoy:boolean, warnings:string[],
   *            autoUsed:string[], outName:string}}
   */
  function build(raw, opts) {
    opts = opts || {};
    const warnings = [];
    let src = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');

    const shadertoy = /\bvoid\s+mainImage\s*\(/.test(src) && !/\bvoid\s+main\s*\(/.test(src);

    // 1) 取出（并清空）用户自己的 #version 行，保持行号不变
    let userVersion = null;
    const lines = src.split('\n');
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const t = lines[i].trim();
      if (!t || t.indexOf('//') === 0 || t.indexOf('/*') === 0) continue;
      if (/^#\s*version\b/.test(t)) {
        userVersion = t;
        lines[i] = '';
        src = lines.join('\n');
      }
      break;
    }
    if (userVersion && !/#version\s+300\s+es/.test(userVersion)) {
      warnings.push('源码里的 ' + userVersion + ' 不受支持，已统一改为 #version 300 es');
    }

    // 2) GLSL1 兼容写法
    src = legacyFix(src);

    // 3) 处理自定义 out vec4 输出变量
    let outName = 'fragColor';
    const outs = [];
    let m;
    RE_USER_OUT.lastIndex = 0;
    while ((m = RE_USER_OUT.exec(src))) outs.push({ name: m[1], index: m.index, full: m[0] });
    if (outs.length === 1 && outs[0].name !== 'fragColor' && !hasGlobalOut(src, 'fragColor')) {
      outName = outs[0].name;
      src = src.slice(0, outs[0].index) +
        'layout(location = 0) out vec4 ' + outs[0].name + ';' +
        src.slice(outs[0].index + outs[0].full.length);
    } else if (outs.length > 1) {
      warnings.push('检测到 ' + outs.length + ' 个 out vec4 输出，仅 location 0 会显示到画布');
    }

    // 4) 组装头部
    const head = [];
    head.push('#version 300 es');
    head.push('precision highp float;');
    head.push('precision highp int;');
    PRELUDE.forEach((l) => head.push(l));

    // 4a) 自动声明被引用但未声明的内置 uniform
    const autoUsed = [];
    const autoNames = Object.keys(AUTO_UNIFORMS);
    const stNames = shadertoy ? Object.keys(SHADERTOY_UNIFORMS) : [];
    autoNames.concat(stNames).forEach(function (name) {
      const re = new RegExp('\\b' + name + '\\b');
      if (!re.test(src)) return;
      if (RE_DECL(name).test(src)) return;
      const type = AUTO_UNIFORMS[name] || SHADERTOY_UNIFORMS[name];
      const arr = /\[(\d+)\]$/.exec(type);
      head.push('uniform ' + type.replace(/\[\d+\]$/, '') + ' ' + name + (arr ? '[' + arr[1] + ']' : '') + ';');
      autoUsed.push(name);
    });
    if (shadertoy) {
      // Shadertoy 代码默认带 4 个通道采样器
      for (let i = 0; i < 4; i++) {
        const n = 'iChannel' + i;
        if (!RE_DECL(n).test(src)) head.push('uniform sampler2D ' + n + ';');
      }
    }

    // 4b) vUv / 输出变量
    if (!RE_HAS_VUV.test(src)) head.push('in vec2 vUv;');
    // Shadertoy 模式下包装函数会写 fragColor，所以即使源码形参里出现过
    // `out vec4 fragColor`（那只是 mainImage 的形参），也必须补一个全局输出声明。
    if (outName === 'fragColor' && (shadertoy || !hasGlobalOut(src, outName))) {
      head.push('layout(location = 0) out vec4 fragColor;');
    }

    let final = head.join('\n') + '\n' + src;
    if (shadertoy) {
      final += '\n\nvoid main(){\n' +
        '  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);\n' +
        '  mainImage(c, gl_FragCoord.xy);\n' +
        '  ' + outName + ' = c;\n' +
        '}\n';
    }
    if (!/\bvoid\s+main\s*\(/.test(final)) {
      warnings.push('没有找到 void main()，着色器不会输出任何东西');
    }

    return {
      source: final,
      headerLines: head.length,
      shadertoy: shadertoy,
      warnings: warnings,
      autoUsed: autoUsed,
      outName: outName
    };
  }

  /* --------------------------- uniform 解析 --------------------------- */
  const UNI_RE = /^[ \t]*uniform[ \t]+(?:(?:highp|mediump|lowp)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[ \t]*(\d*)[ \t]*\])?[ \t]*;[ \t]*(\/\/[^\n]*)?/;

  function kindOf(type) {
    if (/^sampler/.test(type)) return 'sampler';
    if (type === 'bool' || /^bvec/.test(type)) return 'bool';
    if (type === 'int' || type === 'uint' || /^[iu]vec/.test(type)) return 'int';
    if (/^vec2$/.test(type)) return 'vec2';
    if (/^vec3$/.test(type)) return 'vec3';
    if (/^vec4$/.test(type)) return 'vec4';
    if (/^mat/.test(type)) return 'mat';
    if (type === 'float') return 'float';
    return 'other';
  }
  const COMPONENTS = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 };

  function parseAnnotation(text) {
    const ann = {};
    if (!text) return ann;
    const re = /@([A-Za-z_]\w*)([^@]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const key = m[1].toLowerCase();
      const rest = m[2].trim();
      const nums = rest.split(/[\s,]+/).map(Number).filter(function (n) { return isFinite(n); });
      if (key === 'range') {
        if (nums.length >= 2) ann.range = [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
        else if (nums.length === 1) ann.range = [0, nums[0]];
      } else if (key === 'step') {
        if (nums.length && nums[0] > 0) ann.step = nums[0];
      } else if (key === 'default' || key === 'def' || key === 'value') {
        if (nums.length) ann.def = nums;
      } else if (key === 'label' || key === 'name') {
        ann.label = rest || null;
      } else if (key === 'color' || key === 'colour') {
        ann.color = true;
      } else if (key === 'hidden' || key === 'readonly') {
        ann.hidden = true;
      } else if (key === 'hint') {
        ann.hint = rest || null;
      }
    }
    return ann;
  }

  function cleanComment(line) {
    let t = line.trim();
    if (t.indexOf('//') === 0) t = t.slice(2);
    else if (t.indexOf('/*') === 0) t = t.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
    return t.replace(/^[*\s]+/, '');
  }

  /**
   * 解析源码里的 uniform 声明 + 上一行/同行的注解。
   * @returns {Array<{name,type,kind,array,line,ann}>}
   */
  function parseUniforms(src) {
    const list = [];
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = UNI_RE.exec(lines[i]);
      if (!m) continue;
      const type = m[1], name = m[2], arrSize = m[3];
      const trailing = m[4] || '';
      // 向上收集连续注释行
      const above = [];
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (t.indexOf('//') === 0 || (t.indexOf('/*') === 0 && t.indexOf('*/') > 0)) above.unshift(t);
        else break;
      }
      const annText = above.map(cleanComment).join(' ') + ' ' + cleanComment(trailing);
      const ann = parseAnnotation(annText);
      const kind = kindOf(type);
      const isColor = !!(ann.color || ((kind === 'vec3' || kind === 'vec4') && /colou?r/i.test(name)));
      list.push({
        name: name,
        type: type,
        kind: kind,
        array: arrSize ? (arrSize === '' ? 1 : parseInt(arrSize, 10)) : 0,
        line: i + 1,
        ann: ann,
        isColor: isColor && kind !== 'sampler',
        editable: kind !== 'mat' && kind !== 'other'
      });
    }
    return list;
  }

  /** 从完整源码（含 Shadertoy 自动声明）里补全 sampler 列表 */
  function samplerFallback(list, built) {
    if (!built.shadertoy) return list;
    const has = {};
    list.forEach((u) => (has[u.name] = 1));
    for (let i = 0; i < 4; i++) {
      const n = 'iChannel' + i;
      if (!has[n]) {
        list.push({
          name: n, type: 'sampler2D', kind: 'sampler', array: 0, line: 0,
          ann: { label: 'Shadertoy 通道 ' + i }, isColor: false, editable: true, auto: true
        });
      }
    }
    return list;
  }

  /* ------------------------------ 报错解析 ------------------------------ */
  /**
   * 解析 WebGL 编译日志。行号映射回用户的编辑器行（去掉注入的头部）。
   * 支持 ANGLE 格式 "ERROR: 0:12: 'x' : msg" 与 "0:12(3): error: msg"。
   */
  function parseLog(log, headerLines) {
    const out = [];
    if (!log) return out;
    const lines = String(log).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const sev = /warning/i.test(line) ? 'warn' : 'error';
      let raw = 0;
      let msg = '';
      // Chrome / ANGLE：ERROR: 0:28: ';' : syntax error
      let m = /(?:ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)$/i.exec(line);
      if (m) {
        raw = parseInt(m[2], 10);
        msg = m[3];
      } else {
        // NVIDIA / Mesa：0(28) : error C0000: ...
        m = /(\d+)\((\d+)\)\s*:\s*(?:error|warning)?\s*[A-Za-z]?\d*\s*:?\s*(.*)$/i.exec(line);
        if (m) {
          raw = parseInt(m[2], 10);
          msg = m[3];
        } else {
          // 其它：0:28: ...
          m = /(?:^|\s)(\d+):(\d+):\s*(.*)$/i.exec(line);
          if (m) {
            raw = parseInt(m[2], 10);
            msg = m[3];
          }
        }
      }
      if (raw > 0) {
        const userLine = Math.max(1, raw - headerLines);
        out.push({ line: userLine, rawLine: raw, message: String(msg).trim() || line.trim(), severity: sev });
      } else if (/(ERROR|error|WARNING|warning):/.test(line)) {
        out.push({ line: 0, rawLine: 0, message: line.trim(), severity: sev });
      }
    }
    return out;
  }

  /* -------------------------------- 高亮 -------------------------------- */
  const TOKEN_RE = new RegExp(
    '(\\/\\/[^\\n]*)' +          // 1 行注释
    '|(\\/\\*[\\s\\S]*?\\*\\/)' + // 2 块注释
    '|(^[ \\t]*#[^\\n]*)' +       // 3 预处理
    '|("(?:[^"\\\\\\n]|\\\\.)*")' + // 4 字符串
    '|((?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[eE][+-]?\\d+)?[uUfF]?)' + // 5 数字
    '|([A-Za-z_]\\w*)' +          // 6 标识符
    '|([ \\t\\r\\n]+)' +          // 7 空白
    '|([^\\w\\s])',               // 8 标点
    'gm'
  );

  function highlight(src) {
    const s = String(src || '');
    let out = '';
    let last = 0;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s))) {
      if (m.index > last) out += SL.esc(s.slice(last, m.index));
      last = TOKEN_RE.lastIndex;
      let cls = '';
      if (m[1] || m[2]) cls = 'tk-com';
      else if (m[3]) cls = 'tk-dir';
      else if (m[4]) cls = 'tk-str';
      else if (m[5]) cls = 'tk-num';
      else if (m[6]) {
        const w = m[6];
        if (SET_TYPE[w]) cls = 'tk-typ';
        else if (SET_KEY[w]) cls = w === 'true' || w === 'false' ? 'tk-num' : 'tk-key';
        else if (SET_BUILTIN[w]) cls = 'tk-blt';
        else {
          // 后瞻是否紧跟 '(' → 函数调用
          let k = TOKEN_RE.lastIndex;
          while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
          cls = s[k] === '(' ? 'tk-fn' : 'tk-var';
        }
      } else if (m[7]) cls = '';
      else cls = 'tk-op';
      out += cls ? '<span class="' + cls + '">' + SL.esc(m[0]) + '</span>' : SL.esc(m[0]);
    }
    if (last < s.length) out += SL.esc(s.slice(last));
    return out;
  }

  /* ------------------------------- 新建模板 ------------------------------- */
  const TEMPLATES = {
    empty:
      '// 新 Pass：u_tex 为上一 Pass 的输出（或第一个 Pass 的输入图）\n' +
      '// 可用内置：vUv、u_time、u_resolution、u_texel、u_mouse\n' +
      'void main() {\n' +
      '  vec3 col = texture(u_tex, vUv).rgb;\n' +
      '  fragColor = vec4(col, 1.0);\n' +
      '}\n',
    generator:
      '// 生成器：不依赖输入纹理\n' +
      'void main() {\n' +
      '  vec2 uv = vUv;\n' +
      '  vec3 col = 0.5 + 0.5 * cos(u_time + uv.xyx * 3.0 + vec3(0.0, 2.0, 4.0));\n' +
      '  fragColor = vec4(col, 1.0);\n' +
      '}\n',
    shadertoy:
      '// 直接粘贴 Shadertoy 的 mainImage 代码即可，iTime / iResolution / iMouse 已自动补齐\n' +
      'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n' +
      '  vec2 uv = fragCoord / iResolution.xy;\n' +
      '  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx * 3.0 + vec3(0.0, 2.0, 4.0));\n' +
      '  fragColor = vec4(col, 1.0);\n' +
      '}\n'
  };

  /* -------------------------------- 片段 -------------------------------- */
  const SNIPPETS = [
    {
      label: '噪声 hash21', desc: '0..1 的伪随机',
      code: 'float hash21(vec2 p){\n  p = fract(p * vec2(123.34, 456.21));\n  p += dot(p, p + 45.32);\n  return fract(p.x * p.y);\n}\n'
    },
    {
      label: 'FBM 分形噪声', desc: '5 层 value noise',
      code: 'float fbm(vec2 p){\n  float v = 0.0, a = 0.5;\n  for (int i = 0; i < 5; i++){\n    v += a * sl_hash21(floor(p));\n    p = p * 2.03 + 17.0;\n    a *= 0.5;\n  }\n  return v;\n}\n'
    },
    {
      label: '极坐标', desc: '中心 + 角度 + 半径',
      code: 'vec2 c = vUv - 0.5;\nfloat r = length(c);\nfloat a = atan(c.y, c.x);\n'
    },
    {
      label: 'Sobel 边缘', desc: '依赖输入纹理',
      code: 'vec2 e = u_texel;\nfloat tl = sl_luma(texture(u_tex, vUv + e * vec2(-1.0,  1.0)).rgb);\nfloat t  = sl_luma(texture(u_tex, vUv + e * vec2( 0.0,  1.0)).rgb);\nfloat tr = sl_luma(texture(u_tex, vUv + e * vec2( 1.0,  1.0)).rgb);\nfloat l  = sl_luma(texture(u_tex, vUv + e * vec2(-1.0,  0.0)).rgb);\nfloat r  = sl_luma(texture(u_tex, vUv + e * vec2( 1.0,  0.0)).rgb);\nfloat bl = sl_luma(texture(u_tex, vUv + e * vec2(-1.0, -1.0)).rgb);\nfloat b  = sl_luma(texture(u_tex, vUv + e * vec2( 0.0, -1.0)).rgb);\nfloat br = sl_luma(texture(u_tex, vUv + e * vec2( 1.0, -1.0)).rgb);\nfloat gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;\nfloat gy =  tl + 2.0 * t + tr - bl - 2.0 * b - br;\nfloat edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);\n'
    },
    {
      label: '高斯模糊 9-tap', desc: '分离式单方向',
      code: 'vec3 blur = vec3(0.0);\nfloat wsum = 0.0;\nfor (int i = -4; i <= 4; i++){\n  float w = exp(-float(i * i) / 8.0);\n  blur += texture(u_tex, vUv + vec2(float(i) * u_texel.x * 1.5, 0.0)).rgb * w;\n  wsum += w;\n}\nblur /= wsum;\n'
    },
    {
      label: 'ACES 色调映射', desc: 'HDR → LDR',
      code: 'vec3 aces(vec3 x){\n  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;\n  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);\n}\n'
    },
    {
      label: '旋转缩放', desc: '绕中心旋转变换 uv',
      code: 'vec2 p = vUv - 0.5;\np = sl_rotate(u_time * 0.5) * p;\np /= 0.8;\nvec2 uv2 = p + 0.5;\n'
    },
    {
      label: '亮度阈值', desc: '用于 bloom / 高光',
      code: 'vec3 c = texture(u_tex, vUv).rgb;\nfloat lum = dot(c, vec3(0.2126, 0.7152, 0.0722));\nvec3 bright = c * step(0.6, lum);\n'
    }
  ];

  SL.glsl = {
    build: build,
    parseUniforms: parseUniforms,
    samplerFallback: samplerFallback,
    parseLog: parseLog,
    parseAnnotation: parseAnnotation,
    highlight: highlight,
    kindOf: kindOf,
    legacyFix: legacyFix,
    AUTO_UNIFORMS: AUTO_UNIFORMS,
    SHADERTOY_UNIFORMS: SHADERTOY_UNIFORMS,
    COMPONENTS: COMPONENTS,
    TEMPLATES: TEMPLATES,
    SNIPPETS: SNIPPETS,
    PRELUDE: PRELUDE
  };
})(window.SL);
