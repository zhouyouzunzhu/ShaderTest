/* ==========================================================================
   passes.js — 常见 Pass 模板（插入管线里的现成算法）
   --------------------------------------------------------------------------
   每个模板正好一个 Pass：
     { id, name, group, role:'filter'|'source', desc, pass:{name, code, ...} }

   · role='filter'：叠加态，读 u_tex（上一 Pass 的输出）再输出，如调色 / 模糊 / 扭曲
   · role='source'：中间态，不读 u_tex，自己生成一张图（噪声 / 渐变 / 条纹…），
     供后面的 Pass 用「指定 Pass」把它的输出当纹理采样
   · code 里不用写 #version / precision，构建器会补；可用 vUv / fragColor / u_time
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

  /* ------------------------------- 模糊 ------------------------------- */

  const GAUSS_TPL = (dir) => `
uniform sampler2D u_tex;

uniform float u_radius; // @range 0 3 @step 0.01 @default 1.0 @label 半径
uniform float u_strength; // @range 0 1 @step 0.01 @default 1.0 @label 强度

void main() {
  vec2 sp = ${dir} * u_texel * u_radius;

  vec3 c = texture(u_tex, vUv).rgb * 0.227027;
  c += texture(u_tex, vUv + sp * 1.3846).rgb * 0.3162162;
  c += texture(u_tex, vUv - sp * 1.3846).rgb * 0.3162162;
  c += texture(u_tex, vUv + sp * 3.2308).rgb * 0.0702703;
  c += texture(u_tex, vUv - sp * 3.2308).rgb * 0.0702703;

  vec3 src = texture(u_tex, vUv).rgb;
  fragColor = vec4(mix(src, c, u_strength), 1.0);
}
`;

  const GAUSS_H = GAUSS_TPL('vec2(1.0, 0.0)');
  const GAUSS_V = GAUSS_TPL('vec2(0.0, 1.0)');

  const ZOOM_BLUR = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.4 @step 0.005 @default 0.08 @label 拉伸
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.5 @label 中心

void main() {
  vec2 dir = vUv - u_center;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 10; i++) {
    float k = float(i) / 9.0;
    float w = 1.0 - k * 0.7;
    acc += texture(u_tex, vUv - dir * u_amount * k).rgb * w;
    ws += w;
  }
  fragColor = vec4(acc / ws, 1.0);
}
`;

  /* ------------------------------- 提取 ------------------------------- */

  const BRIGHT = `
uniform sampler2D u_tex;

uniform float u_threshold; // @range 0 2 @step 0.01 @default 0.7 @label 阈值
uniform float u_knee;      // @range 0 1 @step 0.01 @default 0.3 @label 过渡

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  float l = sl_luma(c);
  float s = smoothstep(u_threshold, u_threshold + max(u_knee, 1e-3), l);
  fragColor = vec4(c * s, 1.0);
}
`;

  const EDGE = `
uniform sampler2D u_tex;

uniform float u_strength; // @range 0 4 @step 0.01 @default 1.0 @label 强度
uniform float u_mix;      // @range 0 1 @step 0.01 @default 0.0 @label 叠加原图
uniform float u_power;    // @range 0.5 4 @step 0.01 @default 1.0 @label 锐度
uniform vec3  u_color;    // @color @label 线条颜色

float lum(vec2 uv) { return sl_luma(texture(u_tex, uv).rgb); }

void main() {
  vec2 sp = u_texel;
  float tl = lum(vUv + vec2(-sp.x, sp.y));
  float tr = lum(vUv + sp);
  float bl = lum(vUv - sp);
  float br = lum(vUv + vec2(sp.x, -sp.y));
  float l = lum(vUv - vec2(sp.x, 0.0));
  float r = lum(vUv + vec2(sp.x, 0.0));
  float b = lum(vUv - vec2(0.0, sp.y));
  float t = lum(vUv + vec2(0.0, sp.y));

  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  float g = sqrt(gx * gx + gy * gy) * u_strength;
  g = pow(clamp(g, 0.0, 1.0), u_power);

  vec3 src = texture(u_tex, vUv).rgb;
  vec3 line = u_color * g;
  fragColor = vec4(mix(line, src + line, u_mix), 1.0);
}
`;

  /* ------------------------------- 合成 ------------------------------- */

  const GLOW = `
