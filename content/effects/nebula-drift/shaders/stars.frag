// 星点（中间态）：静态星场 + 少量缓慢闪烁的亮星
uniform float u_count;  // @range 60 600 @step 10 @default 260 @label 星数
uniform float u_size;   // @range 0.05 0.5 @step 0.01 @default 0.22 @label 星点大小
uniform vec3  u_tint;   // @color @default 0.85 0.92 1 @label 星色
uniform float u_twinkle;// @range 0 1 @step 0.01 @default 0.55 @label 闪烁

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 col = vec3(0.0);

  // 三层不同密度的网格，避免星点排布规律
  for (int layer = 0; layer < 3; layer++) {
    float cells = u_count * (0.55 + float(layer) * 0.35);
    vec2 g = p * cells;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;

    float rnd = hash(id + float(layer) * 41.7);
    if (rnd > 0.955) {
      vec2 off = vec2(hash(id + 7.1), hash(id + 13.3)) - 0.5;
      float d = length(f - off * 0.7);
      float tw = 0.55 + 0.45 * sin(u_time * (1.2 + rnd * 3.0) + rnd * 20.0);
      float s = smoothstep(u_size, 0.0, d) * mix(1.0, tw, u_twinkle);
      col += u_tint * s * (0.9 + rnd * 1.4);
    }
  }

  fragColor = vec4(col, 1.0);
}
