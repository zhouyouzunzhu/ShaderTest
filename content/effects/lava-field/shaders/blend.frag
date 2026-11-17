// 火焰化：把第二张图（火焰中间态）的亮度映射成火焰色带，再压回当前画面
uniform sampler2D u_tex;    // 当前画面（上一 Pass）
uniform sampler2D u_layer;  // 火焰中间态
uniform float u_amount;     // @range 0 2 @step 0.01 @default 0.9 @label 强度
uniform float u_gain;       // @range 0.5 3 @step 0.01 @default 1.6 @label 火势放大
uniform float u_cool;       // @range 0 1 @step 0.01 @default 0.15 @label 保留冷色

void main() {
  vec3 base = texture(u_tex, vUv).rgb;
  vec3 fire = texture(u_layer, vUv).rgb;
  float t = clamp(max(fire.r, max(fire.g, fire.b)) * u_gain, 0.0, 1.0);

  // 黑 → 橙红 → 亮黄白的火焰色带
  vec3 ramp = mix(vec3(0.06, 0.01, 0.0), vec3(0.95, 0.28, 0.04), smoothstep(0.0, 0.55, t));
  ramp = mix(ramp, vec3(1.0, 0.93, 0.62), smoothstep(0.55, 1.0, t));

  // 火光把底图烘暖，再用滤色叠上去（不会把底图直接冲成纯白）
  vec3 warm = base * mix(1.0, 0.72, u_cool);
  vec3 glow = ramp * t * u_amount;
  vec3 c = 1.0 - (1.0 - warm) * (1.0 - clamp(glow, 0.0, 1.0));
  fragColor = vec4(c, 1.0);
}