uniform sampler2D u_tex;

uniform float u_threshold; // @range 0 2 @step 0.01 @default 0.65 @label 阈值
uniform float u_knee;      // @range 0 1 @step 0.01 @default 0.35 @label 过渡
uniform float u_spread;    // @range 0 0.08 @step 0.001 @default 0.018 @label 扩散
uniform float u_gain;      // @range 0 3 @step 0.01 @default 1.0 @label 强度
uniform vec3  u_color;     // @color @label 辉光颜色

void main() {
  vec3 base = texture(u_tex, vUv).rgb;

  // 两圈 8 向采样：够用又便宜，想更柔就叠两次模糊 Pass
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a));
    vec3 s1 = texture(u_tex, vUv + d * u_spread).rgb;
    vec3 s2 = texture(u_tex, vUv + d * u_spread * 2.35).rgb;
    acc += s1 * smoothstep(u_threshold, u_threshold + max(u_knee, 1e-3), sl_luma(s1));
    acc += s2 * 0.6 * smoothstep(u_threshold, u_threshold + max(u_knee, 1e-3), sl_luma(s2));
  }
  vec3 glow = acc / 8.0 * u_color * u_gain;

  vec3 c = base + glow;
  c = c / (1.0 + c * 0.3);   // 简易 tonemap，避免亮部糊成一片白
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  /* ------------------------------- 风格化 ------------------------------- */

  const CHROMA = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.05 @step 0.0005 @default 0.004 @label 色散
uniform float u_zoom;   // @range 0 0.2 @step 0.001 @default 0.0 @label 径向缩放
uniform float u_vig;    // @range 0 1 @step 0.01 @default 0.35 @label 暗角
uniform float u_scan;   // @range 0 1 @step 0.01 @default 0.0 @label 扫描线

void main() {
  vec2 p = vUv - 0.5;
  vec2 uv = 0.5 + p * (1.0 - u_zoom);
  vec3 c;
  c.r = texture(u_tex, uv + p * u_amount).r;
  c.g = texture(u_tex, uv).g;
  c.b = texture(u_tex, uv - p * u_amount).b;

  c *= mix(1.0, smoothstep(0.9, 0.25, length(p) * 1.25), u_vig);
  c *= mix(1.0, 0.85 + 0.15 * sin(vUv.y * u_resolution.y * 1.6), u_scan);

  fragColor = vec4(c, 1.0);
}
`;

  const PIXEL = `
uniform sampler2D u_tex;

uniform float u_size;   // @range 2 128 @step 1 @default 24 @label 像素块
uniform float u_levels; // @range 2 32 @step 1 @default 8 @label 色阶数
uniform float u_dither; // @range 0 1 @step 0.01 @default 0.6 @label 抖动
uniform float u_grid;   // @range 0 1 @step 0.01 @default 0.0 @label 网格线

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0,
                          12.0, 4.0, 14.0, 6.0,
                          3.0, 11.0, 1.0, 9.0,
                          15.0, 7.0, 13.0, 5.0);
  return m[y * 4 + x] / 16.0;
}

void main() {
  vec2 block = floor(vUv * u_resolution / u_size);
  vec2 uv = (block + 0.5) * u_size / u_resolution;
  vec3 c = texture(u_tex, uv).rgb;

  float d = (bayer4(block) - 0.5) * u_dither / u_levels;
  c = floor((c + d) * u_levels + 0.5) / u_levels;

  if (u_grid > 0.0) {
    vec2 g = fract(vUv * u_resolution / u_size);
    float line = 1.0 - smoothstep(0.0, 0.06, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)));
    c = mix(c, vec3(0.0), line * u_grid);
  }
  fragColor = vec4(c, 1.0);
}
`;

  const GRAIN = `
