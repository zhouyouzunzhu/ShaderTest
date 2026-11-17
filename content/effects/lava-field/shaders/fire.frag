// 火焰（中间态）：不读输入，自己生成一张会向上卷的噪声火
// 输出亮度既当「火苗形状」，也当后面「火焰化」的遮罩
uniform float u_scale;   // @range 1 6 @step 0.05 @default 4.2 @label 火焰尺度
uniform float u_speed;   // @range 0 1.5 @step 0.01 @default 0.45 @label 上升速度
uniform float u_height;  // @range 0.3 1 @step 0.01 @default 0.78 @label 火势高度

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
  for (int i = 0; i < 4; i++) {
    s += vnoise(p) * amp;
    p *= 2.03;
    amp *= 0.5;
  }
  return s;
}

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = vec2(vUv.x * aspect, vUv.y) * u_scale;
  float t = u_time * u_speed;

  // 竖直方向拉长 + 向上滚动：火苗是细长的
  vec2 q = vec2(p.x, p.y * 0.55 - t * 1.4);
  float n1 = fbm(q);
  float n2 = fbm(q * 2.3 + vec2(t * 0.6, -t * 0.3));
  float n = n1 * 0.72 + n2 * 0.42;

  // 越靠下越旺，往上收细
  float rise = smoothstep(0.0, u_height, 1.0 - vUv.y);
  float body = smoothstep(0.45, 0.95, n * (0.55 + rise * 0.75));
  // 再撕几道口子，别让底部糊成一整块
  float breakup = smoothstep(0.18, 0.62, fbm(q * 3.7 + vec2(t * 0.4, -t * 0.9)));
  body *= mix(0.45, 1.0, breakup);
  float core = smoothstep(0.72, 1.0, body) * smoothstep(0.0, 0.55, rise);

  // 亮度即火势；RGB 也顺手给个暖色，方便单独预览这张中间态
  float heat = clamp(body * 0.85 + core * 0.9, 0.0, 1.0);
  vec3 col = mix(vec3(0.05, 0.01, 0.0), vec3(1.0, 0.42, 0.06), body);
  col = mix(col, vec3(1.0, 0.95, 0.72), core);
  fragColor = vec4(col * heat, 1.0);
}
