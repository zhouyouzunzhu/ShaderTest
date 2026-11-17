#!/usr/bin/env node
/**
 * 效果库构建工具
 *
 *   node tools/lib.mjs build          扫描 effects/ 与 library/，校验并生成两份索引
 *   node tools/lib.mjs check          只校验，不写文件
 *   node tools/lib.mjs list           列出已有效果与图库素材
 *   node tools/lib.mjs import <file>  把页面导出的效果包 JSON 落成 effects/<id>/ 目录
 *
 * 为什么要有 index.js：页面用 file:// 直接双击打开时 fetch() 会被 CORS 拦住，
 * 用 <script src=".../index.js"> 设置 window.SL_EFFECTS / window.SL_LIBRARY 是唯一稳妥的读法。
 * index.json 给 AI / 工具 / 外部脚本读。
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EFFECTS_DIR = path.join(ROOT, 'content', 'effects');
const LIBRARY_DIR = path.join(ROOT, 'content', 'library');
const OUT_JSON = path.join(EFFECTS_DIR, 'index.json');
const OUT_JS = path.join(EFFECTS_DIR, 'index.js');
const OUT_LIB_JS = path.join(LIBRARY_DIR, 'index.js');
const OUT_LIB_JSON = path.join(LIBRARY_DIR, 'index.json');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_EDGE = 4096;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const EASINGS = new Set(['linear', 'in', 'out', 'inout', 'step']);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 从文件头读图片尺寸（PNG / JPEG），读不到就返回 0 —— 只为给页面省一次解码 */
function imageSize(buf, ext) {
  if (ext === '.png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  return { w: 0, h: 0 };
}

const kebab = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/i, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';

function err(list, where, msg) {
  list.push(`${where}: ${msg}`);
}

/** 读取并校验单个效果包 */
async function loadEffect(dirName, problems, libMap) {
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
    if (typeof def === 'string' && def.startsWith('library:')) {
      // 公共图库里的素材：只记引用，不把图复制进效果包
      const libId = def.slice(8);
      if (!libMap[libId]) {
        err(problems, where, `inputs.${slot} 引用的图库素材不存在：${libId}（把图放进 library/ 再跑 build）`);
        continue;
      }
      assets.push({ slot, kind: 'library', libId, name: libMap[libId].name });
      continue;
    }
    const file = typeof def === 'string' ? def : def && def.file;
    if (!file) { err(problems, where, `inputs.${slot} 需要写成 "builtin:名字"、"library:名字" 或 "input/xx.png"`); continue; }
    if (typeof def === 'string' && def.startsWith('data:')) {
      // 页面导出的效果包会内联用户拖进来的贴图，import 时会落成 input/xx.png
      err(problems, where, `inputs.${slot} 里是内联图片，请用 \`node tools/lib.mjs import\` 导入这个效果包`);
      continue;
    }
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
      // source = 中间态（不推进 prev 链，只能被「指定 Pass」采样）；filter = 叠加态
      role: p.role === 'source' ? 'source' : 'filter',
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

  // ---- 关键帧轨道：tracks.<passId>.<uniformName> = [{t,v,e}] ----
  const tracks = {};
  if (raw.tracks != null) {
    if (!isObj(raw.tracks)) err(problems, where, 'tracks 必须是对象：{ "p1": { "u_x": [{t,v,e}] } }');
    else {
      for (const pid of Object.keys(raw.tracks)) {
        if (!passIds.has(pid)) { err(problems, where, `tracks.${pid} 不是已存在的 Pass`); continue; }
        const uTracks = raw.tracks[pid];
        if (!isObj(uTracks)) { err(problems, where, `tracks.${pid} 必须是对象`); continue; }
        const out = {};
        for (const name of Object.keys(uTracks)) {
          const keys = uTracks[name];
          if (!Array.isArray(keys)) { err(problems, where, `tracks.${pid}.${name} 必须是数组`); continue; }
          const cleaned = [];
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (!isObj(key) || !isNum(key.t) || key.t < 0) {
              err(problems, where, `tracks.${pid}.${name}[${k}] 需要 { t: 秒（≥0）, v: 数值数组 }`);
              continue;
            }
            const v = Array.isArray(key.v) ? key.v.map(Number) : [Number(key.v)];
            if (!v.length || v.some((x) => !Number.isFinite(x))) {
              err(problems, where, `tracks.${pid}.${name}[${k}].v 必须是数值数组`);
              continue;
            }
            const e = EASINGS.has(key.e) ? key.e : 'linear';
            cleaned.push({ t: key.t, v, e });
          }
          cleaned.sort((a, b) => a.t - b.t);
          if (cleaned.length) out[name] = cleaned;
        }
        if (Object.keys(out).length) tracks[pid] = out;
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
    passes,
    tracks
  };
}

async function scan(problems, libMap) {
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
    const eff = await loadEffect(d, problems, libMap);
    if (eff) effects.push(eff);
  }
  const seen = new Set();
  for (const e of effects) {
    if (seen.has(e.id)) problems.push(`effects/${e.id}: id 重复`);
    seen.add(e.id);
  }
  return effects;
}

/** 扫描 library/：公共图库素材（图片内联成 dataURL，file:// 下才能当纹理用） */
async function scanLibrary(problems) {
  const items = [];
  let files = [];
  try {
    const ents = await readdir(LIBRARY_DIR, { withFileTypes: true });
    files = ents.filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name).sort();
  } catch (e) {
    problems.push(`library/: 目录不存在或读不了（${e.message}）`);
    return items;
  }
  let total = 0;
  for (const name of files) {
    const ext = path.extname(name).toLowerCase();
    const abs = path.join(LIBRARY_DIR, name);
    let buf;
    try {
      buf = await readFile(abs);
    } catch (e) {
      problems.push(`library/${name}: 读不了（${e.message}）`);
      continue;
    }
    const id = kebab(name);
    if (items.some((it) => it.id === id)) {
      problems.push(`library/${name}: 生成的 id「${id}」和别的文件撞了，改个文件名`);
      continue;
    }
    const mime = ext === '.webp' ? 'image/webp' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
    const size = imageSize(buf, ext);
    total += buf.length;
    items.push({
      id,
      name: name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim(),
      file: `library/${name}`,
      bytes: buf.length,
      w: size.w,
      h: size.h,
      dataURL: `data:${mime};base64,${buf.toString('base64')}`
    });
  }
  if (total > 6 * 1024 * 1024) {
    problems.push(`library/: 素材合计 ${(total / 1048576).toFixed(1)}MB，内联进 index.js 后页面会明显变慢，建议压到 6MB 以内`);
  }
  return items;
}

