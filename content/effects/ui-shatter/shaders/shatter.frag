// 把输入画面切成碎片：每块各自翻转、缩小、被风带向四周并下坠，边缘亮一圈暖光后消散
// 输入 u_ui 来自「面板」中间态 Pass（显式「指定 Pass」绑定）
// 碎片用抖动网格做 Voronoi 切分，比规则网格更像「碎瓦 / 碎纸」
uniform sampler2D u_ui;
uniform float u_cells;   // @range 6 44 @step 1 @default 22 @label 碎片密度
uniform float u_spread;  // @range 0.05 1.2 @step 0.01 @default 0.38 @label 飘散距离
uniform float u_spin;    // @range 0 3 @step 0.01 @default 1.1 @label 翻转幅度
uniform float u_stagger; // @range 0 0.85 @step 0.01 @default 0.42 @label 错落
uniform float u_fade;    // @range 0.1 1 @step 0.01 @default 0.55 @label 消散
uniform vec3  u_edge;    // @color @default 1 0.78 0.42 @label 边缘光

float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
vec2 h21(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = vUv;
  vec2 gp = vec2(uv.x * aspect, uv.y) * u_cells;
  vec2 ip = floor(gp);
  vec2 fp = gp - ip;

  // 抖动网格：找最近的种子（F1）与次近（F2），F2-F1 决定块的边界
  float f1 = 8.0, f2 = 8.0;
  vec2 seed = vec2(0.0);
  vec2 cellId = ip;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 id = ip + o;
      vec2 s = o + h21(id + 3.7) * 0.86 + 0.07;
      float d = length(fp - s);
      if (d < f1) { f2 = f1; f1 = d; seed = s; cellId = id; }
      else if (d < f2) { f2 = d; }
    }
  }

  vec2 local = fp - seed;                 // 相对种子，约 [-0.6, 0.6]
  vec2 rnd = h21(cellId + 11.3);

  // 每块自己的进度：错落 + 先慢后快（先翘起、再被风卷走）
  float t = clamp((u_t01 - rnd.x * u_stagger) / max(1e-3, 1.0 - u_stagger), 0.0, 1.0);
  float e = t * t;

  // 往四周飞 + 下坠 + 横向随机，像被风吹散
  vec2 dir = normalize((uv - 0.5) * vec2(aspect, 1.0) + 1e-5);
  vec2 drift = normalize(dir + vec2((rnd.x - 0.5) * 1.1, 0.08)) * (0.5 + rnd.y * 0.7);
  drift.y -= 0.42;
  vec2 off = drift * e * u_spread;

  // 翻转 + 缩小，块与块之间露出缝才有「碎」的感觉
  float ang = (rnd.y - 0.5) * 6.2831 * u_spin * e;
  float ca = cos(ang), sa = sin(ang);
  vec2 pf = mat2(ca, -sa, sa, ca) * local;
  pf *= 1.0 + e * (0.55 + rnd.y * 0.9);
  pf.y += pf.x * 0.22 * e;                // 轻微剪切，更像纸片

  // 回到 uv 空间：从种子中心出发
  vec2 seedUv = vec2((cellId.x + seed.x) / (u_cells * aspect), (cellId.y + seed.y) / u_cells);
  vec2 suv = seedUv + vec2(pf.x / (u_cells * aspect), pf.y / u_cells) - off;

  vec4 src = texture(u_ui, suv);

  // 起飞前不切；起飞后按 Voronoi 边界留缝
  float split = smoothstep(0.0, 0.13, t);
  float edgeDist = f2 - f1;               // 0 在边界，越大越靠块心
  float cellMask = mix(1.0, smoothstep(0.02, 0.10, edgeDist), split);

  float flash = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.07, 0.38, t));
  float vanish = 1.0 - smoothstep(1.0 - u_fade, 1.0, t);
  float alpha = src.a * cellMask * vanish;

  // 迎光的那条边亮一点（用块内到边界的距离取窄带，避免整块描边）
  float rim = smoothstep(0.16, 0.0, edgeDist) * split;
  vec3 col = src.rgb;
  col += u_edge * rim * (0.14 + 0.34 * (1.0 - t));
  // 飞起来之后碎片整体被「照亮」一点，暗底板也能看清形状
  col += u_edge * e * 0.16 * src.a;
  col += u_edge * flash * 0.28 * src.a;
  col *= mix(0.72, 1.0, vanish);

  // 身后留一点余晖，制造速度感
  vec4 trail = texture(u_ui, suv + off * 0.34);
  col += u_edge * trail.a * (1.0 - vanish) * 0.08;

  col = col / max(1.0, dot(col, vec3(0.299, 0.587, 0.114)));  // 高光不过曝
  fragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
