// 扩展 Pass 模板：一条一个原子操作，方便自由组合。
// 这里只写 {id,name,group,role,desc,code[,bindings]}；js/passes.js 会补齐默认字段。
// 约定：不声明 u_time / u_resolution / u_t01（构建器按引用自动注入）；平方用 q*q，别用 pow(q,2.0)。
(function () {
  'use strict';

  const T = [];

  /* 平滑值噪声：多个生成类模板共用（sl_hash21 是点噪声，直接用会一块一块的） */
  const VNOISE = `
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

float vfbm(vec2 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p *= 2.02;
    amp *= 0.55;
  }
  return v;
}
`;

  /* ============================== 颜色 ============================== */

  T.push({
    id: 'hue-shift', name: '改色相', group: '颜色', role: 'filter',
    desc: '整体旋转色相，可定时变色的氛围片',
    code: `
uniform float u_shift;  // @range -1 1 @step 0.01 @default 0.15 @label 色相偏移
uniform float u_sat;    // @range 0 1 @step 0.01 @default 1 @label 饱和度保留

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 g = vec3(y);
  vec3 base = mix(g, c, u_sat);
  // 旋转色相：把颜色当向量绕灰轴转
  float a = u_shift * 6.28318;
  float cs = cos(a), sn = sin(a);
  mat3 rot = mat3(
    0.299 + 0.701 * cs + 0.168 * sn, 0.587 - 0.587 * cs + 0.330 * sn, 0.114 - 0.114 * cs - 0.497 * sn,
    0.299 - 0.299 * cs - 0.328 * sn, 0.587 + 0.413 * cs + 0.035 * sn, 0.114 - 0.114 * cs + 0.292 * sn,
    0.299 - 0.300 * cs + 1.250 * sn, 0.587 - 0.588 * cs - 1.050 * sn, 0.114 + 0.886 * cs - 0.203 * sn
  );
  fragColor = vec4(clamp(rot * base, 0.0, 1.0), texture(u_tex, vUv).a);
}
`
  });

  T.push({
    id: 'saturate', name: '饱和度', group: '颜色', role: 'filter',
    desc: '只动饱和度，0 = 黑白，2 = 浓郁',
    code: `
uniform float u_amount; // @range 0 2 @step 0.01 @default 1.2 @label 饱和度

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  fragColor = vec4(clamp(mix(vec3(y), s.rgb, u_amount), 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'contrast', name: '对比度', group: '颜色', role: 'filter',
    desc: '以 0.5 灰为中点拉伸，暗部不会整体发黑',
    code: `
uniform float u_amount; // @range 0 2 @step 0.01 @default 1.15 @label 对比度
uniform float u_pivot;  // @range 0 1 @step 0.01 @default 0.5 @label 中点

void main() {
  vec4 s = texture(u_tex, vUv);
  vec3 c = (s.rgb - u_pivot) * u_amount + u_pivot;
  fragColor = vec4(clamp(c, 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'brightness', name: '亮度', group: '颜色', role: 'filter',
    desc: '整体加减亮度，线性、不改变对比',
    code: `
uniform float u_amount; // @range -0.5 0.5 @step 0.005 @default 0.05 @label 亮度

void main() {
  vec4 s = texture(u_tex, vUv);
  fragColor = vec4(clamp(s.rgb + u_amount, 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'temperature', name: '色温', group: '颜色', role: 'filter',
    desc: '负值偏冷、正值偏暖，顺手压一点绿',
    code: `
uniform float u_amount; // @range -1 1 @step 0.01 @default 0.2 @label 冷暖

void main() {
  vec4 s = texture(u_tex, vUv);
  vec3 warm = vec3(0.10, 0.02, -0.10) * u_amount;
  vec3 c = s.rgb + warm + vec3(0.0, 0.015 * abs(u_amount), 0.0);
  fragColor = vec4(clamp(c, 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'sepia', name: '棕褐', group: '颜色', role: 'filter',
    desc: '老照片 / 羊皮纸色调',
    code: `
uniform float u_amount; // @range 0 1 @step 0.01 @default 1 @label 强度

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  vec3 tone = vec3(y * 1.07 + 0.06, y * 0.94 + 0.02, y * 0.72 - 0.02);
  fragColor = vec4(mix(s.rgb, clamp(tone, 0.0, 1.0), u_amount), s.a);
}
`
  });

  T.push({
    id: 'invert', name: '反相', group: '颜色', role: 'filter',
    desc: '取反，做遮罩 / 负片',
    code: `
uniform float u_amount; // @range 0 1 @step 0.01 @default 1 @label 强度

void main() {
  vec4 s = texture(u_tex, vUv);
  fragColor = vec4(mix(s.rgb, 1.0 - s.rgb, u_amount), s.a);
}
`
  });

  T.push({
    id: 'posterize', name: '色阶量化', group: '颜色', role: 'filter',
    desc: '把连续色阶压成 N 级，做海报 / 像素风',
    code: `
uniform float u_steps;  // @range 2 16 @step 1 @default 5 @label 级数
uniform float u_gamma;  // @range 0.5 2 @step 0.01 @default 1 @label 前置伽马

void main() {
  vec4 s = texture(u_tex, vUv);
  vec3 c = pow(s.rgb, vec3(u_gamma));
  c = floor(c * u_steps + 0.5) / u_steps;
  fragColor = vec4(c, s.a);
}
`
  });

  T.push({
    id: 'threshold', name: '二值化', group: '颜色', role: 'filter',
    desc: '按亮度切成黑白，做剪影 / 遮罩',
    code: `
uniform float u_level;  // @range 0 1 @step 0.01 @default 0.5 @label 阈值
uniform float u_soft;   // @range 0.001 0.3 @step 0.001 @default 0.02 @label 过渡

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  float v = smoothstep(u_level - u_soft, u_level + u_soft, y);
  fragColor = vec4(vec3(v), s.a);
}
`
  });

  T.push({
    id: 'duotone', name: '双色调', group: '颜色', role: 'filter',
    desc: '暗部一个色、亮部一个色，中间线性过渡',
    code: `
uniform vec3 u_dark;   // @color @default 0.06 0.07 0.14 @label 暗部颜色
uniform vec3 u_light;  // @color @default 0.95 0.72 0.38 @label 亮部颜色

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  fragColor = vec4(mix(u_dark, u_light, y), s.a);
}
`
  });

  T.push({
    id: 'channel-mix', name: '通道混合', group: '颜色', role: 'filter',
    desc: '分别乘 RGB 权重，快速做偏色 / 提纯',
    code: `
uniform vec3 u_gain;    // @range 0 2 @step 0.01 @default 1 1 1 @label 通道增益

void main() {
  vec4 s = texture(u_tex, vUv);
  fragColor = vec4(clamp(s.rgb * u_gain, 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'vibrance', name: '鲜艳度', group: '颜色', role: 'filter',
    desc: '只提升低饱和区域，避免已经很艳的地方过饱和',
    code: `
uniform float u_amount; // @range 0 2 @step 0.01 @default 1.4 @label 鲜艳度

void main() {
  vec4 s = texture(u_tex, vUv);
  float mx = max(s.r, max(s.g, s.b));
  float mn = min(s.r, min(s.g, s.b));
  float sat = mx - mn;
  float w = 1.0 - smoothstep(0.15, 0.75, sat);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  vec3 boosted = mix(vec3(y), s.rgb, u_amount);
  fragColor = vec4(clamp(mix(s.rgb, boosted, w), 0.0, 1.0), s.a);
}
`
  });

  /* ============================== 边缘 ============================== */

  T.push({
    id: 'inner-glow', name: '内边缘发光', group: '边缘', role: 'filter',
    desc: '在 alpha 形状的内侧描一圈光，像 UI 面板的呼吸边',
    code: `
uniform float u_width;  // @range 0.005 0.2 @step 0.005 @default 0.05 @label 宽度
uniform float u_gain;   // @range 0 3 @step 0.01 @default 1.2 @label 强度
uniform vec3  u_color;  // @color @default 1 0.84 0.55 @label 颜色

void main() {
  vec4 s = texture(u_tex, vUv);
  float w = u_width;
  // 看「自己这一圈」往内收之后 alpha 掉多少 → 内边缘
  float inner = 0.0;
  inner += s.a - texture(u_tex, vUv + vec2(w, 0.0)).a;
  inner += s.a - texture(u_tex, vUv - vec2(w, 0.0)).a;
  inner += s.a - texture(u_tex, vUv + vec2(0.0, w)).a;
  inner += s.a - texture(u_tex, vUv - vec2(0.0, w)).a;
  inner = clamp(inner * 0.25, 0.0, 1.0);
  // 不透明图没有 alpha 边，退回用亮度梯度找边（这样贴图 / 色条也能出光）
  float e = 0.0;
  e += abs(sl_luma(s.rgb) - sl_luma(texture(u_tex, vUv + vec2(w, 0.0)).rgb));
  e += abs(sl_luma(s.rgb) - sl_luma(texture(u_tex, vUv - vec2(w, 0.0)).rgb));
  e += abs(sl_luma(s.rgb) - sl_luma(texture(u_tex, vUv + vec2(0.0, w)).rgb));
  e += abs(sl_luma(s.rgb) - sl_luma(texture(u_tex, vUv - vec2(0.0, w)).rgb));
  e = clamp(e * 0.5, 0.0, 1.0);
  float edge = max(inner, e);
  vec3 c = s.rgb + u_color * edge * u_gain * 4.0;
  fragColor = vec4(c, s.a);
}
`
  });

  T.push({
    id: 'outer-glow', name: '外边缘发光', group: '边缘', role: 'filter',
    desc: '从形状往外扩一圈光晕，透明底上最明显',
    code: `
uniform float u_width;  // @range 0.005 0.25 @step 0.005 @default 0.07 @label 宽度
uniform float u_gain;   // @range 0 3 @step 0.01 @default 1.0 @label 强度
uniform vec3  u_color;  // @color @default 1 0.78 0.42 @label 颜色
uniform float u_fill;   // @range 0 1 @step 0.01 @default 1 @label 内部保留

void main() {
  vec4 s = texture(u_tex, vUv);
  float w = u_width;
  float a = 0.0;
  a += texture(u_tex, vUv + vec2(w, 0.0)).a;
  a += texture(u_tex, vUv - vec2(w, 0.0)).a;
  a += texture(u_tex, vUv + vec2(0.0, w)).a;
  a += texture(u_tex, vUv - vec2(0.0, w)).a;
  a += texture(u_tex, vUv + vec2(w * 0.7, w * 0.7)).a;
  a += texture(u_tex, vUv - vec2(w * 0.7, w * 0.7)).a;
  a = clamp(a / 6.0 - s.a, 0.0, 1.0);
  vec3 glow = u_color * a * u_gain * 3.0;
  vec3 c = s.rgb * u_fill + glow;
  fragColor = vec4(c, clamp(s.a * u_fill + a * u_gain, 0.0, 1.0));
}
`
  });

  T.push({
    id: 'edge-sketch', name: '素描', group: '边缘', role: 'filter',
    desc: 'Sobel 出线 → 反相 → 叠一层纸纹，铅笔稿的感觉',
    code: `
uniform float u_strength; // @range 0 3 @step 0.01 @default 1.2 @label 线条强度
uniform float u_paper;    // @range 0 1 @step 0.01 @default 0.35 @label 纸纹
uniform vec3  u_ink;      // @color @default 0.16 0.16 0.18 @label 墨色

void main() {
  vec2 px = 1.0 / u_resolution;
  float l0 = sl_luma(texture(u_tex, vUv).rgb);
  float lx = sl_luma(texture(u_tex, vUv + vec2(px.x, 0.0)).rgb) - sl_luma(texture(u_tex, vUv - vec2(px.x, 0.0)).rgb);
  float ly = sl_luma(texture(u_tex, vUv + vec2(0.0, px.y)).rgb) - sl_luma(texture(u_tex, vUv - vec2(0.0, px.y)).rgb);
  float e = clamp(sqrt(lx * lx + ly * ly) * 6.0 * u_strength, 0.0, 1.0);
  float paper = sl_hash21(floor(vUv * u_resolution * 0.5)) * 0.5 + 0.75;
  vec3 c = mix(vec3(1.0) * paper, u_ink, e);
  c = mix(c, c * (0.55 + 0.45 * paper), u_paper);
  fragColor = vec4(c, 1.0);
}
`
  });

  T.push({
    id: 'rim-light', name: '边缘光', group: '边缘', role: 'filter',
    desc: '按法线近似方向提亮边缘，做背光轮廓',
    code: `
uniform vec2  u_dir;    // @range -1 1 @step 0.01 @default 0.7 0.7 @label 光方向
uniform float u_gain;   // @range 0 3 @step 0.01 @default 1 @label 强度
uniform vec3  u_color;  // @color @default 1 0.9 0.7 @label 颜色
uniform float u_width;  // @range 0.002 0.05 @step 0.001 @default 0.01 @label 宽度

void main() {
  vec4 s = texture(u_tex, vUv);
  vec2 d = normalize(u_dir + 1e-5) * u_width;
  float ahead = sl_luma(texture(u_tex, vUv + d).rgb) * texture(u_tex, vUv + d).a;
  float here = sl_luma(s.rgb) * s.a;
  float rim = clamp((here - ahead) * 3.0, 0.0, 1.0);
  fragColor = vec4(s.rgb + u_color * rim * u_gain, s.a);
}
`
  });

  T.push({
    id: 'emboss', name: '浮雕', group: '边缘', role: 'filter',
    desc: '方向差分转灰度，做石雕 / 压印纹理',
    code: `
uniform float u_amount; // @range 0 3 @step 0.01 @default 1 @label 强度
uniform float u_mix;    // @range 0 1 @step 0.01 @default 1 @label 与原图混合

void main() {
  vec2 px = 1.0 / u_resolution;
  float a = sl_luma(texture(u_tex, vUv - px).rgb);
  float b = sl_luma(texture(u_tex, vUv + px).rgb);
  float e = (a - b) * 2.0 * u_amount + 0.5;
  vec3 c = mix(texture(u_tex, vUv).rgb, vec3(e), u_mix);
  fragColor = vec4(c, texture(u_tex, vUv).a);
}
`
  });

  T.push({
    id: 'sharpen', name: '锐化', group: '边缘', role: 'filter',
    desc: 'USM 锐化：原图 - 模糊 = 高频，加回去',
    code: `
uniform float u_amount; // @range 0 3 @step 0.01 @default 0.8 @label 强度
uniform float u_radius; // @range 0.5 6 @step 0.1 @default 1.6 @label 半径

void main() {
  vec2 px = (1.0 / u_resolution) * u_radius;
  vec3 c = texture(u_tex, vUv).rgb;
  vec3 blur = texture(u_tex, vUv + vec2(px.x, 0.0)).rgb
            + texture(u_tex, vUv - vec2(px.x, 0.0)).rgb
            + texture(u_tex, vUv + vec2(0.0, px.y)).rgb
            + texture(u_tex, vUv - vec2(0.0, px.y)).rgb;
  blur *= 0.25;
  fragColor = vec4(clamp(c + (c - blur) * u_amount, 0.0, 1.0), texture(u_tex, vUv).a);
}
`
  });

  /* ============================== 模糊 ============================== */

  T.push({
    id: 'blur-box', name: '方框模糊', group: '模糊', role: 'filter',
    desc: '3×3 均值，便宜的一档柔化',
    code: `
uniform float u_radius; // @range 0.5 8 @step 0.5 @default 1.5 @label 半径

void main() {
  vec2 px = (1.0 / u_resolution) * u_radius;
  vec3 s = vec3(0.0);
  s += texture(u_tex, vUv + vec2(-px.x, -px.y)).rgb;
  s += texture(u_tex, vUv + vec2( 0.0,  -px.y)).rgb;
  s += texture(u_tex, vUv + vec2( px.x, -px.y)).rgb;
  s += texture(u_tex, vUv + vec2(-px.x,  0.0 )).rgb;
  s += texture(u_tex, vUv).rgb;
  s += texture(u_tex, vUv + vec2( px.x,  0.0 )).rgb;
  s += texture(u_tex, vUv + vec2(-px.x,  px.y)).rgb;
  s += texture(u_tex, vUv + vec2( 0.0,   px.y)).rgb;
  s += texture(u_tex, vUv + vec2( px.x,  px.y)).rgb;
  fragColor = vec4(s / 9.0, texture(u_tex, vUv).a);
}
`
  });

  T.push({
    id: 'blur-motion', name: '运动模糊', group: '模糊', role: 'filter',
    desc: '沿指定方向多次采样，做速度感 / 拖影',
    code: `
uniform vec2  u_dir;    // @range -1 1 @step 0.01 @default 1 0 @label 方向
uniform float u_length; // @range 0.002 0.15 @step 0.001 @default 0.03 @label 长度
uniform float u_samples;// @range 3 24 @step 1 @default 8 @label 采样数

void main() {
  vec2 d = normalize(u_dir + 1e-5) * u_length;
  vec3 s = vec3(0.0);
  float n = max(u_samples, 3.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    float k = (float(i) / (n - 1.0)) - 0.5;
    s += texture(u_tex, vUv + d * k).rgb;
  }
  fragColor = vec4(s / n, texture(u_tex, vUv).a);
}
`
  });

  /* ============================== 图案 ============================== */

  T.push({
    id: 'halftone', name: '半调网点', group: '图案', role: 'filter',
    desc: '按亮度决定网点大小，印刷 / 波普感',
    code: `
uniform float u_scale;  // @range 40 400 @step 5 @default 130 @label 网目
uniform float u_angle;  // @range 0 180 @step 5 @default 30 @label 角度
uniform float u_mix;    // @range 0 1 @step 0.01 @default 1 @label 混合

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  float a = radians(u_angle);
  vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * vUv;
  p *= u_scale;
  vec2 g = fract(p) - 0.5;
  float d = length(g);
  // 越暗点越大
  float r = mix(0.62, 0.0, y);
  float v = smoothstep(r + 0.03, r - 0.03, d);
  vec3 c = mix(vec3(y), vec3(v), u_mix);
  fragColor = vec4(c, s.a);
}
`
  });

  T.push({
    id: 'scanlines', name: '扫描线', group: '图案', role: 'filter',
    desc: '横向细线 + 缓慢滚动，CRT 味最轻的一档',
    code: `
uniform float u_count;  // @range 60 900 @step 10 @default 300 @label 线数
uniform float u_gap;    // @range 0 0.9 @step 0.01 @default 0.35 @label 间隔
uniform float u_speed;  // @range 0 3 @step 0.05 @default 0.4 @label 滚动

void main() {
  vec4 s = texture(u_tex, vUv);
  float line = fract(vUv.y * u_count + u_time * u_speed);
  float dark = smoothstep(u_gap, u_gap + 0.25, line);
  fragColor = vec4(s.rgb * mix(0.45, 1.0, dark), s.a);
}
`
  });

  T.push({
    id: 'crt', name: '老电视', group: '图案', role: 'filter',
    desc: '桶形弯曲 + 扫描线 + 轻微色散，一个 Pass 出 CRT',
    code: `
uniform float u_curve;  // @range 0 0.4 @step 0.01 @default 0.12 @label 弯曲
uniform float u_scan;   // @range 0 1 @step 0.01 @default 0.35 @label 扫描线
uniform float u_aber;   // @range 0 0.01 @step 0.0005 @default 0.002 @label 色散

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  uv *= 1.0 + u_curve * dot(uv, uv) * 0.5;
  vec2 t = uv * 0.5 + 0.5;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 c;
  c.r = texture(u_tex, t + vec2(u_aber, 0.0)).r;
  c.g = texture(u_tex, t).g;
  c.b = texture(u_tex, t - vec2(u_aber, 0.0)).b;
  float line = sin(t.y * u_resolution.y * 1.6) * 0.5 + 0.5;
  c *= mix(1.0, 0.55 + 0.45 * line, u_scan);
  fragColor = vec4(c, 1.0);
}
`
  });

  T.push({
    id: 'dither', name: '有序抖动', group: '图案', role: 'filter',
    desc: '4×4 Bayer 抖动 + 量化，做复古 8bit 渐层',
    code: `
uniform float u_levels; // @range 2 12 @step 1 @default 4 @label 色阶
uniform float u_amount; // @range 0 1 @step 0.01 @default 1 @label 抖动强度

void main() {
  vec4 s = texture(u_tex, vUv);
  int x = int(mod(gl_FragCoord.x, 4.0));
  int y = int(mod(gl_FragCoord.y, 4.0));
  float bayer[16] = float[16](
    0.0,  8.0,  2.0, 10.0,
   12.0,  4.0, 14.0,  6.0,
    3.0, 11.0,  1.0,  9.0,
   15.0,  7.0, 13.0,  5.0
  );
  float d = bayer[y * 4 + x] / 16.0 - 0.5;
  vec3 c = s.rgb + d * (u_amount / u_levels);
  c = floor(c * u_levels + 0.5) / u_levels;
  fragColor = vec4(clamp(c, 0.0, 1.0), s.a);
}
`
  });

  T.push({
    id: 'crosshatch', name: '交叉排线', group: '图案', role: 'filter',
    desc: '两组斜线按亮度叠，做版画 / 手绘阴影',
    code: `
uniform float u_scale;  // @range 20 300 @step 5 @default 110 @label 线距
uniform float u_width;  // @range 0.02 0.5 @step 0.01 @default 0.18 @label 线宽
uniform vec3  u_ink;    // @color @default 0.12 0.12 0.14 @label 墨色

void main() {
  vec4 s = texture(u_tex, vUv);
  float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  float a = fract((vUv.x + vUv.y) * u_scale);
  float b = fract((vUv.x - vUv.y) * u_scale);
  float l1 = 1.0 - smoothstep(0.0, u_width, a);
  float l2 = 1.0 - smoothstep(0.0, u_width, b);
  // 暗的地方两种线都上，亮的地方只剩一种
  float ink = max(l1 * smoothstep(0.85, 0.2, y), l2 * smoothstep(0.55, 0.05, y));
  fragColor = vec4(mix(vec3(1.0), u_ink, ink), s.a);
}
`
  });

  T.push({
    id: 'mosaic', name: '马赛克块', group: '图案', role: 'filter',
    desc: '硬边方块（不是像素化的抖动量版），做拼贴',
    code: `
uniform float u_size;   // @range 4 120 @step 1 @default 24 @label 块大小
uniform float u_gap;    // @range 0 0.3 @step 0.01 @default 0.06 @label 缝隙

void main() {
  vec2 cells = u_resolution / max(u_size, 1.0);
  vec2 cell = floor(vUv * cells);
  vec2 f = fract(vUv * cells);
  vec2 cuv = (cell + 0.5) / cells;
  vec4 s = texture(u_tex, cuv);
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  float gap = smoothstep(0.0, u_gap, edge);
  fragColor = vec4(s.rgb * mix(0.35, 1.0, gap), s.a);
}
`
  });

  T.push({
    id: 'glitch-slice', name: '故障切片', group: '故障', role: 'filter',
    desc: '随机横向切片错位 + 偶尔整行偏色',
    code: `
uniform float u_amount; // @range 0 0.15 @step 0.001 @default 0.03 @label 错位
uniform float u_rows;   // @range 4 60 @step 1 @default 16 @label 行数
uniform float u_speed;  // @range 0 20 @step 0.5 @default 6 @label 频率

void main() {
  vec2 uv = vUv;
  float row = floor(uv.y * u_rows);
  float t = floor(u_time * u_speed);
  float rnd = sl_hash21(vec2(row, t));
  float on = step(0.55, rnd);
  uv.x += (rnd - 0.5) * 2.0 * u_amount * on;
  vec4 s = texture(u_tex, uv);
  float band = step(0.85, sl_hash21(vec2(row * 3.1, t + 7.0)));
  s.rgb *= mix(vec3(1.0), vec3(1.4, 0.7, 0.9), band * 0.6);
  fragColor = s;
}
`
  });

  T.push({
    id: 'rgb-shift', name: 'RGB 分离', group: '故障', role: 'filter',
    desc: '红蓝通道左右错开，做廉价色差 / 重影',
    code: `
uniform float u_amount; // @range 0 0.05 @step 0.0005 @default 0.004 @label 偏移
uniform vec2  u_dir;    // @range -1 1 @step 0.01 @default 1 0 @label 方向
uniform float u_angle;  // @range 0 6.28 @step 0.01 @default 0 @label 旋转

void main() {
  vec4 s = texture(u_tex, vUv);
  vec2 d = normalize(u_dir + 1e-5) * u_amount;
  float cs = cos(u_angle), sn = sin(u_angle);
  d = mat2(cs, -sn, sn, cs) * d;
  vec3 c;
  c.r = texture(u_tex, vUv + d).r;
  c.g = s.g;
  c.b = texture(u_tex, vUv - d).b;
  fragColor = vec4(c, s.a);
}
`
  });

  T.push({
    id: 'dissolve', name: '溶解', group: '故障', role: 'filter',
    desc: '按噪声阈值逐块消失，做消失 / 传送',
    code: `
uniform float u_progress; // @range 0 1 @step 0.01 @default 0 @label 进度
uniform float u_scale;    // @range 4 60 @step 1 @default 18 @label 颗粒大小
uniform vec3  u_edge;     // @color @default 1 0.6 0.25 @label 边缘色

void main() {
  vec4 s = texture(u_tex, vUv);
  float n = sl_hash21(floor(vUv * u_scale * u_resolution / 100.0));
  float v = n - u_progress;
  float alive = step(0.0, v);
  float edge = smoothstep(0.0, 0.06, v) * (1.0 - step(0.06, v));
  vec3 c = s.rgb * alive + u_edge * edge;
  fragColor = vec4(c, s.a * alive);
}
`
  });

  T.push({
    id: 'vignette-pulse', name: '呼吸暗角', group: '图案', role: 'filter',
    desc: '暗角随 u_time 收放，做心跳 / 紧张感',
    code: `
uniform float u_amount; // @range 0 1 @step 0.01 @default 0.55 @label 暗角
uniform float u_speed;  // @range 0.1 4 @step 0.05 @default 1 @label 速度
uniform float u_soft;   // @range 0.2 1.5 @step 0.01 @default 0.9 @label 范围

void main() {
  vec4 s = texture(u_tex, vUv);
  float d = length(vUv - 0.5) * 1.414;
  float pulse = 0.75 + 0.25 * sin(u_time * u_speed * 6.28318);
  float v = mix(1.0, smoothstep(u_soft, u_soft * 0.35, d), u_amount * pulse);
  fragColor = vec4(s.rgb * v, s.a);
}
`
  });

  /* ============================== 扭曲 ============================== */

  T.push({
    id: 'twirl', name: '漩涡', group: '扭曲', role: 'filter',
    desc: '绕中心拧一圈，中心最强、边缘衰减',
    code: `
uniform float u_amount; // @range -6 6 @step 0.05 @default 2 @label 强度
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.5 @label 中心
uniform float u_radius; // @range 0.1 1.5 @step 0.01 @default 0.7 @label 半径

void main() {
  vec2 p = vUv - u_center;
  float r = length(p);
  float a = u_amount * (1.0 - smoothstep(0.0, u_radius, r));
  float cs = cos(a), sn = sin(a);
  vec2 q = mat2(cs, -sn, sn, cs) * p + u_center;
  fragColor = texture(u_tex, q);
}
`
  });

  T.push({
    id: 'bulge', name: '鱼眼凸起', group: '扭曲', role: 'filter',
    desc: '中心放大、四周压缩，做镜头 / 放大镜',
    code: `
uniform float u_amount; // @range -1 1 @step 0.01 @default 0.45 @label 凸起
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.5 @label 中心
uniform float u_radius; // @range 0.1 1.2 @step 0.01 @default 0.6 @label 半径

void main() {
  vec2 p = vUv - u_center;
  float r = length(p);
  float k = 1.0 - smoothstep(0.0, u_radius, r) * u_amount;
  fragColor = texture(u_tex, u_center + p * clamp(k, 0.2, 3.0));
}
`
  });

  T.push({
    id: 'pinch', name: '挤压', group: '扭曲', role: 'filter',
    desc: '往里收（反向鱼眼），做隧道 / 吸力',
    code: `
uniform float u_amount; // @range 0 1 @step 0.01 @default 0.35 @label 挤压
uniform float u_radius; // @range 0.1 1.2 @step 0.01 @default 0.8 @label 半径

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 1.414;
  float k = 1.0 + smoothstep(0.0, u_radius, r) * u_amount * 0.8;
  fragColor = texture(u_tex, 0.5 + p * k);
}
`
  });

  T.push({
    id: 'barrel', name: '桶形畸变', group: '扭曲', role: 'filter',
    desc: '整幅画面外扩，做老镜头 / 广角',
    code: `
uniform float u_amount; // @range -0.5 0.5 @step 0.01 @default 0.12 @label 畸变

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  p *= 1.0 + u_amount * r2;
  vec2 uv = p * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  fragColor = texture(u_tex, uv);
}
`
  });

  T.push({
    id: 'mirror-x', name: '镜像', group: '扭曲', role: 'filter',
    desc: '左右 / 上下镜像一半，做对称构图',
    code: `
uniform float u_axis;   // @range 0 1 @step 1 @default 0 @label 轴向 0=左右 1=上下

void main() {
  vec2 uv = vUv;
  if (u_axis < 0.5) {
    uv.x = mix(uv.x, 1.0 - uv.x, step(0.5, uv.x));
  } else {
    uv.y = mix(uv.y, 1.0 - uv.y, step(0.5, uv.y));
  }
  fragColor = texture(u_tex, uv);
}
`
  });

  T.push({
    id: 'kaleido', name: '万花筒', group: '扭曲', role: 'filter',
    desc: '把角度折叠成 N 份，做对称花纹',
    code: `
uniform float u_segments; // @range 2 16 @step 1 @default 6 @label 份数
uniform float u_zoom;     // @range 0.3 2 @step 0.01 @default 0.9 @label 缩放
uniform float u_rot;      // @range 0 6.28 @step 0.01 @default 0 @label 旋转

void main() {
  vec2 p = (vUv - 0.5) * 2.0 * u_zoom;
  float a = atan(p.y, p.x) + u_rot;
  float seg = 6.28318 / max(u_segments, 2.0);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  float r = length(p);
  vec2 q = vec2(cos(a), sin(a)) * r;
  fragColor = texture(u_tex, q * 0.5 + 0.5);
}
`
  });

  T.push({
    id: 'tiles', name: '平铺', group: '扭曲', role: 'filter',
    desc: '缩小后重复 N×N 次，做贴图底纹',
    code: `
uniform float u_count;  // @range 1 12 @step 1 @default 3 @label 份数
uniform float u_gap;    // @range 0 0.2 @step 0.005 @default 0 @label 间隔
uniform float u_flip;   // @range 0 1 @step 1 @default 0 @label 交错翻转

void main() {
  vec2 t = vUv * u_count;
  vec2 cell = floor(t);
  vec2 f = fract(t) - 0.5;
  if (u_flip > 0.5 && mod(cell.x + cell.y, 2.0) > 0.5) f.x = -f.x;
  vec2 uv = f + 0.5;
  float inTile = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float edge = smoothstep(0.0, u_gap + 1e-4, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  fragColor = texture(u_tex, uv) * inTile * edge;
}
`
  });

  T.push({
    id: 'uv-scroll', name: 'UV 滚动', group: '扭曲', role: 'filter',
    desc: '横向 / 纵向无限滚动，做流动背景',
    code: `
uniform vec2  u_speed;  // @range -1 1 @step 0.01 @default 0.15 0 @label 速度
uniform float u_tile;   // @range 0 1 @step 1 @default 1 @label 平铺重复

void main() {
  vec2 uv = vUv + u_speed * u_time * 0.2;
  if (u_tile > 0.5) uv = fract(uv);
  fragColor = texture(u_tex, uv);
}
`
  });

  /* ============================== 生成 ============================== */

  T.push({
    id: 'gen-plasma', name: '等离子', group: '生成', role: 'source',
    desc: '三组正弦叠加，经典 plasma 底',
    code: `
uniform float u_scale;  // @range 1 12 @step 0.1 @default 4 @label 密度
uniform float u_speed;  // @range 0 3 @step 0.05 @default 0.8 @label 速度
uniform vec3  u_a;      // @color @default 0.12 0.35 0.9 @label 冷色
uniform vec3  u_b;      // @color @default 0.85 0.35 0.55 @label 暖色

void main() {
  vec2 p = (vUv - 0.5) * u_scale;
  float t = u_time * u_speed;
  float v = sin(p.x + t) + sin(p.y * 1.3 - t * 0.7);
  v += sin((p.x + p.y) * 0.8 + t * 1.3);
  v += sin(length(p) * 2.2 - t * 1.7);
  float k = v * 0.25 + 0.5;
  vec3 c = mix(u_a, u_b, clamp(k, 0.0, 1.0));
  fragColor = vec4(c, 1.0);
}
`
  });

  T.push({
    id: 'gen-fire', name: '火焰', group: '生成', role: 'source',
    desc: '平滑 FBM 竖向卷动 + 径向收缩，底部亮顶部散',
    code: VNOISE + `
uniform float u_speed;  // @range 0 3 @step 0.05 @default 1 @label 速度
uniform float u_scale;  // @range 2 16 @step 0.1 @default 5 @label 火苗密度
uniform float u_width;  // @range 0.1 0.8 @step 0.01 @default 0.42 @label 火柱宽
uniform vec3  u_hot;    // @color @default 1 0.85 0.35 @label 火心
uniform vec3  u_cool;   // @color @default 0.9 0.2 0.05 @label 外焰

void main() {
  vec2 uv = vUv;
  float t = u_time * u_speed;
  // 往上卷的坐标：越往上越快
  vec2 p = vec2(uv.x * u_scale, uv.y * u_scale * 0.9 - t * 1.8);
  float warp = vfbm(p * 1.7 + vec2(0.0, t * 0.6));
  float n = vfbm(p + vec2(warp * 0.9, 0.0));
  // 竖直方向的火柱：底部宽、顶部收
  float w = u_width * (1.0 - uv.y * 0.75);
  float column = smoothstep(w, w * 0.2, abs(uv.x - 0.5));
  float body = smoothstep(0.32, 0.78, n + column * 0.35 - uv.y * 0.55);
  body *= smoothstep(0.0, 0.12, uv.y) * (1.0 - smoothstep(0.72, 1.0, uv.y));
  vec3 c = mix(u_cool, u_hot, smoothstep(0.15, 0.9, body));
  fragColor = vec4(c * body * 1.6, 1.0);
}
`
  });

  T.push({
    id: 'gen-bubbles', name: '气泡', group: '生成', role: 'source',
    desc: '网格里随机圆，带上浮与边缘高光',
    code: `
uniform float u_count;  // @range 4 30 @step 1 @default 12 @label 数量
uniform float u_speed;  // @range 0 3 @step 0.05 @default 0.7 @label 上浮速度
uniform float u_size;   // @range 0.02 0.4 @step 0.01 @default 0.14 @label 大小
uniform vec3  u_color;  // @color @default 0.85 0.95 1 @label 颜色

void main() {
  float cells = max(u_count, 4.0);
  vec2 g = vUv * vec2(cells, cells * 0.6);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float rnd = sl_hash21(cell);
  vec2 off = vec2((rnd - 0.5) * 0.5, fract(rnd * 13.3 + u_time * u_speed * (0.4 + rnd)) - 0.5);
  vec2 p = f - off;
  float r = u_size * (0.5 + rnd);
  float d = length(p);
  float ring = smoothstep(r, r * 0.82, d) * smoothstep(r * 0.55, r * 0.95, d);
  float hi = smoothstep(0.16 * r, 0.0, length(p - vec2(-0.28, 0.28) * r));
  fragColor = vec4(u_color * (ring * 0.85 + hi * 1.2), 1.0);
}
`
  });

  T.push({
    id: 'gen-stars', name: '星空', group: '生成', role: 'source',
    desc: '分层随机点 + 闪烁，当背景看',
    code: `
uniform float u_density; // @range 0.2 3 @step 0.05 @default 1 @label 密度
uniform float u_twinkle; // @range 0 1 @step 0.01 @default 0.6 @label 闪烁
uniform vec3  u_color;   // @color @default 0.85 0.9 1 @label 星色

void main() {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float k = 12.0 + float(i) * 26.0;
    vec2 g = vUv * k * u_density;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float rnd = sl_hash21(cell + float(i) * 7.7);
    if (rnd > 0.82) {
      vec2 off = vec2(sl_hash21(cell + 1.3) - 0.5, sl_hash21(cell + 3.1) - 0.5) * 0.6;
      float d = length(f - off);
      float tw = 1.0 - u_twinkle * 0.5 * (0.5 + 0.5 * sin(u_time * (1.5 + rnd * 4.0) + rnd * 40.0));
      c += u_color * smoothstep(0.14, 0.0, d) * tw * (0.5 + rnd * 0.7);
    }
  }
  float bg = 0.02 + 0.03 * vUv.y;
  fragColor = vec4(vec3(bg) + c, 1.0);
}
`
  });

  T.push({
    id: 'gen-lightning', name: '闪电', group: '生成', role: 'source',
    desc: '插值折线电弧 + 辉光，每帧换一次形状',
    code: `
uniform float u_speed;  // @range 0.5 10 @step 0.1 @default 4 @label 频率
uniform float u_segs;   // @range 4 40 @step 1 @default 14 @label 段数
uniform float u_glow;   // @range 0 2 @step 0.01 @default 1 @label 辉光
uniform vec3  u_color;  // @color @default 0.8 0.9 1 @label 颜色

float rnd(float i, float seed) {
  return sl_hash21(vec2(i, seed));
}

void main() {
  float seed = floor(u_time * u_speed);
  float y = vUv.y * u_segs;
  float i0 = floor(y);
  float f = fract(y);
  // 相邻两段中心做插值 → 连续的折线，而不是一段一段的方块
  float x0 = 0.5 + (rnd(i0, seed) - 0.5) * 0.34;
  float x1 = 0.5 + (rnd(i0 + 1.0, seed) - 0.5) * 0.34;
  float cx = mix(x0, x1, smoothstep(0.0, 1.0, f));
  float d = abs(vUv.x - cx);
  float core = smoothstep(0.006, 0.0, d);
  float glow = smoothstep(0.08, 0.0, d) * u_glow;
  float flick = 0.7 + 0.3 * sin(u_time * 24.0 + seed);
  float v = (core * 2.6 + glow) * flick;
  fragColor = vec4(u_color * v, 1.0);
}
`
  });

  T.push({
    id: 'gen-caustics', name: '水焦散', group: '生成', role: 'source',
    desc: '取噪声等值线的细亮边，两层叠加，像水底光纹',
    code: VNOISE + `
uniform float u_scale;  // @range 2 20 @step 0.1 @default 7 @label 密度
uniform float u_speed;  // @range 0 2 @step 0.05 @default 0.45 @label 流动
uniform float u_width;  // @range 0.01 0.4 @step 0.01 @default 0.12 @label 细线宽
uniform vec3  u_color;  // @color @default 0.75 0.92 1 @label 颜色

float caustic(vec2 p, float w) {
  // 取噪声接近 0.5 的那条等值线：细、弯、像水下的光纹
  float n = vnoise(p);
  return smoothstep(w, 0.0, abs(n - 0.5));
}

void main() {
  vec2 p = vUv * u_scale;
  float t = u_time * u_speed;
  float a = caustic(p + vec2(t * 0.5, t * 0.3), u_width * 0.5);
  float b = caustic(p * 1.6 - vec2(t * 0.4, t * 0.6), u_width * 0.4);
  float v = clamp(a * 0.9 + b * 0.7, 0.0, 1.4);
  fragColor = vec4(u_color * v, 1.0);
}
`
  });

  T.push({
    id: 'gen-smoke', name: '烟', group: '生成', role: 'source',
    desc: '平滑 FBM 缓慢上飘，做迷雾 / 浓烟',
    code: VNOISE + `
uniform float u_speed;  // @range 0 1 @step 0.01 @default 0.12 @label 速度
uniform float u_scale;  // @range 1 10 @step 0.1 @default 2.5 @label 尺度
uniform float u_dense;  // @range 0 1 @step 0.01 @default 0.4 @label 浓度
uniform vec3  u_color;  // @color @default 0.78 0.8 0.84 @label 烟色

void main() {
  vec2 p = vUv * u_scale;
  p.y -= u_time * u_speed;
  p.x += sin(p.y * 1.3 + u_time * 0.2) * 0.35;
  float v = vfbm(p);
  float a = smoothstep(0.62 - u_dense * 0.45, 1.05, v);
  fragColor = vec4(u_color * a, 1.0);
}
`
  });

  T.push({
    id: 'gen-rays', name: '体积光', group: '生成', role: 'source',
    desc: '从一点放射的光束，叠加噪声起灰',
    code: `
uniform vec2  u_center; // @range 0 1 @step 0.01 @default 0.5 0.15 @label 光源
uniform float u_count;  // @range 4 40 @step 1 @default 16 @label 光束数
uniform float u_speed;  // @range 0 1 @step 0.01 @default 0.12 @label 旋转
uniform vec3  u_color;  // @color @default 1 0.9 0.7 @label 颜色

void main() {
  vec2 p = vUv - u_center;
  float a = atan(p.y, p.x) + u_time * u_speed;
  float r = length(p);
  float beams = 0.5 + 0.5 * sin(a * u_count);
  beams = pow(beams, 3.0);
  float fall = smoothstep(1.0, 0.0, r);
  float dust = 0.85 + 0.15 * sl_hash21(floor(vUv * 300.0));
  vec3 c = u_color * beams * fall * dust;
  fragColor = vec4(c, 1.0);
}
`
  });

  T.push({
    id: 'gen-rain', name: '雨', group: '生成', role: 'source',
    desc: '斜向细线 + 轻微闪烁，做雨幕',
    code: `
uniform float u_speed;  // @range 0 4 @step 0.05 @default 1.6 @label 速度
uniform float u_count;  // @range 20 300 @step 5 @default 90 @label 密度
uniform float u_tilt;   // @range -0.5 0.5 @step 0.01 @default 0.12 @label 倾斜
uniform vec3  u_color;  // @color @default 0.75 0.82 0.95 @label 颜色

void main() {
  vec2 uv = vUv;
  uv.x += uv.y * u_tilt;
  uv.y -= u_time * u_speed;
  vec2 g = vec2(uv.x * u_count, uv.y * u_count * 0.35);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float rnd = sl_hash21(cell);
  float on = step(0.72, rnd);
  float line = smoothstep(0.12, 0.0, abs(f.x - 0.5)) * smoothstep(0.0, 0.3, f.y) * on;
  fragColor = vec4(u_color * line, 1.0);
}
`
  });

  T.push({
    id: 'gen-grid', name: '网格', group: '生成', role: 'source',
    desc: '均分细线网格，可做背景 / 参考线',
    code: `
uniform float u_count;  // @range 2 60 @step 1 @default 16 @label 格数
uniform float u_width;  // @range 0.005 0.2 @step 0.005 @default 0.04 @label 线宽
uniform vec3  u_color;  // @color @default 0.35 0.5 0.8 @label 线色

void main() {
  vec2 g = fract(vUv * u_count);
  float d = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
  float v = smoothstep(u_width, 0.0, d);
  fragColor = vec4(u_color * v, 1.0);
}
`
  });

  T.push({
    id: 'gen-checker', name: '棋盘', group: '生成', role: 'source',
    desc: '透明底棋盘，当遮罩 / UV 参考',
    code: `
uniform float u_count; // @range 2 64 @step 1 @default 8 @label 格数
uniform vec3  u_a;     // @color @default 0.9 0.9 0.92 @label 亮格
uniform vec3  u_b;     // @color @default 0.42 0.45 0.5 @label 暗格

void main() {
  vec2 c = floor(vUv * u_count);
  float k = mod(c.x + c.y, 2.0);
  fragColor = vec4(mix(u_a, u_b, k), 1.0);
}
`
  });

  T.push({
    id: 'gen-noise-grain', name: '噪点', group: '生成', role: 'source',
    desc: '逐像素随机，当颗粒 / 抖动源',
    code: `
uniform float u_scale;  // @range 0.5 8 @step 0.1 @default 1 @label 颗粒大小
uniform float u_amount; // @range 0 1 @step 0.01 @default 0.5 @label 强度

void main() {
  vec2 p = floor(vUv * u_resolution / max(u_scale, 0.5));
  float n = sl_hash21(p + u_time * 7.0);
  fragColor = vec4(vec3(0.5 + (n - 0.5) * u_amount * 2.0), 1.0);
}
`
  });

  T.push({
    id: 'gen-wave-lines', name: '波纹线', group: '生成', role: 'source',
    desc: '正弦横线，可做水面 / 声波底纹',
    code: `
uniform float u_count;  // @range 4 80 @step 1 @default 24 @label 线数
uniform float u_amp;    // @range 0 0.2 @step 0.005 @default 0.05 @label 起伏
uniform float u_speed;  // @range 0 3 @step 0.05 @default 0.8 @label 速度
uniform vec3  u_color;  // @color @default 0.5 0.8 1 @label 颜色

void main() {
  float y = vUv.y + sin(vUv.x * 8.0 + u_time * u_speed) * u_amp;
  float line = abs(fract(y * u_count) - 0.5);
  float v = smoothstep(0.16, 0.0, line);
  fragColor = vec4(u_color * v, 1.0);
}
`
  });

  T.push({
    id: 'gen-vortex', name: '涡流', group: '生成', role: 'source',
    desc: '同心环 + 角度噪声，做传送门 / 能量漩涡',
    code: `
uniform float u_rings;  // @range 2 30 @step 1 @default 10 @label 圈数
uniform float u_speed;  // @range -2 2 @step 0.05 @default 0.6 @label 旋转
uniform vec3  u_a;      // @color @default 0.2 0.5 1 @label 内圈
uniform vec3  u_b;      // @color @default 0.9 0.4 1 @label 外圈

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x) + u_time * u_speed / max(r, 0.15);
  float rings = 0.5 + 0.5 * sin(r * u_rings * 3.14159 - a * 2.0);
  rings = pow(rings, 2.0);
  float core = smoothstep(0.35, 0.0, r);
  vec3 c = mix(u_a, u_b, clamp(r, 0.0, 1.0)) * rings + u_a * core * 1.5;
  fragColor = vec4(c, 1.0);
}
`
  });

  T.push({
    id: 'gen-sparks', name: '火星', group: '生成', role: 'source',
    desc: '稀疏亮点向外飘，做余烬 / 粒子',
    code: `
uniform float u_count;  // @range 8 60 @step 1 @default 26 @label 数量
uniform float u_speed;  // @range 0 3 @step 0.05 @default 0.8 @label 上飘
uniform vec3  u_color;  // @color @default 1 0.7 0.3 @label 颜色

void main() {
  float n = max(u_count, 8.0);
  vec3 c = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec2 g = vUv * vec2(n, n * 0.6);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float rnd = sl_hash21(cell + float(i) * 13.1);
    float life = fract(u_time * u_speed * (0.3 + rnd) + rnd);
    vec2 off = vec2(sin(rnd * 30.0 + u_time) * 0.2, life - 0.3);
    float d = length(f - off);
    float s = smoothstep(0.16, 0.0, d) * (1.0 - life);
    c += u_color * s * step(0.6, rnd);
  }
  fragColor = vec4(c * 1.6, 1.0);
}
`
  });

  /* ───────────── 合成 / 混合类 ─────────────
     统一约定：u_tex 是当前画面（上一 Pass），u_layer 是「第二输入」。
     u_layer 默认指向内置噪声图，插进管线后在「参数 / 纹理」里换成
     任何一个生成类中间态 Pass（火焰、气泡、星空…）或图库里的图。 */
  const BLEND = `
float bl_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 bl_rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float h = 0.0;
  float s = 0.0;
  if (mx > mn) {
    float d = mx - mn;
    s = l > 0.5 ? d / max(1e-5, 2.0 - mx - mn) : d / max(1e-5, mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float bl_hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 bl_hsl2rgb(vec3 hsl) {
  if (hsl.y <= 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(bl_hue2rgb(p, q, hsl.x + 1.0 / 3.0),
              bl_hue2rgb(p, q, hsl.x),
              bl_hue2rgb(p, q, hsl.x - 1.0 / 3.0));
}
`;

  /* 一个混合模板的工厂：只写混合函数体，其余样板统一生成 */
  function blendEntry(id, name, desc, amountDefault, body, opt) {
    const o = opt || {};
    const layerBinding = o.layerBinding || { kind: 'asset', assetId: 'b:noise' };
    return {
      id: id, name: name, group: '合成', role: 'filter', desc: desc,
      bindings: { u_layer: layerBinding },
      code: BLEND + `
uniform sampler2D u_layer;
uniform float u_amount;  // @range 0 2 @step 0.01 @default ${amountDefault} @label 强度
${o.glsl || ''}
void main() {
  vec3 a = texture(u_tex, vUv).rgb;
  vec3 b = texture(u_layer, vUv).rgb;
${body}
  fragColor = vec4(c, 1.0);
}
`
    };
  }

  T.push(
    blendEntry('blend-add', '加色混合', '当前画面 + 第二输入，亮部直接叠上去；适合把火焰 / 能量 / 光斑加到画面上', 0.65,
      '  vec3 c = a + b * u_amount;'),

    blendEntry('blend-screen', '滤色', '比加色柔和：1-(1-A)(1-B)，暗部几乎不变，亮部自然叠亮', 1.0,
      '  vec3 c = 1.0 - (1.0 - a) * (1.0 - b * u_amount);'),

    blendEntry('blend-multiply', '正片叠底', '相乘：画面被第二输入压暗，适合阴影 / 污渍 / 材质贴附', 1.0,
      '  vec3 c = mix(a, a * b, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-overlay', '叠加', '亮处更亮、暗处更暗，对比度最高的通用混合', 1.0,
      '  vec3 o = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), b);\n' +
      '  vec3 c = mix(a, o, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-soft-light', '柔光', '叠加的温柔版：只轻微推对比，适合做质感而不是破坏画面', 1.0,
      '  vec3 s = (1.0 - 2.0 * b) * a * a + 2.0 * b * a;\n' +
      '  vec3 c = mix(a, s, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-darken', '变暗', '逐通道取小的，第二输入是暗图案时等于「遮黑」', 1.0,
      '  vec3 c = mix(a, min(a, b), clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-lighten', '变亮', '逐通道取大的，第二输入是亮图案时等于「只留亮部」', 1.0,
      '  vec3 c = mix(a, max(a, b), clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-difference', '差值', '|A-B|，相同处变黑、边缘跳色；做「撞击 / 干扰」很好用', 1.0,
      '  vec3 c = mix(a, abs(a - b), clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-exclusion', '排除', '比差值更灰，适合低频干扰与鬼影', 1.0,
      '  vec3 c = mix(a, a + b - 2.0 * a * b, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-dodge', '颜色减淡', 'A/(1-B)：第二输入越亮，画面越爆；适合做发光核心', 1.0,
      '  vec3 c = min(vec3(1.0), a / max(vec3(1e-3), 1.0 - b));\n' +
      '  c = mix(a, c, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-burn', '颜色加深', '1-(1-A)/B：第二输入越暗，画面越焦；适合做灼烧 / 焦边', 1.0,
      '  vec3 c = clamp(1.0 - (1.0 - a) / max(vec3(1e-3), b), 0.0, 1.0);\n' +
      '  c = mix(a, c, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-hue', '取第二输入的色相', '保留当前画面的明暗，只把颜色换成第二输入的色相', 1.0,
      '  vec3 ha = bl_rgb2hsl(a);\n' +
      '  vec3 hb = bl_rgb2hsl(b);\n' +
      '  vec3 c = bl_hsl2rgb(vec3(hb.x, ha.y, ha.z));\n' +
      '  c = mix(a, c, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-sat', '取第二输入的饱和度', '明暗与色相不变，只把「颜色有多浓」换成第二输入的', 1.0,
      '  vec3 ha = bl_rgb2hsl(a);\n' +
      '  vec3 hb = bl_rgb2hsl(b);\n' +
      '  vec3 c = bl_hsl2rgb(vec3(ha.x, hb.y, ha.z));\n' +
      '  c = mix(a, c, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-lum', '取第二输入的明度', '颜色留下、亮度跟着第二输入走；做「光影贴图」很省事', 1.0,
      '  vec3 ha = bl_rgb2hsl(a);\n' +
      '  vec3 hb = bl_rgb2hsl(b);\n' +
      '  vec3 c = bl_hsl2rgb(vec3(ha.x, ha.y, hb.z));\n' +
      '  c = mix(a, c, clamp(u_amount, 0.0, 1.0));'),

    blendEntry('blend-alpha', '按第二输入的透明叠上', '第二张带 alpha 时按 alpha 叠；默认给的是图库里的「徽记」', 1.0,
      '  vec4 l = texture(u_layer, vUv);\n' +
      '  vec3 c = mix(a, l.rgb, clamp(l.a * u_amount, 0.0, 1.0));',
      { layerBinding: { kind: 'asset', assetId: 'b:sprite' } }),

    blendEntry('blend-mask', '亮度遮罩', '用第二输入的亮度当蒙版，在当前画面与本图之间过渡', 1.0,
      '  float m = smoothstep(0.0, 1.0, bl_luma(b)) * u_amount;\n' +
      '  vec3 c = mix(a, b, clamp(m, 0.0, 1.0));'),

    blendEntry('blend-displace', '按第二输入扰动画面', '拿第二输入的 R/G 当位移向量推当前画面；配合火焰 / 噪声做热浪、水面', 0.35,
      '  vec2 uv2 = vUv;\n' +
      '  vec2 off = (texture(u_layer, vUv).rg - 0.5) * 0.12 * u_amount;\n' +
      '  vec3 c = texture(u_tex, clamp(uv2 + off, 0.001, 0.999)).rgb;'),

    blendEntry('tint-flame', '火焰化', '把第二输入的亮度映射成火焰色带再叠上去；先用「火焰」中间态再挂这个', 0.9,
      '  float t = clamp(bl_luma(b) * 1.6, 0.0, 1.0);\n' +
      '  vec3 ramp = mix(vec3(0.05, 0.01, 0.0), vec3(0.95, 0.30, 0.04), smoothstep(0.0, 0.55, t));\n' +
      '  ramp = mix(ramp, vec3(1.0, 0.94, 0.62), smoothstep(0.55, 1.0, t));\n' +
      '  vec3 c = a + ramp * t * u_amount;'),

    blendEntry('tint-ice', '冰冻化', '冷色版：把第二输入的亮度映射成冰蓝 / 霜白，再叠一层冷调', 0.9,
      '  float t = clamp(bl_luma(b) * 1.5, 0.0, 1.0);\n' +
      '  vec3 ramp = mix(vec3(0.02, 0.05, 0.12), vec3(0.35, 0.75, 1.0), smoothstep(0.0, 0.6, t));\n' +
      '  ramp = mix(ramp, vec3(0.92, 0.99, 1.0), smoothstep(0.6, 1.0, t));\n' +
      '  vec3 c = mix(a, a * vec3(0.82, 0.94, 1.08), 0.6) + ramp * t * u_amount;'),

    blendEntry('tint-neon', '霓虹化', '把第二输入的高亮部分染色成霓虹光，适合扫描线 / 网格 / 符文', 1.1,
      '  float t = clamp(bl_luma(b) * 1.4, 0.0, 1.0);\n' +
      '  vec3 ramp = mix(vec3(0.02, 0.0, 0.08), vec3(0.55, 0.10, 1.0), smoothstep(0.0, 0.6, t));\n' +
      '  ramp = mix(ramp, vec3(0.35, 0.98, 1.0), smoothstep(0.6, 1.0, t));\n' +
      '  vec3 c = a * 0.75 + ramp * t * u_amount;')
  );

  /* ───────────── 粒子类 ─────────────
     没有顶点缓冲 / compute / 多渲染目标，所以粒子是「每像素解析求值」：
     每颗粒子的出生相位、方向、速度都由 hash 决定，位置用解析运动方程算出来
     （p = p0 + v·t + ½g·t²），再按距离累加光斑。全部只读 u_time，无状态。 */
  function particleEntry(id, name, desc, d, extra) {
    const o = Object.assign({
      count: 24, life: 1.8, speed: 0.35, gravity: -0.25, spread: 0.05,
      swirl: 0, sway: 0, size: 0.022, soft: 0.6,
      color: '1 0.85 0.55', fade: 0.8, glow: 1.0, streak: 0
    }, d || {});
    const extraUniforms = (extra && extra.uniforms) || '';
    const extraBody = (extra && extra.body) || '';
    return {
      id: id, name: name, group: '生成', role: 'source', desc: desc,
      code: `
uniform float u_count;    // @range 4 64 @step 1 @default ${o.count} @label 粒子数
uniform float u_life;     // @range 0.4 6 @step 0.05 @default ${o.life} @label 寿命(秒)
uniform float u_speed;    // @range 0 1.2 @step 0.01 @default ${o.speed} @label 初速
uniform float u_gravity;  // @range -1.5 1.5 @step 0.01 @default ${o.gravity} @label 重力
uniform float u_spread;   // @range 0 0.8 @step 0.01 @default ${o.spread} @label 出生散布
uniform float u_swirl;    // @range 0 2 @step 0.01 @default ${o.swirl} @label 旋涡
uniform float u_sway;     // @range 0 0.12 @step 0.001 @default ${o.sway} @label 横向摇摆
uniform float u_size;     // @range 0.004 0.09 @step 0.001 @default ${o.size} @label 粒子大小
uniform float u_soft;     // @range 0 1 @step 0.01 @default ${o.soft} @label 柔和
uniform float u_fade;     // @range 0 1 @step 0.01 @default ${o.fade} @label 淡出
uniform float u_glow;     // @range 0 3 @step 0.01 @default ${o.glow} @label 亮度
uniform vec3  u_color;    // @color @default ${o.color} @label 颜色
${extraUniforms}
void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 col = vec3(0.0);
  float life = max(0.15, u_life);

  for (int i = 0; i < 64; i++) {
    if (float(i) >= u_count) break;
    float fi = float(i);

    // 每颗粒子错开出生：age 在 0..1 之间循环
    float phase = sl_hash21(vec2(fi, 1.7));
    float age = fract(u_time / life + phase);

    // 出生点与初速
    float ang = sl_hash21(vec2(fi, 9.1)) * 6.2831853;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 p0 = vec2(0.5) + (vec2(sl_hash21(vec2(fi, 3.3)), sl_hash21(vec2(fi, 5.5))) - 0.5) * u_spread * 2.0;
    float spd = u_speed * (0.45 + sl_hash21(vec2(fi, 7.7)) * 1.1);
    vec2 pos = p0 + dir * spd * (age * life);
    pos.y += 0.5 * u_gravity * (age * life) * (age * life);

    // 旋涡：绕画面中心转
    vec2 rel = pos - vec2(0.5);
    float sa = u_swirl * age;
    float cs = cos(sa);
    float sn = sin(sa);
    pos = vec2(0.5) + vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs);

    // 横向摇摆
    pos.x += sin(u_time * 1.3 + fi * 2.0) * u_sway;

    // 大小与光斑
    float sz = u_size * (0.55 + sl_hash21(vec2(fi, 11.3)) * 0.9);
    float d = length(p - pos);
    float core = smoothstep(sz, sz * 0.12, d);
    float halo = smoothstep(sz * (1.0 + u_soft * 4.0), 0.0, d) * 0.3 * u_soft;
    float twinkle = 0.7 + 0.3 * sin(u_time * 7.0 + fi * 2.3);
    float fade = clamp(1.0 - age * u_fade, 0.0, 1.0);
${extraBody}
    col += u_color * (core + halo) * fade * twinkle * u_glow;
  }

  fragColor = vec4(col, 1.0);
}
`
    };
  }

  T.push(
    particleEntry('gen-particles', '通用粒子', '可调的粒子场：数量 / 寿命 / 初速 / 重力 / 旋涡 / 摇摆 / 大小全在参数里，其它粒子模板都是它的预设', {}),

    particleEntry('gen-spark-burst', '火花迸发', '从中心炸开的火星，带重力下落与快速淡出；适合打击 / 爆炸的底料', {
      count: 44, life: 1.1, speed: 0.42, gravity: -0.55, spread: 0.02,
      size: 0.017, soft: 0.5, color: '1 0.72 0.35', fade: 0.9, glow: 1.8
    }),

    particleEntry('gen-fireflies', '萤火虫', '缓慢漂浮的暖绿光点，带随机闪烁与绕圈；夜景 / 森林氛围', {
      count: 26, life: 4.5, speed: 0.09, gravity: 0.0, spread: 0.45,
      swirl: 0.6, size: 0.018, soft: 0.9, color: '0.85 1 0.45', fade: 0.35, glow: 1.3
    }),

    particleEntry('gen-snow', '飘雪', '自上而下缓慢飘落的雪点，横向正弦摇摆，落地前淡出', {
      count: 52, life: 6.0, speed: 0.12, gravity: -0.05, spread: 0.55,
      sway: 0.035, size: 0.011, soft: 0.7, color: '0.95 0.98 1', fade: 0.25, glow: 1.0
    }, {
      body: '    // 雪从上方落下：把出生点抬到画面上方\n    pos.y += 0.35;'
    }),

    particleEntry('gen-embers', '余烬上升', '向上飘的火星，带旋涡与随机闪烁；火焰 / 篝火的余烬层', {
      count: 34, life: 2.6, speed: 0.16, gravity: 0.22, spread: 0.12,
      swirl: 0.35, sway: 0.02, size: 0.009, soft: 0.5, color: '1 0.55 0.18', fade: 0.55, glow: 1.9
    }),

    particleEntry('gen-dust', '浮尘光斑', '大而软、慢慢移动的光斑，像镜头里的浮尘 / 光晕颗粒', {
      count: 18, life: 7.0, speed: 0.05, gravity: 0.0, spread: 0.6,
      swirl: 0.15, size: 0.05, soft: 1.0, color: '1 0.95 0.8', fade: 0.15, glow: 0.45
    }),

    particleEntry('gen-meteors', '流星', '沿固定方向拖尾的粒子：用方向拉伸的距离场做出速度感', {
      count: 14, life: 1.6, speed: 0.7, gravity: -0.15, spread: 0.5,
      size: 0.014, soft: 0.4, color: '0.75 0.9 1', fade: 0.6, glow: 1.4
    }, {
      uniforms: 'uniform float u_stretch;  // @range 0 8 @step 0.1 @default 3.5 @label 拖尾长度\n',
      body: `    // 拖尾：沿运动方向拉长距离场
    vec2 vel = dir * spd + vec2(0.0, u_gravity * age * life);
    vec2 dv = p - pos;
    vec2 tangent = normalize(vel + vec2(1e-4));
    float along = dot(dv, tangent);
    float across = length(dv - tangent * along);
    float tail = u_stretch * sz * 3.0;
    float shape = smoothstep(sz, sz * 0.2, across) * smoothstep(-tail, 0.0, along) * smoothstep(tail * 0.15, 0.0, along);
    float d2 = 1.0 - shape;
    core = shape;
    halo = shape * 0.25;`
    })
  );

  window.SL_PASSES_EXTRA = T;
})();
