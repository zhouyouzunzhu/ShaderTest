// 扫描发光：横向扫描线 + 轻微色散 + 亮部扩散（不做多 Pass 也能出「廉价 bloom」）
uniform sampler2D u_src;
uniform float u_scan;   // @range 0 1 @step 0.01 @default 0.35 @label 扫描线
uniform float u_bleed;  // @range 0 1 @step 0.01 @default 0.55 @label 光晕
uniform float u_shift;  // @range 0 0.01 @step 0.0002 @default 0.0016 @label 色散
uniform float u_lines;  // @range 100 900 @step 10 @default 420 @label 线密度

void main() {
  vec2 uv = vUv;
  // 三个通道错开一点点采样，模拟镜头色散
  float cr = texture(u_src, uv + vec2(u_shift, 0.0)).r;
  float cg = texture(u_src, uv).g;
  float cb = texture(u_src, uv - vec2(u_shift, 0.0)).b;
  vec3 c = vec3(cr, cg, cb);

  // 亮部扩散：十字方向取平均，加回去
  vec2 px = 2.0 / u_resolution;
  vec3 blur = texture(u_src, uv + vec2(px.x, 0.0)).rgb
            + texture(u_src, uv - vec2(px.x, 0.0)).rgb
            + texture(u_src, uv + vec2(0.0, px.y)).rgb
            + texture(u_src, uv - vec2(0.0, px.y)).rgb;
  blur *= 0.25;
  c += blur * u_bleed;

  // 扫描线
  float line = 0.5 + 0.5 * sin(vUv.y * u_lines * 3.14159 + u_time * 2.4);
  c *= 1.0 - u_scan * line * 0.45;

  // 很轻的暗角，让中心亮一点
  vec2 d = uv - 0.5;
  c *= 1.0 - dot(d, d) * 0.55;

  fragColor = vec4(c, 1.0);
}
