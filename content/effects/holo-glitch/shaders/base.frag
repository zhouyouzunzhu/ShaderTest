// 底图：把内置渐变图压暗、偏冷，方便全息层往上叠
uniform sampler2D u_img;
uniform float u_dark;  // @range 0 1 @step 0.01 @default 0.45 @label 压暗

void main() {
  vec3 c = texture(u_img, vUv).rgb;
  c *= mix(1.0, 0.45, u_dark);
  c = mix(c, c * vec3(0.72, 0.92, 1.15), 0.65);
  fragColor = vec4(c, 1.0);
}
