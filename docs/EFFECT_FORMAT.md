# 效果包格式（effects/）

ShaderLab 的效果库把一个效果装成一个目录。好处是：**git 能看到、AI 能直接改、构建能校验**，
不用再去改 `js/presets.js` 里的 JS 字符串。

```
effects/
  slash-arc/
    effect.json         # 元信息（必需）
    shaders/sweep.frag  # 每个 Pass 一个文件（可读、可 diff）
    input/…             # 可选：这个效果要用的贴图
  index.json            # 生成物：给工具 / AI 读
  index.js              # 生成物：给页面读（file:// 下 fetch 会被拦，只能走 <script>）
```

> 加完或改完效果，跑一次 `node tools/lib.mjs build`。页面刷新后图库里就有了。

## 新建一个效果

```bash
node tools/new.mjs slash-arc-2 --name "刀光·斜劈" --tags 刀光,一次性 --duration 0.6 --alpha
# 编辑 effects/slash-arc-2/shaders/main.frag
node tools/lib.mjs build
```

## effect.json

```json
{
  "id": "slash-arc",
  "name": "刀光·弧形横扫",
  "desc": "一次性弧形刀光：头部亮线 + 身后拖尾。",
  "tags": ["刀光", "一次性", "alpha", "加色"],
  "loop": false,
  "duration": 0.62,
  "output": { "w": 640, "h": 640, "alpha": true },
  "inputs": { "noise": "builtin:noise" },
  "passes": [
    { "name": "sweep", "shader": "shaders/sweep.frag", "format": "hdr" },
    { "name": "glow",  "shader": "shaders/glow.frag",  "format": "rgba8",
      "bindings": { "u_src": { "kind": "pass", "pass": "p1" } } }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | kebab-case，**必须和目录名一致**（构建会校验） |
| `name` | 是 | 图库卡片和下拉里的名字 |
| `desc` | 否 | 一句话说明，显示在卡片上 |
| `tags` | 否 | 字符串数组；图库顶部按标签筛选 |
| `loop` | 否 | 默认 `true`。写 `false` 表示一次性效果 |
| `duration` | 一次性必填 | 秒。`loop:false` 时必须 > 0 |
| `output.w/h` | 否 | 默认 640×640，范围 16–4096 |
| `output.alpha` | 否 | `true` 时画布带透明通道，预览叠在背景上 |
| `inputs` | 否 | 贴图声明，见下 |
| `passes` | 是 | 至少一个 Pass，第一个 Pass 的 `prev` 是输入图 |

### inputs（贴图）

```json
"inputs": {
  "sprite": "builtin:sprite",     // 内置图：testcard / checker / noise / gradient / circle / sprite
  "mask":   "input/mask.png"      // 相对效果目录的文件，构建时会转成 dataURL 内联
}
```

贴图在页面里的 id 是 `builtin:<名字>` 或导入后的 `a:…`；构建会把它内联进 `index.json`，
所以效果目录自包含，复制给别人也能直接跑。

### passes

| 字段 | 说明 |
| --- | --- |
| `name` | Pass 名字（左栏列表里显示） |
| `shader` | `.frag` 路径，必须存在且含 `void main(` 或 `void mainImage(` |
| `format` | `rgba8`（默认）或 `hdr`（RGBA16F，做泛光/加色时用） |
| `scale` | 0.05–4，内部可以按 1/2 分辨率跑模糊 |
| `bindings` | 采样器绑定，键是 uniform 名 |

`bindings` 的 `kind`：

- `{"kind":"asset","input":"sprite"}` —— 绑到 `inputs` 里声明的贴图
- `{"kind":"pass","pass":"p1"}` —— 绑到某个 Pass 的输出（`p1` 是 Pass 的下标+1）
- `{"kind":"prev"}` —— 上一个 Pass（第一个 Pass 得到输入图）
- `{"kind":"self"}` —— 自身上一帧（反馈 / 流体）
- `{"kind":"none"}` —— 不绑

## 写 shader 时能直接用

和预设里的写法完全一样，构建器会自动补 `#version 300 es`、precision、`vUv`、`fragColor`。

```glsl
uniform float u_intensity; // @range 0 3 @step 0.01 @default 1.6 @label 强度
uniform vec3  u_color;     // @color @label 颜色

void main() {
  float t = u_t01;                 // 一次性效果：0 → 1 的进度
  …
  fragColor = vec4(col, alpha);    // alpha 只有 output.alpha:true 才有意义
}
```

一次性效果请用 `u_t01` 驱动，**不要**用 `u_time` 取模：预览下方的时间轴拖动时会直接改 `u_t01`。

## 约定与坑

- **平方不要写 `pow(x, 2.0)`**：x < 0 时 GLSL 未定义（D3D11 上会整片发白）。写 `q*q`。
- 带 alpha 的效果：颜色保持色相，亮度交给 alpha（`col / max(m,1e-3)`，`alpha = m * gain`），
  叠在背景上才不会糊成一片白。
- 想要拖尾/余晖就绑 `self`，但记得 `scale` 别开太小，否则会闪。
- 标签尽量复用一个词（`刀光`、`道具`、`描边`、`水流`），图库按标签筛，标签太散等于没有。

## 命令

```bash
node tools/lib.mjs build    # 校验 + 生成 index.json / index.js
node tools/lib.mjs check    # 只校验（CI / 提交前跑）
node tools/lib.mjs list     # 列出效果
node tools/new.mjs <id>     # 新建效果脚手架
```
