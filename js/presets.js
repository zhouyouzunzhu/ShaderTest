/* ==========================================================================
   presets.js — 内置示例管线
   --------------------------------------------------------------------------
   结构：{ id, name, desc, note, source, output:{w,h}, passes:[ pass ] }
   pass：{ id, name, code, format:'rgba8'|'hdr', scale, filter, wrap, bindings }
   · 代码里不需要写 #version / precision / main 之外的脚手架，构建器会补
   · 参数初值由 // @default 注解提供，无需在 preset 里重复
   · bindings 省略等价于 { kind:'prev' }；首个 Pass 的 prev 就是「输入图」
   ========================================================================== */
window.SL = window.SL || {};
(function (SL) {
  'use strict';

  function P(id, name, code, extra) {
    const p = {
      id: id,
      name: name,
      code: code,
      enabled: true,
      format: 'rgba8',
      scale: 1,
      filter: 'linear',
      wrap: 'clamp',
      bindings: {},
      values: {}
    };
    if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
    return p;
  }

  /* ------------------------------ 1 基础调色 ------------------------------ */
  const START = `
uniform sampler2D u_tex;      // 输入纹理（首个 Pass 即「输入图」）

uniform float u_sat;      // @range 0 2 @step 0.01 @default 1.05 @label 饱和度
uniform float u_contrast; // @range 0 2 @step 0.01 @default 1.02 @label 对比度
uniform vec3  u_tint;     // @color @label 色调
uniform float u_vig;      // @range 0 1 @step 0.01 @default 0.25 @label 暗角

void main() {
  vec3 c = texture(u_tex, vUv).rgb;

  // 饱和度
  float l = sl_luma(c);
  c = mix(vec3(l), c, u_sat);

  // 对比度（围绕中灰）
  c = (c - 0.5) * u_contrast + 0.5;

  // 色调
  c *= u_tint;

  // 暗角
  vec2 d = (vUv - 0.5) * vec2(u_aspect, 1.0);
  c *= mix(1.0, smoothstep(0.85, 0.2, length(d)), u_vig);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  /* ------------------------------ 2 坐标画布 ------------------------------ */
  const UV = `
uniform float u_grid;  // @range 0 1 @step 0.01 @default 1 @label 网格
uniform float u_rings; // @range 1 40 @step 1 @default 7 @label 环数
uniform float u_lines; // @range 0 1 @step 0.01 @default 0.6 @label 坐标轴

void main() {
  // 以画面中心为原点、保持长宽比的坐标：x ∈ [-aspect, aspect]，y ∈ [-1, 1]
  vec2 p = (vUv * 2.0 - 1.0) * vec2(u_aspect, 1.0);

  vec3 col = vec3(0.04, 0.05, 0.07);

  // 同心环：能直观看出 uv 的半径变化
  float r = length(p);
  float rings = abs(sin(r * u_rings * PI));
  col += vec3(0.15, 0.45, 0.95) * smoothstep(0.85, 1.0, rings) * 0.9;

  // 网格
  vec2 g = fract(vUv * 16.0);
  float line = 1.0 - smoothstep(0.0, 0.015, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)));
  col += vec3(0.30) * line * u_grid;

  // 中心坐标轴
  float axis = 1.0 - smoothstep(0.0, 0.004, min(abs(p.x), abs(p.y)));
  col += vec3(0.85, 0.85, 0.9) * axis * u_lines;

  // 鼠标位置（u_mouse.xy 为像素坐标，左上角原点）
  vec2 m = (u_mouse.xy / u_resolution * 2.0 - 1.0) * vec2(u_aspect, 1.0);
  col += vec3(1.0, 0.78, 0.25) * exp(-60.0 * length(p - m));
  col += vec3(0.9, 0.6, 0.2) * 0.35 * exp(-8.0 * length(p - m));

  fragColor = vec4(col, 1.0);
}
`;

  /* -------------------------------- 3 波纹 -------------------------------- */
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

  /* -------------------------- 4 高斯模糊（两 Pass） -------------------------- */
  const BLUR_H = `
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

  const BLUR_V = `
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

  /* ------------------------------ 5 泛光（四 Pass） ------------------------------ */
  const BLOOM_BRIGHT = `
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

  const BLOOM_H = `
uniform sampler2D u_tex;
uniform float u_radius; // @range 0 32 @step 0.1 @default 5.0 @label 半径(px)

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

  const BLOOM_V = `
