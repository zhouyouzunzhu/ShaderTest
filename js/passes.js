/* ==========================================================================
   passes.js — 常见 Pass 模板（插入到管线里的现成算法）
   --------------------------------------------------------------------------
   每个模板：{ id, name, group, desc, tags, passes:[ {name, code, format?, scale?, bindings?} ] }
   · 一个模板可能包含多个 Pass（高斯模糊是横+纵两趟，泛光是四趟）
   · code 里不用写 #version / precision，构建器会补；可用 u_tex / vUv / fragColor
   · bindings 里的 passId 支持 '__source__'（原始输入），其余省略等于「上一 Pass」
   · 模板只描述形状，插入时由 app.js 分配 p1..pN 的 id
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  /* ------------------------------- 调色 / 影调 ------------------------------- */

  const COLOR_BASIC = `
uniform sampler2D u_tex;   // 上一 Pass 的输出（首个 Pass 时是「输入图」）

uniform float u_sat;       // @range 0 2 @step 0.01 @default 1.0 @label 饱和度
uniform float u_contrast;  // @range 0 2 @step 0.01 @default 1.0 @label 对比度
uniform vec3  u_tint;      // @color @label 色调
uniform float u_vig;       // @range 0 1 @step 0.01 @default 0.0 @label 暗角

void main() {
  vec3 c = texture(u_tex, vUv).rgb;

  float l = sl_luma(c);
  c = mix(vec3(l), c, u_sat);

  c = (c - 0.5) * u_contrast + 0.5;
  c *= u_tint;

  vec2 d = (vUv - 0.5) * vec2(u_aspect, 1.0);
  c *= mix(1.0, smoothstep(0.85, 0.2, length(d)), u_vig);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  const LEVELS = `
uniform sampler2D u_tex;

uniform float u_black; // @range 0 1 @step 0.005 @default 0.0 @label 黑场
uniform float u_white; // @range 0 1 @step 0.005 @default 1.0 @label 白场
uniform float u_gamma; // @range 0.2 3 @step 0.01 @default 1.0 @label 伽马

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  float span = max(u_white - u_black, 1e-3);
  c = clamp((c - u_black) / span, 0.0, 1.0);
  // 亮度域做伽马，保住色相
  float l = sl_luma(c);
  float nl = pow(max(l, 1e-4), u_gamma);
  c = c * (nl / max(l, 1e-4));
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  const GRAY = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 1 @step 0.01 @default 1.0 @label 去色
uniform vec3  u_tint;   // @color @label 单色调（默认白=纯灰）

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  vec3 g = vec3(sl_luma(c)) * u_tint;
  fragColor = vec4(mix(c, g, u_amount), 1.0);
}
`;

  const ACES = `
uniform sampler2D u_tex;

uniform float u_exposure; // @range 0.1 4 @step 0.01 @default 1.0 @label 曝光
uniform float u_contrast; // @range 0.5 1.5 @step 0.01 @default 1.0 @label 对比度

// ACES 近似（Narkowicz）
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 c = texture(u_tex, vUv).rgb * u_exposure;
  c = aces(c);
  c = (c - 0.5) * u_contrast + 0.5;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  /* --------------------------------- 模糊 --------------------------------- */

  const GAUSS_H = `
uniform sampler2D u_tex;
uniform float u_radius; // @range 0 16 @step 0.1 @default 3.0 @label 半径(px)

void main() {
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec2 sp = vec2(u_texel.x * u_radius, 0.0);
  vec3 c = texture(u_tex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = sp * float(i);
    c += texture(u_tex, vUv + o).rgb * w[i];
    c += texture(u_tex, vUv - o).rgb * w[i];
  }
  fragColor = vec4(c, 1.0);
}
`;

  const GAUSS_V = `
uniform sampler2D u_tex;
uniform float u_radius; // @range 0 16 @step 0.1 @default 3.0 @label 半径(px)

void main() {
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec2 sp = vec2(0.0, u_texel.y * u_radius);
  vec3 c = texture(u_tex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = sp * float(i);
    c += texture(u_tex, vUv + o).rgb * w[i];
    c += texture(u_tex, vUv - o).rgb * w[i];
  }
  fragColor = vec4(c, 1.0);
}
`;

  const ZOOM_BLUR = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.2 @step 0.001 @default 0.04 @label 拉伸
uniform float u_center; // @range 0 6 @step 0.01 @default 2.0 @label 聚焦