uniform sampler2D u_tex;

uniform float u_amount; // @range 0 0.3 @step 0.001 @default 0.05 @label 颗粒
uniform float u_size;   // @range 0.5 4 @step 0.1 @default 1.0 @label 颗粒尺寸
uniform float u_luma;   // @range 0 1 @step 0.01 @default 0.0 @label 亮度偏移

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  vec2 gp = floor(vUv * u_resolution / max(u_size, 0.1));
  float n = sl_hash21(gp + vec2(u_frame * 37.0, u_frame * 91.0)) - 0.5;
  c += n * u_amount;
  c += u_luma;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  /* ------------------------------- 扭曲 ------------------------------- */

  const WAVE = `
uniform sampler2D u_tex;

uniform float u_amp;   // @range 0 0.1 @step 0.001 @default 0.012 @label 幅度
uniform float u_freq;  // @range 2 80 @step 0.5 @default 26.0 @label 频率
uniform float u_speed; // @range 0 8 @step 0.05 @default 2.0 @label 速度
uniform float u_aber;  // @range 0 1 @step 0.01 @default 0.2 @label 色散

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
uniform sampler2D u_noise; // 位移图（默认用内置噪声，也可换成生成 Pass 的输出）

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

  /* ------------------------------- 生成（中间态） ------------------------------- */

  const GEN_PERLIN = `
// 柏林式噪声：多层 value noise，输出灰度图
uniform float u_scale;    // @range 1 32 @step 0.5 @default 6.0 @label 密度
uniform float u_octaves;  // @range 1 6 @step 1 @default 4 @label 层数
uniform float u_seed;     // @range 0 100 @step 1 @default 0 @label 种子
uniform float u_contrast; // @range 0.2 3 @step 0.01 @default 1.0 @label 对比

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sl_hash21(i);
  float b = sl_hash21(i + vec2(1.0, 0.0));
  float c = sl_hash21(i + vec2(0.0, 1.0));
  float d = sl_hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 p = vUv * u_scale + vec2(u_seed * 13.7, u_seed * 29.3);
  float v = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= u_octaves) break;
    v += vnoise(p) * amp;
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  v /= max(norm, 1e-4);
  v = clamp((v - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  fragColor = vec4(vec3(v), 1.0);
}
`;

  const GEN_FBM = `
// FBM 云：噪声再做一层域扭曲，适合当烟雾 / 水汽 / 位移图
uniform float u_scale;   // @range 1 24 @step 0.5 @default 4.0 @label 密度
uniform float u_warp;    // @range 0 2 @step 0.01 @default 0.6 @label 扭曲
uniform float u_gain;    // @range 0.2 1 @step 0.01 @default 0.55 @label 细节
uniform float u_seed;    // @range 0 100 @step 1 @default 0 @label 种子

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sl_hash21(i);
  float b = sl_hash21(i + vec2(1.0, 0.0));
  float c = sl_hash21(i + vec2(0.0, 1.0));
  float d = sl_hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    v += vnoise(p) * amp;
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return v / max(norm, 1e-4);
}

void main() {
  vec2 p = vUv * u_scale + vec2(u_seed * 7.1, u_seed * 11.7);
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  float v = fbm(p + q * u_warp * 4.0);
  v = mix(0.5, v, u_gain + 0.001);
  fragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}
`;

  const GEN_VORONOI = `
// 沃罗诺伊细胞：硬边板块，适合做鳞片 / 碎裂 / 遮罩
uniform float u_scale;  // @range 1 40 @step 0.5 @default 8.0 @label 密度
uniform float u_jitter; // @range 0 1 @step 0.01 @default 0.9 @label 抖动
uniform float u_seed;   // @range 0 100 @step 1 @default 0 @label 种子
uniform float u_soft;   // @range 0 0.5 @step 0.005 @default 0.04 @label 边缘