uniform sampler2D u_tex;
uniform float u_radius; // @range 0 32 @step 0.1 @default 5.0 @label 半径(px)

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

  const BLOOM_COMP = `
uniform sampler2D u_base;  // 原始画面
uniform sampler2D u_bloom; // 模糊后的亮部

uniform float u_intensity; // @range 0 4 @step 0.01 @default 1.2 @label 强度
uniform float u_exposure;  // @range 0.2 3 @step 0.01 @default 1.0 @label 曝光

void main() {
  vec3 base  = texture(u_base, vUv).rgb;
  vec3 bloom = texture(u_bloom, vUv).rgb;

  vec3 c = base + bloom * u_intensity;
  c *= u_exposure;
  // 简易色调压缩，避免亮部直接切平
  c = c / (1.0 + c * 0.35);

  fragColor = vec4(c, 1.0);
}
`;

  /* -------------------------------- 6 描边 -------------------------------- */
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

  // Sobel
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float g = pow(length(vec2(gx, gy)), u_power) * u_strength;

  vec3 line = u_color * clamp(g, 0.0, 4.0);
  vec3 base = texture(u_tex, vUv).rgb;

  fragColor = vec4(mix(base, line, u_mix), 1.0);
}
`;

  /* ------------------------------ 7 色差暗角 ------------------------------ */
  const CHROMA = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.03 @step 0.0005 @default 0.005 @label 色差
uniform float u_zoom;   // @range 1 1.3 @step 0.001 @default 1.04 @label 缩放
uniform float u_vig;    // @range 0 1 @step 0.01 @default 0.45 @label 暗角
uniform float u_scan;   // @range 0 1 @step 0.01 @default 0 @label 扫描线

void main() {
  vec2 d = vUv - 0.5;
  vec2 p = d * u_zoom + 0.5;

  // 三个通道按不同方向偏移，模拟镜头色散
  float r = texture(u_tex, p + d * u_amount).r;
  float g = texture(u_tex, p).g;
  float b = texture(u_tex, p - d * u_amount).b;
  vec3 c = vec3(r, g, b);

  // 暗角：随半径压暗，边缘更明显
  c *= mix(1.0, smoothstep(0.95, 0.15, length(d) * 1.15), u_vig);

  // 扫描线
  c *= 1.0 - u_scan * 0.35 * step(0.5, fract(vUv.y * u_resolution.y * 0.5));

  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------- 8 像素化 ------------------------------- */
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

  // 量化
  c = floor(c * u_levels + 0.5) / u_levels;

  // 描格
  vec2 f = fract(vUv * cells);
  float line = 1.0 - smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  c = mix(c, vec3(0.0), line * u_grid * 0.6);

  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------ 9 自反馈残影 ------------------------------ */
  const TRAILS = `
uniform sampler2D u_tex;  // 当前输入
uniform sampler2D u_self; // 自身上一帧（反馈）

uniform float u_decay;  // @range 0 0.99 @step 0.001 @default 0.94 @label 衰减
uniform float u_new;    // @range 0 1 @step 0.01 @default 0.65 @label 新帧权重
uniform float u_shift;  // @range 0 0.02 @step 0.0005 @default 0.003 @label 拖尾偏移

