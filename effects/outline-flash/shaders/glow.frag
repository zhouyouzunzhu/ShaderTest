// 柔光：对上一 Pass 做一次 9 tap 高斯，用来把描边晕开
uniform sampler2D u_src;   // 上一 Pass 的输出
uniform float u_radius;    // @range 0.5 8 @step 0.1 @default 2.4 @label 扩散半径
uniform float u_gain;      // @range 0 3 @step 0.01 @default 1.1 @label 增益

void main() {
  vec2 e = u_texel * u_radius;
  vec4 sum = texture(u_src, vUv) * 0.227;
  sum += (texture(u_src, vUv + vec2(e.x, 0.0)) + texture(u_src, vUv - vec2(e.x, 0.0))) * 0.158;
  sum += (texture(u_src, vUv + vec2(0.0, e.y)) + texture(u_src, vUv - vec2(0.0, e.y))) * 0.158;
  sum += (texture(u_src, vUv + e) + texture(u_src, vUv - e)) * 0.05;
  sum += (texture(u_src, vUv + vec2(e.x, -e.y)) + texture(u_src, vUv + vec2(-e.x, e.y))) * 0.05;

  // 保留原图一部分，避免糊成一团
  vec4 base = texture(u_src, vUv);
  vec4 outCol = mix(base, sum, 0.75) * u_gain;
  fragColor = vec4(outCol.rgb, clamp(outCol.a, 0.0, 1.0));
}