void main() {
  vec2 p = vUv * u_scale + u_seed;
  vec2 n = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  float md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 rnd = vec2(sl_hash21(n + g), sl_hash21(n + g + 17.3));
      rnd = 0.5 + 0.5 * sin(u_seed + TAU * rnd) * u_jitter;
      vec2 r = g + rnd - f;
      float d = dot(r, r);
      if (d < md) { md2 = md; md = d; }
      else if (d < md2) { md2 = d; }
    }
  }
  float edge = sqrt(md2) - sqrt(md);
  float cell = sqrt(md);
  // 细胞内部亮、边界暗
  float v = smoothstep(0.0, u_soft + 1e-4, edge) * (1.0 - cell);
  fragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}
`;

  const GEN_GRADIENT = `
// 径向渐变：中间亮到边缘暗，适合当光晕 / 遮罩
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.5 @label 中心
uniform float u_radius; // @range 0.05 1.5 @step 0.01 @default 0.55 @label 半径
uniform float u_soft;   // @range 0.01 1 @step 0.01 @default 0.5 @label 柔化
uniform float u_invert; // @range 0 1 @step 1 @default 0 @label 反向

void main() {
  float d = length(vUv - u_center);
  float v = 1.0 - smoothstep(u_radius - u_soft, u_radius, d);
  v = mix(v, 1.0 - v, u_invert);
  fragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}
`;

  const GEN_STRIPES = `
// 斜向条纹：角度 / 频率 / 软硬都能调
uniform float u_angle; // @range 0 3.1416 @step 0.01 @default 0.7854 @label 角度
uniform float u_freq;  // @range 1 60 @step 0.5 @default 12.0 @label 频率
uniform float u_soft;  // @range 0.001 0.5 @step 0.001 @default 0.08 @label 软边
uniform float u_duty;  // @range 0 1 @step 0.01 @default 0.5 @label 占空比

void main() {
  vec2 d = vec2(cos(u_angle), sin(u_angle));
  float t = dot(vUv, d) * u_freq;
  float f = fract(t);
  float v = smoothstep(0.5 - u_duty * 0.5 - u_soft, 0.5 - u_duty * 0.5, f)
          * (1.0 - smoothstep(0.5 + u_duty * 0.5, 0.5 + u_duty * 0.5 + u_soft, f));
  fragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}
`;

  const GEN_DOT = `
// 圆形光斑：中间实、边缘柔，做光点 / 阴影遮罩都行
uniform float u_radius; // @range 0.02 1 @step 0.005 @default 0.3 @label 半径
uniform float u_soft;   // @range 0.005 1 @step 0.005 @default 0.25 @label 柔化
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.5 @label 中心
uniform vec3  u_color;  // @color @label 颜色