void main() {
  vec2 dir = vUv - 0.5;
  vec3 sum = vec3(0.0);
  const int N = 10;
  for (int i = 0; i < N; i++) {
    float k = float(i) / float(N - 1);
    // 越靠近中心采样越密，避免整体发糊
    vec2 uv = 0.5 + dir * (1.0 - u_amount * k);
    sum += texture(u_tex, uv).rgb;
  }
  vec3 c = sum / float(N);
  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------ 提取 / 描边 ------------------------------ */

  const BRIGHT = `
uniform sampler2D u_tex;

uniform float u_threshold; // @range 0 2 @step 0.01 @default 0.70 @label 阈值
uniform float u_knee;      // @range 0 1 @step 0.01 @default 0.30 @label 过渡

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  float l = sl_luma(c);
  float s = smoothstep(u_threshold, u_threshold + max(u_knee, 1e-3), l);
  fragColor = vec4(c * s, 1.0);
}
`;

  const EDGE = `
uniform sampler2D u_tex;

uniform float u_strength; // @range 0 6 @step 0.01 @default 1.4 @label 强度
uniform float u_mix;      // @range 0 1 @step 0.01 @default 1 @label 混合原图
uniform float u_power;    // @range 0.5 4 @step 0.01 @default 1 @label 对比
uniform vec3  u_color;    // @color @label 线条颜色

float lum(vec2 uv) { return sl_luma(texture(u_tex, uv).rgb); }

void main() {
  vec2 t = u_texel;
  float tl = lum(vUv + vec2(-t.x,  t.y));
  float tc = lum(vUv + vec2( 0.0,  t.y));
  float tr = lum(vUv + vec2( t.x,  t.y));
  float ml = lum(vUv + vec2(-t.x,  0.0));
  float mr = lum(vUv + vec2( t.x,  0.0));
  float bl = lum(vUv + vec2(-t.x, -t.y));
  float bc = lum(vUv + vec2( 0.0, -t.y));
  float br = lum(vUv + vec2( t.x, -t.y));

  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float g = pow(length(vec2(gx, gy)), u_power) * u_strength;

  vec3 base = texture(u_tex, vUv).rgb;
  fragColor = vec4(mix(base, u_color * clamp(g, 0.0, 4.0), u_mix), 1.0);
}
`;

  /* --------------------------------- 合成 --------------------------------- */

  const BLOOM_COMP = `
uniform sampler2D u_base;   // 原始画面
uniform sampler2D u_bloom;  // 模糊后的亮部

uniform float u_intensity; // @range 0 4 @step 0.01 @default 1.2 @label 强度
uniform float u_exposure;  // @range 0.2 3 @step 0.01 @default 1.0 @label 曝光

void main() {
  vec3 base  = texture(u_base, vUv).rgb;
  vec3 bloom = texture(u_bloom, vUv).rgb;

  vec3 c = base + bloom * u_intensity;
  c *= u_exposure;
  c = c / (1.0 + c * 0.35);

  fragColor = vec4(c, 1.0);
}
`;

  /* -------------------------------- 风格化 -------------------------------- */

  const CHROMA = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.03 @step 0.0005 @default 0.005 @label 色差
uniform float u_zoom;   // @range 1 1.3 @step 0.001 @default 1.04 @label 缩放
uniform float u_vig;    // @range 0 1 @step 0.01 @default 0.45 @label 暗角
uniform float u_scan;   // @range 0 1 @step 0.01 @default 0 @label 扫描线

void main() {
  vec2 d = vUv - 0.5;
  vec2 p = d * u_zoom + 0.5;

  float r = texture(u_tex, p + d * u_amount).r;
  float g = texture(u_tex, p).g;
  float b = texture(u_tex, p - d * u_amount).b;
  vec3 c = vec3(r, g, b);

  c *= mix(1.0, smoothstep(0.95, 0.15, length(d) * 1.15), u_vig);
  c *= 1.0 - u_scan * 0.35 * step(0.5, fract(vUv.y * u_resolution.y * 0.5));

  fragColor = vec4(c, 1.0);
}
`;

  const PIXEL = `
uniform sampler2D u_tex;

uniform float u_size;   // @range 1 64 @step 1 @default 6 @label 像素块
uniform float u_levels; // @range 2 32 @step 1 @default 12 @label 色阶
uniform float u_grid;   // @range 0 1 @step 0.01 @default 0 @label 描格
uniform float u_dither; // @range 0 1 @step 0.01 @default 0.35 @label 抖动

void main() {
  vec2 cells = max(floor(u_resolution / max(u_size, 1.0)), vec2(1.0));
  vec2 cell = floor(vUv * cells);
  vec2 uv = (cell + 0.5) / cells;

  vec3 c = texture(u_tex, uv).rgb;

  // 有序抖动（4×4 Bayer），缓解低色阶的色带
  vec2 p = mod(cell, 4.0);
  float bayer = mod(p.x * 2.0 + p.y * 3.0, 4.0) / 4.0;
  c += (bayer - 0.5) * u_dither / u_levels;

  c = floor(c * u_levels + 0.5) / u_levels;

  vec2 f = fract(vUv * cells);
  float line = 1.0 - smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  c = mix(c, vec3(0.0), line * u_grid * 0.6);

  fragColor = vec4(c, 1.0);
}
`;

  const GRAIN = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.4 @step 0.005 @default 0.06 @label 强度
uniform float u_size;   // @range 1 4 @step 0.5 @default 1.0 @label 颗粒大小
uniform float u_flicker;// @range 0 1 @step 0.01 @default 0.3 @label 闪烁

void main() {
  vec3 c = texture(u_tex, vUv).rgb;

  // 每帧变化的哈希噪声（u_frame 保证逐帧不同）
  vec2 gp = floor(vUv * u_resolution / max(u_size, 0.5));
  float n = sl_hash21(gp + vec2(u_frame * 37.0, u_frame * 91.0));
  float k = (n - 0.5) * u_amount * (1.0 + u_flicker * 4.0);

  c += k;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  /* --------------------------------- 扭曲 --------------------------------- */

  const WAVE = `
uniform sampler2D u_tex;

uniform float u_amp;   // @range 0 0.1 @step 0.001 @default 0.018 @label 幅度
uniform float u_freq;  // @range 1 60 @step 0.5 @default 16 @label 频率
uniform float u_speed; // @range 0 4 @step 0.01 @default 1.2 @label 速度
uniform float u_aber;  // @range 0 3 @step 0.01 @default 1 @label 色散

void main() {
  vec2 p = vUv - 0.5;
  float d = length(p);
  // 距离中心越远位移越大、边缘趋近于 0，避免采到画外
  float w = sin(d * u_freq - u_time * u_speed) * u_amp * (1.0 - smoothstep(0.2, 0.7, d));
  vec2 dir = p / max(d, 1e-4);
  vec2 uv = vUv + dir * w;

  vec3 c;
  c.r = texture(u_tex, uv + dir * w * 0.25 * u_aber).r;
  c.g = texture(u_tex, uv).g;
  c.b = texture(u_tex, uv - dir * w * 0.25 * u_aber).b;

  fragColor = vec4(c, 1.0);
}
`;

  const DISPLACE = `
uniform sampler2D u_tex;
uniform sampler2D u_noise; // 位移图（默认用内置噪声）

uniform float u_amount; // @range 0 0.2 @step 0.001 @default 0.03 @label 强度
uniform float u_speed;  // @range 0 2 @step 0.01 @default 0.15 @label 流动速度
uniform float u_scale;  // @range 0.5 8 @step 0.1 @default 2.0 @label 密度

void main() {
  vec2 n1 = texture(u_noise, vUv * u_scale + vec2(u_time * u_speed, 0.0)).rg;
  vec2 n2 = texture(u_noise, vUv * u_scale * 0.6 - vec2(0.0, u_time * u_speed * 0.7)).rg;
  vec2 off = (n1 + n2) - 1.0;
  vec3 c = texture(u_tex, vUv + off * u_amount).rgb;
  fragColor = vec4(c, 1.0);
}
`;

  const FEEDBACK = `
uniform sampler2D u_tex;   // 当前输入
uniform sampler2D u_self;  // 自身上一帧（反馈）

uniform float u_decay; // @range 0 0.99 @step 0.001 @default 0.94 @label 衰减
uniform float u_new;   // @range 0 1 @step 0.01 @default 0.65 @label 新帧权重
uniform float u_shift; // @range 0 0.02 @step 0.0005 @default 0.003 @label 拖尾偏移

void main() {
  vec2 uv = vUv + (vUv - 0.5) * u_shift;
  vec3 cur = texture(u_tex, vUv).rgb;
  vec3 old = texture(u_self, uv).rgb * u_decay;
  vec3 c = max(cur * u_new + old, cur * u_new);
  c = c / (1.0 + c * 0.15);
  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------- 组装模板 ------------------------------- */

  function p(name, code, extra) {
    const out = { name: name, code: code, format: 'rgba8', scale: 1, bindings: {} };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  const LIST = [
    {
      id: 'color-basic', name: '基础调色', group: '调色',
      desc: '饱和度 / 对比度 / 色调 / 暗角，拿来当起点',
      passes: [p('调色', COLOR_BASIC)]
    },
    {
      id: 'levels', name: '色阶', group: '调色',
      desc: '黑场白场 + 伽马，先把输入拉正',
      passes: [p('色阶', LEVELS)]
    },
    {
      id: 'gray', name: '黑白', group: '调色',
      desc: '按亮度去色，可带单色调',
      passes: [p('黑白', GRAY)]
    },
    {
      id: 'aces', name: 'ACES 影调', group: '调色',
      desc: 'HDR 画面的电影感映射，泛光之后接',
      passes: [p('ACES', ACES)]
    },
    {
      id: 'blur-gauss', name: '高斯模糊', group: '模糊',
      desc: '横向 + 纵向两趟，9 tap 近似',
      passes: [p('横向模糊', GAUSS_H), p('纵向模糊', GAUSS_V)]
    },
    {
      id: 'blur-zoom', name: '径向模糊', group: '模糊',
      desc: '从中心向外拉伸，常用于速度感',
      passes: [p('径向模糊', ZOOM_BLUR)]
    },
    {
      id: 'bright', name: '亮部提取', group: '提取',
      desc: '只留超过阈值的亮部，泛光的第一趟',
      passes: [p('亮部提取', BRIGHT)]
    },
    {
      id: 'edge', name: 'Sobel 描边', group: '提取',
      desc: '按亮度梯度出线，可叠在原图上',
      passes: [p('描边', EDGE)]
    },
    {
      id: 'bloom', name: '泛光 Bloom（四趟）', group: '合成',
      desc: '亮部提取 + 横纵模糊 + 与原图合成',
      passes: [p('亮部提取', BRIGHT), p('横向模糊', GAUSS_H), p('纵向模糊', GAUSS_V),
        p('泛光合成', BLOOM_COMP, { bindings: { u_base: { kind: 'pass', passId: '__source__' }, u_bloom: { kind: 'prev' } } })]
    },
    {
      id: 'chroma', name: '色差 + 暗角', group: '风格化',
      desc: '镜头色散、边缘压暗、可选扫描线',
      passes: [p('色差暗角', CHROMA)]
    },
    {
      id: 'pixel', name: '像素化', group: '风格化',
      desc: '分块 + 色阶量化 + Bayer 抖动',
      passes: [p('像素化', PIXEL)]
    },
    {
      id: 'grain', name: '胶片颗粒', group: '风格化',
      desc: '逐帧噪声，压一点数字感',
      passes: [p('颗粒', GRAIN)]
    },
    {
      id: 'wave', name: '波纹扭曲', group: '扭曲',
      desc: '按半径做正弦位移，带轻微色散',
      passes: [p('波纹', WAVE)]
    },
    {
      id: 'displace', name: '噪声位移', group: '扭曲',
      desc: '用噪声图推 UV，做热浪 / 水波扰动',
      passes: [p('位移', DISPLACE, { bindings: { u_noise: { kind: 'asset', assetId: 'b:noise' } } })]
    },
    {
      id: 'feedback', name: '残影反馈', group: '扭曲',
      desc: '把上一帧混进来，做拖尾 / 余像',
      passes: [p('残影', FEEDBACK, { bindings: { u_self: { kind: 'self' } } })]
    }
  ];

  const GROUPS = ['调色', '模糊', '提取', '合成', '风格化', '扭曲'];

  /** 默认新文档：一个「基础调色」Pass，采样输入图 */
  function defaultDoc() {
    return {
      source: (SL.assetDefaults && SL.assetDefaults.testcard) || 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [Object.assign({ id: 'p1', enabled: true, values: {} }, p('调色', COLOR_BASIC))]
    };
  }

  SL.passes = {
    list: LIST,
    groups: GROUPS,
    ids: LIST.map(function (t) { return t.id; }),
    has: function (id) { return LIST.some(function (t) { return t.id === id; }); },
    get: function (id) { return LIST.filter(function (t) { return t.id === id; })[0] || null; },
    byGroup: function (group) { return LIST.filter(function (t) { return t.group === group; }); },
    /** 生成一份可插入的 pass 列表（不带 id，由调用方分配） */
    build: function (id) {
      const t = SL.passes.get(id);
      if (!t) return [];
      return t.passes.map(function (src) {
        return {
          name: src.name,
          code: src.code,
          enabled: true,
          format: src.format || 'rgba8',
          scale: src.scale || 1,
          filter: 'linear',
          wrap: 'clamp',
          bindings: SL.deepClone(src.bindings || {}),
          values: {}
        };
      });
    },
    defaultDoc: defaultDoc
  };
})(window.SL);
