// 滤色叠加：1-(1-A)(1-B)，暗部几乎不变，亮部自然叠亮
uniform sampler2D u_tex;
uniform sampler2D u_layer;
uniform float u_amount;  // @range 0 2 @step 0.01 @default 1.0 @label 强度

void main() {
  vec3 a = texture(u_tex, vUv).rgb;
  vec3 b = texture(u_layer, vUv).rgb * u_amount;
  vec3 c = 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0));
  fragColor = vec4(c, 1.0);
}