void main() {
  float d = length(vUv - u_center);
  float v = 1.0 - smoothstep(u_radius - u_soft, u_radius, d);
  fragColor = vec4(u_color * clamp(v, 0.0, 1.0), 1.0);
}
`;

  /* ------------------------------- 组装模板 ------------------------------- */

  function p(name, code, extra) {
    const out = { name: name, code: code, format: 'rgba8', scale: 1, bindings: {} };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  const LIST = [
    /* 中间态：不读输入，自己生成一张图 */
    {
      id: 'gen-perlin', name: '柏林噪声', group: '生成', role: 'source',
      desc: '多层平滑噪声，当位移图 / 遮罩 / 云雾底',
      pass: p('柏林噪声', GEN_PERLIN)
    },
    {
      id: 'gen-fbm', name: 'FBM 云', group: '生成', role: 'source',
      desc: '噪声再扭一层，更像烟和水汽',
      pass: p('FBM 云', GEN_FBM)
    },
    {
      id: 'gen-voronoi', name: '沃罗诺伊', group: '生成', role: 'source',
      desc: '细胞状板块，鳞片 / 碎裂 / 网点',
      pass: p('沃罗诺伊', GEN_VORONOI)
    },
    {
      id: 'gen-gradient', name: '径向渐变', group: '生成', role: 'source',
      desc: '中心亮到边缘暗，可反向，当遮罩用',
      pass: p('径向渐变', GEN_GRADIENT)
    },
    {
      id: 'gen-stripes', name: '斜向条纹', group: '生成', role: 'source',
      desc: '角度 / 频率 / 占空比可调，做扫描线或分段',
      pass: p('斜向条纹', GEN_STRIPES)
    },
    {
      id: 'gen-dot', name: '圆形光斑', group: '生成', role: 'source',
      desc: '软边圆点，带颜色，当光斑或衰减遮罩',
      pass: p('圆形光斑', GEN_DOT)
    },

    /* 叠加态：读上一 Pass 再输出 */
    {
      id: 'color-basic', name: '基础调色', group: '调色', role: 'filter',
      desc: '饱和度 / 对比度 / 色调 / 暗角，拿来当起点',
      pass: p('调色', COLOR_BASIC)
    },
    {
      id: 'levels', name: '色阶', group: '调色', role: 'filter',
      desc: '黑场白场 + 伽马，先把输入拉正',
      pass: p('色阶', LEVELS)
    },
    {
      id: 'gray', name: '黑白', group: '调色', role: 'filter',
      desc: '按亮度去色，可带单色调',
      pass: p('黑白', GRAY)
    },
    {
      id: 'aces', name: 'ACES 影调', group: '调色', role: 'filter',
      desc: 'HDR 画面的电影感映射，泛光之后接',
      pass: p('ACES', ACES)
    },
    {
      id: 'blur-h', name: '高斯模糊 · 横向', group: '模糊', role: 'filter',
      desc: '横向一趟；配一个纵向就是两趟模糊',
      pass: p('横向模糊', GAUSS_H)
    },
    {
      id: 'blur-v', name: '高斯模糊 · 纵向', group: '模糊', role: 'filter',
      desc: '纵向一趟，和高斯横向配对用',
      pass: p('纵向模糊', GAUSS_V)
    },
    {
      id: 'blur-zoom', name: '径向模糊', group: '模糊', role: 'filter',
      desc: '从中心向外拉伸，常用于速度感',
      pass: p('径向模糊', ZOOM_BLUR)
    },
    {
      id: 'bright', name: '亮部提取', group: '提取', role: 'filter',
      desc: '只留超过阈值的亮部，泛光的第一趟',
      pass: p('亮部提取', BRIGHT)
    },
    {
      id: 'edge', name: 'Sobel 描边', group: '提取', role: 'filter',
      desc: '按亮度梯度出线，可叠在原图上',
      pass: p('描边', EDGE)
    },
    {
      id: 'glow', name: '辉光叠加', group: '合成', role: 'filter',
      desc: '单趟泛光：阈值提亮 + 两圈采样后叠回原图',
      pass: p('辉光', GLOW)
    },
    {
      id: 'chroma', name: '色差 + 暗角', group: '风格化', role: 'filter',
      desc: '镜头色散、边缘压暗、可选扫描线',
      pass: p('色差暗角', CHROMA)
    },
    {
      id: 'pixel', name: '像素化', group: '风格化', role: 'filter',
      desc: '分块 + 色阶量化 + Bayer 抖动',
      pass: p('像素化', PIXEL)
    },
    {
      id: 'grain', name: '胶片颗粒', group: '风格化', role: 'filter',
      desc: '逐帧噪声，压一点数字感',
      pass: p('颗粒', GRAIN)
    },
    {
      id: 'wave', name: '波纹扭曲', group: '扭曲', role: 'filter',
      desc: '按半径做正弦位移，带轻微色散',
      pass: p('波纹', WAVE)
    },
    {
      id: 'displace', name: '噪声位移', group: '扭曲', role: 'filter',
      desc: '用噪声图推 UV，做热浪 / 水波扰动',
      pass: p('位移', DISPLACE, { bindings: { u_noise: { kind: 'asset', assetId: 'b:noise' } } })
    },
    {
      id: 'feedback', name: '残影反馈', group: '扭曲', role: 'filter',
      desc: '把上一帧混进来，做拖尾 / 余像',
      pass: p('残影', FEEDBACK, { bindings: { u_self: { kind: 'self' } } })
    }
  ];

  const GROUPS = ['生成', '调色', '模糊', '提取', '合成', '风格化', '扭曲'];

  /* --------------------------- 用户自己存的模板 --------------------------- */
  /* 存在浏览器本地（localStorage），不写进仓库；「存为 Pass」按钮往里加 */

  const USER_KEY = 'shader-lab:passes';

  function userLoad() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (t) {
        return t && typeof t.id === 'string' && typeof t.code === 'string' && t.id;
      }).map(function (t) {
        return {
          id: t.id,
          name: t.name || t.id,
          group: t.group || '我的 Pass',
          role: t.role === 'source' ? 'source' : 'filter',
          desc: t.desc || '',
          mine: true,
          pass: p(t.name || t.id, t.code)
        };
      });
    } catch (e) {
      return [];
    }
  }

  let USERS = userLoad();

  function userPersist() {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(USERS.map(function (t) {
        return { id: t.id, name: t.name, group: t.group, role: t.role, desc: t.desc, code: t.pass.code };
      })));
      return true;
    } catch (e) {
      return false;
    }
  }

  function userSlug(name) {
    const base = String(name || '').toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    // 中文名洗不出可用字符，就用时间戳兜底
    const seed = base || ('p' + Date.now().toString(36).slice(-5));
    let id = 'my-' + seed;
    let n = 2;
    while (SL.passes.has(id)) { id = 'my-' + seed + '-' + n; n++; }
    return id;
  }

  /** 把一段代码存成模板；同 id 则覆盖，返回保存后的模板 */
  function userSave(opt) {
    const name = String((opt && opt.name) || '').trim() || '未命名 Pass';
    // 同名视为「更新」：沿用已有 id，避免出现 my-xxx-2、my-xxx-3
    const same = USERS.filter(function (t) { return t.name === name; })[0];
    const id = (opt && opt.id) || (same && same.id) || userSlug(name);
    const tpl = {
      id: id,
      name: name,
      group: (opt && opt.group) || '我的 Pass',
      role: opt && opt.role === 'source' ? 'source' : 'filter',
      desc: (opt && opt.desc) || '',
      mine: true,
      pass: p(name, (opt && opt.code) || '')
    };
    const at = USERS.findIndex(function (t) { return t.id === id; });
    if (at >= 0) USERS[at] = tpl; else USERS.push(tpl);
    if (!userPersist()) SL.ui.toast('存不进浏览器本地（可能是隐私模式）', 'bad');
    return tpl;
  }

  function userRemove(id) {
    const at = USERS.findIndex(function (t) { return t.id === id; });
    if (at < 0) return false;
    USERS.splice(at, 1);
    return userPersist();
  }

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
    /** 内置 + 用户自定义（用户在前，方便找） */
    all: function () { return USERS.concat(LIST); },
    ids: LIST.map(function (t) { return t.id; }),
    has: function (id) { return USERS.some(function (t) { return t.id === id; }) || LIST.some(function (t) { return t.id === id; }); },
    get: function (id) {
      return USERS.filter(function (t) { return t.id === id; })[0]
        || LIST.filter(function (t) { return t.id === id; })[0] || null;
    },
    byGroup: function (group) { return LIST.filter(function (t) { return t.group === group; }); },
    /** 用户自己存的模板 */
    mine: function () { return USERS.slice(); },
    save: userSave,
    remove: userRemove,
    /** 生成可插入的 pass 列表（一模板一 Pass；不带 id，由调用方分配） */
    build: function (id) {
      const t = SL.passes.get(id);
      if (!t) return [];
      const src = t.pass;
      return [{
        name: src.name,
        code: src.code,
        enabled: true,
        role: t.role === 'source' ? 'source' : 'filter',
        format: src.format || 'rgba8',
        scale: src.scale || 1,
        filter: 'linear',
        wrap: 'clamp',
        bindings: SL.deepClone(src.bindings || {}),
        values: {}
      }];
    },
    defaultDoc: defaultDoc
  };
})(window.SL);
