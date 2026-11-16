// 生成一张「任务完成」风格的 UI 面板：暗底 + 金线 + 假文字（透明背景）
// 中间态 Pass：不读输入，只往自己的缓冲里画，供「碎裂」Pass 采样
uniform float u_w;     // @range 0.3 0.95 @step 0.01 @default 0.62 @label 面板宽度
uniform float u_h;     // @range 0.10 0.50 @step 0.01 @default 0.24 @label 面板高度
uniform vec3  u_line;  // @color @default 1 0.82 0.5 @label 金线
uniform vec3  u_fill;  // @color @default 0.05 0.045 0.04 @label 底板

float box(vec2 p, vec2 c, vec2 h, float aa) {
  vec2 d = abs(p - c) - h;
  return 1.0 - smoothstep(-aa, aa, max(d.x, d.y));
}

float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  vec2 b = vec2(u_w * aspect * 0.5, u_h * 0.5);
  float aa = 1.4 / u_resolution.y;
  float r = min(0.02, b.y * 0.25);

  // 底板：中间实、上下柔一点，像一块压在画面上的横幅
  float plate = 1.0 - smoothstep(-aa, aa, sdRound(p, b, r));
  float vgrad = 1.0 - pow(abs(p.y) / max(1e-4, b.y), 2.0) * 0.55;
  vec3 col = u_fill;
  float alpha = plate * 0.82 * vgrad;

  // 描边细线
  float border = 1.0 - smoothstep(-aa, aa, abs(sdRound(p, b, r)) - 0.0012);
  col = mix(col, u_line, border * 0.5);
  alpha = max(alpha, border * 0.5);

  // 上下两条金线
  float halfLen = b.x * 0.86;
  float lw = 0.0014;
  float topLine = box(p, vec2(0.0, b.y * 0.62), vec2(halfLen, lw), aa);
  float botLine = box(p, vec2(0.0, -b.y * 0.66), vec2(halfLen, lw), aa);
  float rules = max(topLine, botLine);
  col = mix(col, u_line, rules);
  alpha = max(alpha, rules * 0.92);

  // 金线两端的小菱形
  vec2 dp = vec2(halfLen + 0.013, b.y * 0.62);
  float dia = 1.0 - smoothstep(-aa, aa, abs(p.x - dp.x) + abs(p.y - dp.y) - 0.011);
  float dia2 = 1.0 - smoothstep(-aa, aa, abs(p.x + dp.x) + abs(p.y - dp.y) - 0.011);
  float dias = max(dia, dia2);
  col = mix(col, u_line, dias);
  alpha = max(alpha, dias * 0.95);

  // 标题：一排粗细不一的方块，远看像字
  float tw[6] = float[6](0.052, 0.034, 0.046, 0.030, 0.050, 0.038);
  float gap = 0.012;
  float total = gap * 5.0;
  for (int i = 0; i < 6; i++) total += tw[i];
  float x = -total * 0.5;
  float title = 0.0;
  for (int i = 0; i < 6; i++) {
    title = max(title, box(p, vec2(x + tw[i] * 0.5, 0.014), vec2(tw[i] * 0.5, 0.015), aa));
    x += tw[i] + gap;
  }

  // 副标题：更短更细
  float sw[4] = float[4](0.058, 0.042, 0.050, 0.034);
  float stotal = gap * 3.0;
  for (int i = 0; i < 4; i++) stotal += sw[i];
  float x2 = -stotal * 0.5;
  float sub = 0.0;
  for (int i = 0; i < 4; i++) {
    sub = max(sub, box(p, vec2(x2 + sw[i] * 0.5, -0.050), vec2(sw[i] * 0.5, 0.0075), aa));
    x2 += sw[i] + gap;
  }

  float text = max(title, sub * 0.72);
  col = mix(col, u_line, text);
  alpha = max(alpha, text * 0.95);

  fragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
