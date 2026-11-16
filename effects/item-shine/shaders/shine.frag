// 道具刷光：斜向光带扫过，只作用在实体（alpha）上
uniform sampler2D u_sprite;  // 道具图（带透明通道）
uniform float u_width;       // @range 0.02 0.5 @step 0.01 @default 0.06 @label 光带宽度
uniform float u_angle;       // @range -1 1 @step 0.01 @default -0.42 @label 扫光角度
uniform vec3  u_color;       // @color @label 光颜色
uniform float u_gain;        // @range 0 4 @step 0.01 @default 0.7 @label 亮度
uniform float u_trail;       // @range 0 1 @step 0.01 @default 0.12 @label 余晖

void main() {
  vec4 s = texture(u_sprite, vUv);

  // 沿角度方向做投影，光带在该轴上移动
  float ca = cos(u_angle), sa = sin(u_angle);
  float d = vUv.x * ca + vUv.y * sa;

  // 头尾各留一点余量，保证光带完整扫过
  float head = mix(-0.25, 1.25, sl_easeInOut(u_t01));

  // 主光带 + 更宽的一层余晖（pow 负数底未定义，平方写成 q*q）
  float q = (d - head) / u_width;
  float band = exp(-q * q);
  float qh = (d - head) / (u_width * 2.6);
  float halo = exp(-qh * qh) * u_trail;

  // 只在实体上（alpha 当遮罩），边缘用 alpha 软过渡
  float mask = smoothstep(0.0, 0.85, s.a);
  vec3 shine = u_color * (band + halo) * u_gain * mask;

  vec3 c = s.rgb + shine;
  fragColor = vec4(c, s.a);
}