void main() {
  vec2 uv = vUv + (vUv - 0.5) * u_shift;

  vec3 cur = texture(u_tex, vUv).rgb;
  vec3 old = texture(u_self, uv).rgb * u_decay;

  // 叠加后再做一次柔和的饱和压缩
  vec3 c = max(cur * u_new + old, cur * u_new);
  c = c / (1.0 + c * 0.15);

  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------- 10 等离子 ------------------------------- */
  const PLASMA = `
uniform float u_scale; // @range 0.5 8 @step 0.01 @default 2.4 @label 尺度
uniform float u_warp;  // @range 0 3 @step 0.01 @default 1.0 @label 扭曲
uniform float u_speed; // @range 0 3 @step 0.01 @default 0.4 @label 速度
uniform float u_gamma; // @range 0.5 2.5 @step 0.01 @default 1.0 @label 对比

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(u_aspect, 1.0) * u_scale;
  float t = u_time * u_speed;

  // 四层正弦叠加出经典的 plasma 花纹
  float v = 0.0;
  v += sin(uv.x * 2.0 + t);
  v += sin(uv.y * 3.0 - t * 1.3);
  v += sin((uv.x + uv.y) * 1.5 + t * 0.7);
  v += sin(length(uv) * 4.0 - t * 2.0);
  v *= u_warp * 0.25;

  vec3 c = palette(v * 0.5 + 0.5);
  c = pow(c, vec3(u_gamma));

  // 轻微的暗角收边
  c *= 1.0 - 0.35 * smoothstep(0.6, 1.6, length(vUv * 2.0 - 1.0));

  fragColor = vec4(c, 1.0);
}
`;

  /* -------------------------------- 组装 -------------------------------- */
  const PRESETS = [
    {
      id: 'start',
      name: '基础调色',
      desc: '读一张纹理做饱和度/对比度/色调/暗角',
      note: '最简结构：一个 Pass，一个 sampler2D + 四个参数。适合从这里改写。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '调色', START)]
    },
    {
      id: 'uv',
      name: '坐标画布',
      desc: '生成式 shader：看 vUv / aspect / 鼠标坐标',
      note: '不采样任何纹理，直接生成图案。用来确认坐标原点、长宽比与鼠标映射。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '坐标', UV)]
    },
    {
      id: 'wave',
      name: '波纹扭曲',
      desc: '按半径相位偏移 UV，并做通道错位',
      note: '扭曲类效果的起点：位移量随半径衰减，边缘不会采到画外。',
      source: 'b:checker',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '波纹', WAVE)]
    },
    {
      id: 'blur',
      name: '高斯模糊（2 Pass）',
      desc: '先横向后纵向的两趟可分离模糊',
      note: '演示多 Pass 链：第二个 Pass 的 u_tex 绑定「上一 Pass」，半径调大时用 r_scale 看中间结果。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [
        P('p1', '横向模糊', BLUR_H),
        P('p2', '纵向模糊', BLUR_V)
      ]
    },
    {
      id: 'bloom',
      name: '泛光 Bloom（4 Pass）',
      desc: '亮度提取 → 两趟模糊 → 与原图合成',
      note: '合成 Pass 同时绑定「源图」和「第 3 个 Pass」，展示多条输入的组合方式。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [
        P('p1', '亮度提取', BLOOM_BRIGHT, { format: 'hdr' }),
        P('p2', '横向模糊', BLOOM_H, { format: 'hdr' }),
        P('p3', '纵向模糊', BLOOM_V, { format: 'hdr' }),
        P('p4', '合成', BLOOM_COMP, {
          bindings: {
            u_base: { kind: 'pass', passId: '__source__' },
            u_bloom: { kind: 'pass', passId: 'p3' }
          }
        })
      ]
    },
    {
      id: 'edge',
      name: 'Sobel 描边',
      desc: '3×3 邻域取亮度梯度，可混回原图',
      note: '邻域采样的模板：u_texel 是 1/分辨率，按像素步进。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '描边', EDGE)]
    },
    {
      id: 'chroma',
      name: '色差与暗角',
      desc: 'RGB 三通道不同方向偏移 + 径向压暗',
      note: '镜头感后处理。把 u_amount 拉大会看到明显的分色边缘。',
      source: 'b:testcard',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '色差', CHROMA)]
    },
    {
      id: 'pixel',
      name: '像素化',
      desc: '块状降采样 + 色阶量化 + 抖动',
      note: '先把 UV 吸附到格子中心再采样，是各种「低分辨率」效果的通用做法。',
      source: 'b:gradient',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '像素', PIXEL)]
    },
    {
      id: 'trails',
      name: '自反馈残影',
      desc: '把上一帧按衰减叠进当前帧',
      note: 'u_self 绑定「自身上一帧」，引擎自动 ping-pong 两块缓冲。动起来才看得出效果，可用步进逐帧看。',
      source: 'b:circle',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '残影', TRAILS, {
        bindings: { u_self: { kind: 'self' } }
      })]
    },
    {
      id: 'plasma',
      name: '等离子生成',
      desc: '纯数学生成，不依赖任何输入',
      note: '当「生成器」用：把它放在管线末尾当背景，或接到其它 Pass 前面改造。',
      source: 'b:noise',
      output: { w: 1280, h: 720 },
      passes: [P('p1', '等离子', PLASMA)]
    }
  ];

  const BY_ID = {};
  PRESETS.forEach(function (p) { BY_ID[p.id] = p; });

  function get(id) {
    const p = BY_ID[id] || PRESETS[0];
    return SL.deepClone({
      id: p.id,
      name: p.name,
      desc: p.desc,
      note: p.note,
      source: p.source,
      output: p.output,
      passes: p.passes
    });
  }

  SL.presets = {
    list: PRESETS.map(function (p) { return { id: p.id, name: p.name, desc: p.desc }; }),
    ids: PRESETS.map(function (p) { return p.id; }),
    get: get,
    has: function (id) { return !!BY_ID[id]; },
    all: PRESETS
  };
})(window.SL);
