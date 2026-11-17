// 星云（中间态）：域扭曲的 fbm，颜色在紫 / 青之间游走
uniform vec3 u_c1;     // @color @default 0.35 0.18 0.85 @label 主色
uniform vec3 u_c2;     // @color @default 0.15 0.75 0.85 @label 副色
uniform float u_scale; // @range 0.5 6 @step 0.05 @default 1.9 @label 尺度
uniform float u_speed; // @range 0 1.5 @step 0.01 @default 0.12 @label 漂流速度

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    s += vnoise(p) * amp;
    p = p * 2.02 + 17.0;
    amp *= 0.5;
  }
  return s;
}

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = vec2(vUv.x * aspect, vUv.y) * u_scale + vec2(u_time * u_speed, 0.0);

  // 域扭曲：先用一层噪声推坐标，再取第二层
  vec2 w = vec2(fbm(p + 3.1), fbm(p + 8.7)) - 0.5;
  float n = fbm(p + w * 1.9);

  // 云的结构：n 靠近 0.5 是稀薄区，两端是浓云
  float dens = smoothstep(0.32, 0.85, n);
  float vein = smoothstep(0.55, 0.95, fbm(p * 2.3 - w));

  vec3 col = mix(vec3(0.01, 0.01, 0.04), u_c1, dens);
  col = mix(col, u_c2, smoothstep(0.45, 0.9, vein) * 0.75);
  col += u_c1 * dens * dens * 0.35;

  fragColor = vec4(col, 1.0);
}
