// 描边：先把 alpha 二值化，再在「形状」上做 Sobel，得到一圈干净的发光线
uniform sampler2D u_sprite;  // 道具图（靠 alpha 找边）
uniform float u_thickness;   // @range 1 6 @step 0.1 @default 2.0 @label 描边粗细
uniform vec3  u_color;       // @color @label 描边颜色
uniform float u_gain;        // @range 0 4 @step 0.01 @default 2.4 @label 亮度
uniform float u_freq;        // @range 0 6 @step 0.05 @default 1.4 @label 呼吸次数
uniform float u_soft;        // @range 0.02 0.5 @step 0.01 @default 0.12 @label 边缘柔化

// 把 alpha 阈值化成形状：直接用原始 alpha（软边）会让 Sobel 输出一条很宽的带子
float shape(vec2 uv) {
  return smoothstep(0.5 - u_soft, 0.5 + u_soft, texture(u_sprite, uv).a);
}

void main() {
  vec2 e = u_texel * u_thickness;

  float l  = shape(vUv - vec2(e.x, 0.0));
  float r  = shape(vUv + vec2(e.x, 0.0));
  float b  = shape(vUv - vec2(0.0, e.y));
  float t  = shape(vUv + vec2(0.0, e.y));
  float tl = shape(vUv - e);
  float tr = shape(vUv + vec2(e.x, -e.y));
  float bl = shape(vUv + vec2(-e.x, e.y));
  float br = shape(vUv + e);

  // Sobel：形状的梯度就是轮廓
  float gx = (tl + 2.0 * l + bl) - (tr + 2.0 * r + br);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);

  // 呼吸：亮度做正弦起伏
  float breath = 0.45 + 0.55 * (0.5 + 0.5 * sin(u_time * u_freq * TAU));

  vec3 col = u_color * edge * breath;

  // 颜色保持色相，亮度交给 alpha，叠在背景上不会糊成一片白
  float m = max(col.r, max(col.g, col.b));
  fragColor = vec4(col / max(m, 1e-3), clamp(m * u_gain, 0.0, 1.0));
}
