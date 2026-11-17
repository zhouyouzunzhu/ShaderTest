// 底图：轻轻压暗、加一点暖，让后面的火光有地方落
uniform sampler2D u_img;
uniform float u_dark;  // @range 0 1 @step 0.01 @default 0.35 @label 压暗

void main() {
  vec3 c = texture(u_img, vUv).rgb;
  c *= mix(1.0, 0.55, u_dark);
  c = mix(c, c * vec3(1.08, 0.96, 0.86), 0.6);
  fragColor = vec4(c, 1.0);
}
