// 霓虹网格（中间态）：透视地面网格 + 地平线辉光，纯程序生成
uniform vec3 u_line;    // @color @default 0.35 0.95 1 @label 线色
uniform vec3 u_glow;    // @color @default 0.75 0.25 1 @label 辉光色
uniform float u_cells;  // @range 4 24 @step 1 @default 9 @label 纵列数
uniform float u_speed;  // @range 0 2 @step 0.01 @default 0.55 @label 滚动速度
uniform float u_horizon;// @range 0.3 0.75 @step 0.01 @default 0.52 @label 地平线

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  float hz = u_horizon;

  // 地面：y < 地平线时按透视压缩取深度
  float isGround = step(vUv.y, hz);
  float depth = (hz - vUv.y) / max(1e-3, hz);       // 0 在视线，1 在近处
  float persp = 1.0 / max(0.06, depth);

  // 横向格线（近处线太密会摩尔纹，按深度淡掉）
  float x = (vUv.x - 0.5) * aspect * u_cells * mix(0.4, 3.2, depth);
  float lx = abs(fract(x) - 0.5);
  float nearFade = 1.0 - smoothstep(0.55, 0.95, depth);
  float lineX = smoothstep(0.06, 0.005, lx) * smoothstep(0.0, 0.08, depth) * nearFade;

  // 纵向格线（随深度滚动）
  float z = persp * 0.9 - u_time * u_speed;
  float lz = abs(fract(z) - 0.5);
  float lineZ = smoothstep(0.10, 0.01, lz) * smoothstep(0.0, 0.06, depth) * nearFade;

  float grid = max(lineX, lineZ) * isGround;

  // 地平线上一圈辉光 + 雾气
  float gq = (vUv.y - hz) / 0.055;
  float glowBand = exp(-gq * gq);
  float haze = smoothstep(hz + 0.30, hz - 0.02, vUv.y) * 0.35 * isGround;

  vec3 col = vec3(0.015, 0.01, 0.04);
  col += u_glow * glowBand * 0.32;
  col += u_glow * haze;
  col += u_line * grid * (0.9 + glowBand * 0.7);

  fragColor = vec4(col, 1.0);
}
