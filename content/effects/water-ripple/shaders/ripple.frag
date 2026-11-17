// 水流扰动：噪声推 UV + 高光
uniform sampler2D u_tex;   // 场景（会被扭曲的那张图）
uniform sampler2D u_noise; // 噪声图
uniform float u_strength;  // @range 0 0.12 @step 0.001 @default 0.028 @label 扰动强度
uniform float u_speed;     // @range 0 3 @step 0.01 @default 0.45 @label 流速
uniform float u_scale;     // @range 0.5 8 @step 0.1 @default 2.2 @label 波纹密度
uniform float u_caustic;   // @range 0 3 @step 0.01 @default 0.9 @label 水面高光

void main() {
  vec2 uv = vUv;
  float t = u_time * u_speed;

  // 两层不同速度、不同尺度的噪声滚过去，避免看出平铺
  float n1 = texture(u_noise, uv * u_scale + vec2(t * 0.07, t * 0.03)).r;
  float n2 = texture(u_noise, uv * u_scale * 1.7 - vec2(t * 0.05, t * 0.09)).r;
  vec2 off = vec2(n1, n2) - 0.5;

  // 用噪声当位移场；采样点稍微偏一点就能看出水的折射感
  vec3 c = texture(u_tex, uv + off * u_strength).rgb;

  // 高光：两个噪声相乘取亮部，模拟水面被照亮的地方
  float caustic = pow(clamp(n1 * n2 * 1.9, 0.0, 1.0), 3.0) * u_caustic;
  c += vec3(0.45, 0.7, 1.0) * caustic * 0.5;

  // 极轻的暗角，让画面聚焦
  float vig = 1.0 - 0.25 * pow(length(vUv - 0.5) * 1.8, 2.0);
  fragColor = vec4(c * vig, 1.0);
}
