// 全息：扫描线 + RGB 错位 + 横向撕裂 + 冷色发光
uniform sampler2D u_src;
uniform float u_lines;    // @range 60 400 @step 10 @default 180 @label 扫描线密度
uniform float u_scan;     // @range 0 1 @step 0.01 @default 0.55 @label 扫描线强度
uniform float u_shift;    // @range 0 0.02 @step 0.0005 @default 0.006 @label 色散
uniform float u_glitch;   // @range 0 1 @step 0.01 @default 0.7 @label 撕裂强度
uniform vec3  u_tint;     // @color @default 0.35 0.95 1 @label 全息色

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;

  // 横向撕裂：按行随机整体平移，随时间跳跃
  float rows = 22.0;
  float row = floor(uv.y * rows);
  float tick = floor(u_time * 7.0);
  float rnd = hash(vec2(row, tick));
  float band = step(0.66, rnd);
  float jitter = (hash(vec2(row, tick + 7.0)) - 0.5) * 0.09 * u_glitch * band;
  uv.x += jitter;

  // 撕裂行整体提亮一点，看起来像信号错位
  float boost = band * u_glitch * 0.35;

  // RGB 错位（边缘更明显）
  float edge = 1.0 - 0.6 * length(vUv - 0.5);
  float sh = u_shift * (0.5 + edge);
  float r = texture(u_src, uv + vec2(sh, 0.0)).r;
  float g = texture(u_src, uv).g;
  float b = texture(u_src, uv - vec2(sh, 0.0)).b;
  vec3 c = vec3(r, g, b);

  // 扫描线
  float line = 0.5 + 0.5 * sin(uv.y * u_lines * 3.14159 + u_time * 4.0);
  c *= 1.0 - u_scan * line * 0.55;

  // 缓慢下移的亮带
  float sweep = fract(u_time * 0.11);
  float bandGlow = smoothstep(0.03, 0.0, abs(uv.y - sweep));
  c += u_tint * bandGlow * 0.22;

  // 全息染色：偏冷，但保留原本的明暗关系
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 holo = vec3(lum) * u_tint * 1.5 + c * 0.55;
  c = mix(c, holo, 0.45);
  c += u_tint * boost;

  // 暗角
  vec2 d = uv - 0.5;
  c *= 1.0 - dot(d, d) * 0.6;

  fragColor = vec4(c, 1.0);
}
