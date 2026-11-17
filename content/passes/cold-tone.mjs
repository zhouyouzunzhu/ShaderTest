// ShaderLab Pass 模板：冷调压暗
// 一个 Pass 一个文件；刷新页面就能在「插入 Pass → 我的」里看到。
// 可以手写，也可以让 AI 生成——格式就是下面这几行。

export default {
  name: "冷调压暗",
  group: "我的 Pass",
  role: "filter",
  desc: "整体压暗并往冷色偏，适合夜景/月下场景的底子",
  code: `
uniform sampler2D u_tex;

uniform float u_cool;   // @range 0 1 @step 0.01 @default 0.35 @label 冷色
uniform float u_gamma;  // @range 0.5 2 @step 0.01 @default 1.0 @label 伽马
uniform float u_vig;    // @range 0 1 @step 0.01 @default 0.35 @label 暗角

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  // 往冷色偏：红少一点、蓝多一点
  c = mix(c, c * vec3(0.82, 0.92, 1.12), u_cool);
  // 整体压暗（伽马 > 1 更暗）
  c = pow(max(c, 0.0), vec3(u_gamma));
  // 四角压暗，让画面往中间收
  float d = length(vUv - 0.5) * 1.3;
  c *= mix(1.0, smoothstep(0.95, 0.25, d), u_vig);
  fragColor = vec4(c, 1.0);
}
`
};
