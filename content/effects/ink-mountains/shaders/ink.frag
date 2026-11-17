// 水墨：压成几阶灰 + 纸纹 + 边缘飞白（用亮度梯度当「墨渗」）
uniform sampler2D u_src;
uniform float u_steps;   // @range 2 8 @step 1 @default 4 @label 墨阶
uniform float u_paper;   // @range 0 1 @step 0.01 @default 0.35 @label 纸纹
uniform float u_bleed;   // @range 0 1 @step 0.01 @default 0.4 @label 墨渗

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 c = texture(u_src, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));

  // 阶调
  float n = max(2.0, u_steps);
  float q = floor(l * n + 0.5) / n;

  // 墨渗：用周围亮度差在边缘加一层淡墨，模拟毛边
  vec2 px = 1.6 / u_resolution;
  float lx = dot(texture(u_src, vUv + vec2(px.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
  float ly = dot(texture(u_src, vUv + vec2(0.0, px.y)).rgb, vec3(0.299, 0.587, 0.114));
  float edge = clamp((abs(l - lx) + abs(l - ly)) * 6.0, 0.0, 1.0);
  q -= edge * u_bleed * 0.35;

  // 纸纹：低频颗粒 + 一点点纤维
  vec2 gp = vUv * vec2(900.0, 600.0);
  float grain = hash(floor(gp)) * 0.6 + hash(floor(gp * 0.35)) * 0.4;
  q += (grain - 0.5) * 0.09 * u_paper;

  vec3 paper = vec3(0.94, 0.93, 0.89);
  vec3 ink = vec3(0.08, 0.09, 0.11);
  vec3 outCol = mix(paper, ink, clamp(1.0 - q, 0.0, 1.0));

  // 轻微暖边，别太死板
  outCol *= mix(vec3(1.0), vec3(1.02, 0.99, 0.94), 0.6);
  fragColor = vec4(outCol, 1.0);
}
