#!/usr/bin/env node
/**
 * 新建效果脚手架
 *
 *   node tools/new.mjs 我的效果id [--name 中文名] [--tags 刀光,道具] [--duration 0.6] [--alpha]
 *
 * 生成 effects/<id>/{effect.json, shaders/main.frag, input/.gitkeep}，
 * 然后跑 `node tools/lib.mjs build` 让图库看到它。
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function usage(msg) {
  if (msg) console.error('错误：' + msg);
  console.error('用法：node tools/new.mjs <效果id> [--name 名称] [--tags a,b] [--duration 0.6] [--alpha]');
  process.exit(1);
}

const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith('--'));
if (!id) usage('缺少效果 id');
if (!ID_RE.test(id)) usage(`id 只能是 kebab-case（当前：${id}）`);

function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}
const name = opt('name', id);
const tags = (opt('tags', '') || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
const duration = Number(opt('duration', '0'));
const alpha = argv.includes('--alpha');

const dir = path.join(ROOT, 'effects', id);
try {
  await access(dir);
  usage(`effects/${id} 已经存在`);
} catch {
  /* 不存在，继续 */
}

const loop = !(duration > 0);
const effect = {
  id,
  name,
  desc: '在这里写一句这个效果是什么、用在哪',
  tags: tags.length ? tags : ['自定义'],
  loop,
  ...(loop ? {} : { duration }),
  output: { w: 640, h: 640, ...(alpha ? { alpha: true } : {}) },
  inputs: {},
  passes: [{ name: 'main', shader: 'shaders/main.frag', format: 'rgba8' }]
};

const frag = `// ${name}
// 起点：先在预览里确认能出图，再替换成真正的算法。
// 常用工具：vUv / u_time / u_t01（一次性效果进度） / sl_hash21 / sl_easeInOut

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);

  // 一个会呼吸的光环，方便确认时间与坐标都对
  // 注意：pow(x, 2.0) 在 x<0 时 GLSL 未定义，平方一律写成 q*q
  float q = (d - 0.45) / 0.06;
  float ring = exp(-q * q);
  float pulse = 0.6 + 0.4 * sin(u_time * 2.0 * TAU);

  vec3 col = vec3(0.55, 0.75, 1.0) * ring * pulse;
  fragColor = vec4(col, 1.0);
}
`;

await mkdir(path.join(dir, 'shaders'), { recursive: true });
await mkdir(path.join(dir, 'input'), { recursive: true });
await writeFile(path.join(dir, 'effect.json'), JSON.stringify(effect, null, 2) + '\n', 'utf8');
await writeFile(path.join(dir, 'shaders', 'main.frag'), frag, 'utf8');
await writeFile(path.join(dir, 'input', '.gitkeep'), '', 'utf8');

console.log(`✓ 已创建 effects/${id}`);
console.log('  下一步：');
console.log(`    1. 编辑 effects/${id}/shaders/main.frag`);
console.log('    2. node tools/lib.mjs build');
console.log('    3. 刷新 index.html 打开图库');