async function build({ write }) {
  const problems = [];
  const library = await scanLibrary(problems);
  const libMap = {};
  for (const it of library) libMap[it.id] = it;
  const effects = await scan(problems, libMap);

  if (problems.length) {
    console.error(`\n✗ 校验失败（${problems.length} 处）\n`);
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
  const libDoc = {
    version: 1,
    builtAt: doc.builtAt,
    items: library
  };

  if (write) {
    await writeFile(OUT_JSON, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    await writeFile(OUT_JS,
      '/* 由 tools/lib.mjs 生成，别手改；改 effects/<id>/ 后跑 node tools/lib.mjs build */\n' +
      'window.SL_EFFECTS = ' + JSON.stringify(doc) + ';\n', 'utf8');
    await mkdir(LIBRARY_DIR, { recursive: true });
    await writeFile(OUT_LIB_JSON, JSON.stringify(libDoc, null, 2) + '\n', 'utf8');
    await writeFile(OUT_LIB_JS,
      '/* 由 tools/lib.mjs 生成，别手改；往 library/ 里加图后跑 node tools/lib.mjs build */\n' +
      'window.SL_LIBRARY = ' + JSON.stringify(libDoc) + ';\n', 'utf8');
  }

  const total = effects.length;
  const passCount = effects.reduce((n, e) => n + e.passes.length, 0);
  const oneShot = effects.filter((e) => !e.loop).length;
  const anim = effects.filter((e) => Object.keys(e.tracks || {}).length).length;
  console.log(`\n${write ? '✓ 已生成 effects/index.json + index.js、library/index.json + index.js' : '✓ 校验通过（未写入）'}`);
  console.log(`  ${total} 个效果 · ${passCount} 个 Pass · ${oneShot} 个一次性 · ${anim} 个带关键帧`);
  for (const e of effects) {
    const tags = e.tags.length ? '  [' + e.tags.join(', ') + ']' : '';
    const dur = e.loop ? 'loop' : `${e.duration}s`;
    console.log(`  · ${e.id.padEnd(18)} ${e.name}  ${dur}  ${e.passes.length}p${tags}`);
  }
  const kb = library.reduce((n, it) => n + it.bytes, 0);
  console.log(`  ${library.length} 张图库素材 · ${(kb / 1024).toFixed(0)}KB`);
  for (const it of library) {
    console.log(`  · library/${it.id.padEnd(16)} ${it.name}  ${it.w}×${it.h}`);
  }
  console.log('');
  return { doc, libDoc };
}

/** 把页面导出的效果包 JSON 落成目录 */
async function importPack(file) {
  if (!file) {
    console.error('用法: node tools/lib.mjs import <效果包.json>');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  let payload;
  try {
    payload = JSON.parse(await readFile(abs, 'utf8'));
  } catch (e) {
    console.error(`读不了 ${file}：${e.message}`);
    process.exit(1);
  }
  const eff = payload && payload.effect;
  if (!isObj(eff) || !eff.id || !Array.isArray(eff.passes) || !eff.passes.length) {
    console.error('这个 JSON 不像效果包：需要 { effect: {...}, shaders: { "shaders/p1.frag": "..." } }');
    process.exit(1);
  }
  if (!ID_RE.test(eff.id)) {
    console.error(`效果 id 只能是 kebab-case：${eff.id}`);
    process.exit(1);
  }
  const dir = path.join(EFFECTS_DIR, eff.id);
  let exists = false;
  try { await stat(dir); exists = true; } catch (_) { exists = false; }
  if (exists) {
    console.error(`effects/${eff.id}/ 已存在，换个 id 或先删掉旧目录`);
    process.exit(1);
  }
  await mkdir(dir, { recursive: true });
  const shaders = payload.shaders || {};
  for (const file of Object.keys(shaders)) {
    const out = path.join(dir, file);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, String(shaders[file]), 'utf8');
  }

  // 内联的图片（页面里拖进来的贴图）落成 input/<slot>.png，json 里改成相对路径
  let inlined = 0;
  if (isObj(eff.inputs)) {
    for (const slot of Object.keys(eff.inputs)) {
      const def = eff.inputs[slot];
      if (typeof def !== 'string' || !def.startsWith('data:')) continue;
      const m = /^data:image\/([a-z]+);base64,(.+)$/i.exec(def);
      if (!m) {
        console.error(`inputs.${slot} 的图片格式不认识（只支持 png / jpeg / webp）`);
        process.exit(1);
      }
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const rel = `input/${slot}.${ext}`;
      const out = path.join(dir, rel);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(m[2], 'base64'));
      eff.inputs[slot] = rel;
      inlined += 1;
    }
  }

  await writeFile(path.join(dir, 'effect.json'), JSON.stringify(eff, null, 2) + '\n', 'utf8');
  console.log(`✓ 已生成 effects/${eff.id}/（${eff.passes.length} 个 Pass，${Object.keys(shaders).length} 个 shader${inlined ? `，${inlined} 张内联图落成文件` : ''}）`);
  console.log('  接着跑：node tools/lib.mjs build');
}

const cmd = process.argv[2] || 'build';
if (cmd === 'build') await build({ write: true });
else if (cmd === 'check') await build({ write: false });
else if (cmd === 'list') {
  const doc = await build({ write: false });
  if (!doc) process.exit(1);
} else if (cmd === 'import') await importPack(process.argv[3]);
else {
  console.error('用法: node tools/lib.mjs [build|check|list|import <file>]');
  process.exit(1);
}
