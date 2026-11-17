// 山峦（中间态）：用脊状噪声叠出远近三层山形 + 留白的「雾」
uniform float u_scale;   // @range 0.5 5 @step 0.05 @default 1.6 @label 山形尺度
uniform float u_layers;  // @range 2 5 @step 1 @default 3 @label 层数
uniform float u_mist;    // @range 0 1 @step 0.01 @default 0.45 @label 雾浓度

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 脊状噪声：1-|2n-1| 会把噪声折成山脊
float ridge(vec2 p) {
  float s = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    s += n * n * amp;
    p = p * 2.07 + 11.3;
    amp *= 0.5;
  }
  return s;
}

void main() {
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 p = vec2(vUv.x * aspect, vUv.y) * u_scale;
  float t = u_time * 0.02;

  vec3 col = vec3(0.93, 0.92, 0.88);   // 宣纸底
  float ink = 0.0;

  // 由远及近三层：越近颜色越深、山脊越低
  for (int i = 0; i < 3; i++) {
    if (float(i) > u_layers - 1.0) break;
    float k = float(i);
    float depth = 0.32 + k * 0.16;                  // 山脚高度
    float h = ridge(p * (0.8 + k * 0.45) + vec2(t * (0.4 + k * 0.2), k * 5.0));
    float line = smoothstep(depth + 0.30, depth - 0.02, vUv.y + 0.0);
    float body = smoothstep(depth, depth - 0.22, vUv.y) * h;
    ink = max(ink, body * (0.85 - k * 0.22) * line);
  }

  // 雾：把山脚往回淡出去
  float mist = smoothstep(0.0, 0.55, vUv.y) * u_mist;
  ink *= 1.0 - mist;

  col = mix(col, vec3(0.09, 0.10, 0.12), clamp(ink * 1.9, 0.0, 1.0));
  fragColor = vec4(col, 1.0);
}
