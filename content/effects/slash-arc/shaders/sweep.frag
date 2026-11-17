// 刀光 · 弧形横扫
// 一次性效果：u_t01 从 0 走到 1，刀光沿弧线从左上扫到右下。
uniform float u_intensity; // @range 0 3 @step 0.01 @default 1.6 @label 强度
uniform float u_spread;    // @range 0.5 3 @step 0.01 @default 1.0 @label 拖尾长度
uniform vec3  u_color;     // @color @label 刀光颜色

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float ang = atan(p.y, p.x);

  // 扫过角度：-2.4 → 2.4；起手快、收尾慢
  float t = sl_easeOut(u_t01);
  float head = mix(-2.4, 2.4, t);

  // 头部亮线 + 身后拖尾（角度差越大越暗）
  float da = head - ang;
  float lead = exp(-abs(da) * 26.0);
  float trail = exp(-max(da, 0.0) * 2.0 / u_spread);

  // 弧带：半径 0.62 附近的一条带子
  // 注意：pow(x, 2.0) 在 x<0 时 GLSL 未定义，平方一律写成 q*q
  float q = (r - 0.62) / 0.04;
  float band = exp(-q * q);

  // 只画「已经扫过」的角度范围，起点留一段软过渡
  float swept = smoothstep(-3.15, -2.65, ang) * smoothstep(head + 0.02, head - 0.08, ang);

  float glow = band * swept * (trail * 0.45 + lead * 1.35);

  // 起手时中心的一点光：只在 t01 的开头出现，且随距离快速衰减
  float startFlash = exp(-r * 9.0) * smoothstep(0.3, 0.0, u_t01) * 0.8;

  vec3 col = u_color * (glow + startFlash);

  // 颜色保持色相，亮度交给 alpha：叠在背景上不会因为过曝糊成一片白
  float m = max(col.r, max(col.g, col.b));
  fragColor = vec4(col / max(m, 1e-3), clamp(m * u_intensity, 0.0, 1.0));
}
