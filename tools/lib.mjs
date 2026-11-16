#!/usr/bin/env node
/**
 * 效果库构建工具
 *
 *   node tools/lib.mjs build     扫描 effects/，校验并生成 effects/index.json + effects/index.js
 *   node tools/lib.mjs check     只校验，不写文件
 *   node tools/lib.mjs list      列出已有效果
 *
 * 为什么要有 index.js：页面用 file:// 直接双击打开时 fetch() 会被 CORS 拦住，
 * 用 <script src="effects/index.js"> 设置 window.SL_EFFECTS 是唯一稳妥的读法。
 * index.json 给 AI / 工具 / 外部脚本读。
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EFFECTS_DIR = path.join(ROOT, 'effects');
const OUT_JSON = path.join(EFFECTS_DIR, 'index.json');
const OUT_JS = path.join(EFFECTS_DIR, 'index.js');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_EDGE = 4096;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function err(list, where, msg) {
  list.push(`${where}: ${msg}`);
}

/** 读取并校验单个效果包 */
async function loadEffect(dirName, problems) {
  const dir = path.join(EFFECTS_DIR, dirName);
  const where = `effects/${dirName}`;
  const jsonPath = path.join(dir, 'effect.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (e) {
    err(problems, where, `读不到或解析不了 effect.json（${e.message}）`);
    return null;
  }
  if (!isObj(raw)) {
    err(problems, where, 'effect.json 顶层必须是对象');
    return null;
  }

  const id = raw.id || dirName;
  if (!ID_RE.test(id)) err(problems, where, `id 只能是 kebab-case（${id}）`);
  if (raw.id && raw.id !== dirName) err(problems, where, `id（${raw.id}）必须和目录名（${dirName}）一致`);
  if (!raw.name) err(problems, where, '缺少 name');

  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
  if (raw.tags != null && !Array.isArray(raw.tags)) err(problems, where, 'tags 必须是字符串数组');

  const duration = isNum(raw.duration) ? raw.duration : 0;
  const loop = raw.loop !== false;      // 默认循环，显式写 false 才是一次性效果
  if (!loop && !(duration > 0)) err(problems, where, '一次性效果（loop:false）必须给 duration > 0');
  if (duration < 0) err(problems, where, 'duration 不能是负数');

  const out = isObj(raw.output) ? raw.output : {};
  const w = Math.round(isNum(out.w) ? out.w : 512);
  const h = Math.round(isNum(out.h) ? out.h : 512);
  if (w < 16 || w > MAX_EDGE) err(problems, where, `output.w 需要在 16~${MAX_EDGE}（现在是 ${w}）`);
  if (h < 16 || h > MAX_EDGE) err(problems, where, `output.h 需要在 16~${MAX_EDGE}（现在是 ${h}）`);

  // ---- 输入图：内置贴图或同目录图片文件 ----
  const inputs = isObj(raw.inputs) ? raw.inputs : {};
  const assets = [];
  for (const slot of Object.keys(inputs)) {
    const def = inputs[slot];
    if (typeof def === 'string' && def.startsWith('builtin:')) {
      assets.push({ slot, kind: 'builtin', builtin: def.slice(8) });
      continue;
    }
    const file = typeof def === 'string' ? def : def && def.file;
    if (!file) { err(problems, where, `inputs.${slot} 需要写成 "builtin:名字" 或 "input/xx.png"`); continue; }
    const abs = path.join(dir, file);
    try {
      const buf = await readFile(abs);
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp' : 'image/png';
      assets.push({
        slot,
        kind: 'file',
        name: path.basename(file),
        mime,
        dataURL: `data:${mime};base64,${buf.toString('base64')}`
      });
    } catch (e) {
      err(problems, where, `inputs.${slot} 指向的文件不存在：${file}`);
    }
  }

  // ---- Pass ----
  const list = Array.isArray(raw.passes) ? raw.passes : [];
  if (!list.length) err(problems, where, '至少需要一个 pass');
  const passes = [];
  const passIds = new Set();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const pid = `p${i + 1}`;
    passIds.add(pid);
    if (!isObj(p)) { err(problems, where, `passes[${i}] 必须是对象`); continue; }
    const shaderFile = p.shader || (p.code && p.code.endsWith('.frag') ? p.code : null);
    if (!shaderFile) { err(problems, where, `passes[${i}] 缺少 shader 字段（指向 .frag 文件）`); continue; }
    let code = '';
    try {
      code = await readFile(path.join(dir, shaderFile), 'utf8');
    } catch (e) {
      err(problems, where, `passes[${i}] 的 shader 文件不存在：${shaderFile}`);
      continue;
    }
    if (!/void\s+main\s*\(/.test(code) && !/void\s+mainImage\s*\(/.test(code)) {
      err(problems, where, `passes[${i}] 的 shader 里找不到 main() 或 mainImage()`);
    }
    const format = p.format === 'hdr' ? 'hdr' : 'rgba8';
    const scale = isNum(p.scale) ? Math.min(4, Math.max(0.05, p.scale)) : 1;
    const bindings = {};
    if (p.bindings != null && !isObj(p.bindings)) err(problems, where, `passes[${i}].bindings 必须是对象`);
    else if (isObj(p.bindings)) {
      for (const s of Object.keys(p.bindings)) {
        const b = p.bindings[s];
        if (!isObj(b)) { err(problems, where, `passes[${i}].bindings.${s} 必须是对象`); continue; }
        if (b.kind === 'asset') {
          if (!b.input || !(b.input in inputs)) {
            err(problems, where, `passes[${i}].bindings.${s}.input 指向了未声明的输入（${b.input}）`);
            continue;
          }
          bindings[s] = { kind: 'asset', input: b.input };
        } else if (b.kind === 'pass') {
          const target = b.pass;
          if (!/^p\d+$/.test(target || '')) {
            err(problems, where, `passes[${i}].bindings.${s}.pass 需要形如 p1（或 __source__）`);
            continue;
          }
          bindings[s] = { kind: 'pass', pass: target };
        } else if (b.kind === 'prev' || b.kind === 'self' || b.kind === 'none') {
          bindings[s] = { kind: b.kind };
        } else {
          err(problems, where, `passes[${i}].bindings.${s}.kind 只能是 asset/pass/prev/self/none`);
        }
      }
    }
    const values = {};
    if (isObj(p.values)) {
      for (const k of Object.keys(p.values)) {
        const v = p.values[k];
        values[k] = Array.isArray(v) ? v.map(Number) : [Number(v)];
      }
    }
    passes.push({
      id: pid,
      name: p.name || `Pass ${i + 1}`,
      code,
      format,
      scale,
      bindings,
      values
    });
  }
  // 绑定里的 pass 目标必须存在，且不能引用自己之后才存在的 Pass 以外的非法 id
  for (const p of passes) {
    for (const s of Object.keys(p.bindings)) {
      const b = p.bindings[s];
      if (b.kind === 'pass' && b.pass !== '__source__' && !passIds.has(b.pass)) {
        err(problems, where, `${p.name} 的 ${s} 绑定了不存在的 Pass（${b.pass}）`);
      }
    }
  }

  return {
    id,
    name: raw.name || id,
    desc: typeof raw.desc === 'string' ? raw.desc : '',
    tags,
    duration,
    loop,
    output: { w, h, alpha: !!out.alpha },
    source: typeof raw.source === 'string' ? raw.source : '',
    assets,
    passes
  };
}

async function scan(problems) {
  let dirs = [];
  try {
    const ents = await readdir(EFFECTS_DIR, { withFileTypes: true });
    dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch (e) {
    problems.push(`effects/: 目录不存在或读不了（${e.message}）`);
    return [];
  }
  const effects = [];
  for (const d of dirs) {
    const eff = await loadEffect(d, problems);
    if (eff) effects.push(eff);
  }
  const seen = new Set();
  for (const e of effects) {
    if (seen.has(e.id)) problems.push(`effects/${e.id}: id 重复`);
    seen.add(e.id);
  }
  return effects;
}

async function build({ write }) {
  const problems = [];
  const effects = await scan(problems);

  if (problems.length) {
    console.error(`\n✗ 效果库校验失败（${problems.length} 处）\n`);
    for (const p of problems) console.error('  · ' + p);
    console.error('\n先修好上面这些再构建。');
    process.exitCode = 1;
    return null;
  }

  const doc = {
    version: 1,
    builtAt: new Date().toISOString(),
    effects
  };

  if (write) {
    await writeFile(OUT_JSON, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    await writeFile(OUT_JS,
      '/* 由 tools/lib.mjs 生成，别手改；改 effects/<id>/ 后跑 node tools/lib.mjs build */\n' +
      'window.SL_EFFECTS = ' + JSON.stringify(doc) + ';\n', 'utf8');
  }

  const total = effects.length;
  const passCount = effects.reduce((n, e) => n + e.passes.length, 0);
  const oneShot = effects.filter((e) => !e.loop).length;
  console.log(`\n${write ? '✓ 已生成 effects/index.json + index.js' : '✓ 校验通过（未写入）'}`);
  console.log(`  ${total} 个效果 · ${passCount} 个 Pass · ${oneShot} 个一次性效果`);
  for (const e of effects) {
    const tags = e.tags.length ? '  [' + e.tags.join(', ') + ']' : '';
    const dur = e.loop ? 'loop' : `${e.duration}s`;
    console.log(`  · ${e.id.padEnd(18)} ${e.name}  ${dur}  ${e.passes.length}p${tags}`);
  }
  console.log('');
  return doc;
}

const cmd = process.argv[2] || 'build';
if (cmd === 'build') await build({ write: true });
else if (cmd === 'check') await build({ write: false });
else if (cmd === 'list') {
  const doc = await build({ write: false });
  if (!doc) process.exit(1);
} else {
  console.error('用法: node tools/lib.mjs [build|check|list]');
  process.exit(1);
}
