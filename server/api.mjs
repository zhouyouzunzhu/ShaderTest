// ShaderLab 本地服务：静态托管 + 把「库」落到项目目录
// - 零依赖（只用 node:http / fs）
// - 只监听 127.0.0.1，不暴露到局域网
// - 所有写盘都先写临时文件再 rename，避免 Windows 下读到半个文件

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir, unlink, rename, stat } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const CONTENT_DIR = join(ROOT, 'content');
const PASSES_DIR = join(CONTENT_DIR, 'passes');
const LIB_DIR = join(CONTENT_DIR, 'library');
const EFFECTS_DIR = join(CONTENT_DIR, 'effects');
const STATE_DIR = join(ROOT, '.state');
const DOC_FILE = join(STATE_DIR, 'project.json');
// 对外暴露的相对前缀：静态托管以 ROOT 为根，所以 content/ 也要带在 URL 里
const LIB_URL = 'content/library/';
const EFFECTS_URL = 'content/effects/';

const PASS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/* ------------------------------ 热更新广播 ------------------------------ */
// 前端用 EventSource('/api/events') 订阅：改了 passes/、library/、effects/ 里的文件，页面自动重载对应库。

const sseClients = new Set();
let sseTimer = null;
const pendingKinds = new Set();

function broadcast() {
  const payload = JSON.stringify({ kinds: Array.from(pendingKinds), at: Date.now() });
  pendingKinds.clear();
  for (const res of sseClients) {
    try { res.write('data: ' + payload + '\n\n'); } catch (e) { sseClients.delete(res); }
  }
}

function noteChange(kind) {
  pendingKinds.add(kind);
  if (sseTimer) return;
  sseTimer = setTimeout(function () { sseTimer = null; broadcast(); }, 220);
}

function watchDir(dir, kind) {
  try {
    const w = watch(dir, { recursive: true }, function (evt, file) {
      if (!file) return;
      const f = String(file);
      // 忽略自己写盘时的临时文件与编辑器备份
      if (/\.tmp-|~$|\.swp$|^\.git/.test(f)) return;
      noteChange(kind);
    });
    w.on('error', function () {});
    return w;
  } catch (e) {
    return null;
  }
}

let watchers = null;
function startWatchers() {
  if (watchers) return;
  watchers = [
    watchDir(PASSES_DIR, 'passes'),
    watchDir(LIB_DIR, 'library'),
    watchDir(EFFECTS_DIR, 'effects')
  ].filter(Boolean);
}

/* ------------------------------- 小工具 ------------------------------- */

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体太大（上限 ' + Math.round(limit / 1024) + ' KB）');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJSON(req, limit) {
  const buf = await readBody(req, limit || 4 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

async function writeAtomic(file, data) {
  await ensureDir(dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/** 把 URL 路径安全地映射到仓库内；越界返回 null */
function safeJoin(rel) {
  const clean = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
  const full = resolve(ROOT, clean);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

/* ------------------------------- passes ------------------------------- */

function passMeta(id, mod) {
  const m = mod && mod.default ? mod.default : mod;
  if (!m || typeof m.code !== 'string' || !m.code.trim()) return null;
  return {
    id: id,
    name: String(m.name || id),
    group: String(m.group || '我的 Pass'),
    role: m.role === 'source' ? 'source' : 'filter',
    desc: String(m.desc || ''),
    code: m.code
  };
}

async function listPasses() {
  await ensureDir(PASSES_DIR);
  const files = (await readdir(PASSES_DIR)).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.(mjs|js)$/, '');
    if (!PASS_ID.test(id)) continue;
    try {
      const url = pathToFileURL(join(PASSES_DIR, f)).href + '?t=' + Date.now();
      const mod = await import(url);
      const meta = passMeta(id, mod);
      if (meta) out.push(meta);
      else console.warn('[passes] 跳过（没有 default.code）:', f);
    } catch (e) {
      console.warn('[passes] 跳过（导入失败）:', f, e.message);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** 一文件一个 Pass：把模板序列化回可读的 .mjs */
function passToSource(meta) {
  const q = (s) => JSON.stringify(String(s));
  return `// ShaderLab Pass 模板：${meta.name}
// 改完刷新页面就生效（服务会自动重新载入）。可以手写，也可以让 AI 生成。

export default {
  name: ${q(meta.name)},
  group: ${q(meta.group || '我的 Pass')},
  role: ${q(meta.role === 'source' ? 'source' : 'filter')},
  desc: ${q(meta.desc || '')},
  code: \`
${String(meta.code).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
\`
};
`;
}

/* ------------------------------- library ------------------------------- */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const UPLOAD_NAME = /^[A-Za-z0-9._-]{1,64}$/;

async function listLibrary() {
  await ensureDir(LIB_DIR);
  const files = (await readdir(LIB_DIR)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
  const out = [];
  for (const f of files) {
    const st = await stat(join(LIB_DIR, f));
    out.push({ file: f, url: LIB_URL + encodeURIComponent(f), bytes: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/* ------------------------------- effects ------------------------------- */

async function listEffects() {
  await ensureDir(EFFECTS_DIR);
  const dirs = (await readdir(EFFECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out = [];
  for (const d of dirs) {
    const file = join(EFFECTS_DIR, d.name, 'effect.json');
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const shaders = {};
      for (const p of raw.passes || []) {
        if (!p || !p.shader) continue;
        const target = safeJoin(join('content', 'effects', d.name, p.shader));
        if (target && existsSync(target)) shaders[p.shader] = await readFile(target, 'utf8');
      }
      out.push({ id: d.name, effect: raw, shaders });
    } catch (e) {
      console.warn('[effects] 跳过（解析失败）:', d.name, e.message);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/* -------------------------------- 路由 -------------------------------- */

export function createApi() {
  return async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, '');
    const method = req.method || 'GET';

    if (p === '/ping') return sendJSON(res, 200, { ok: true, root: ROOT, version: 1 });

    /* ---- 热更新（SSE） ---- */
    if (p === '/events') {
      startWatchers();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 1500\n\n');
      res.write('data: ' + JSON.stringify({ kinds: ['hello'], at: Date.now() }) + '\n\n');
      sseClients.add(res);
      const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) { /* 断开时由 close 清理 */ } }, 25000);
      req.on('close', function () {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return undefined;
    }

    /* ---- passes ---- */
    if (p === '/passes' && method === 'GET') {
      return sendJSON(res, 200, { passes: await listPasses() });
    }
    const mPass = p.match(/^\/passes\/([^/]+)$/);
    if (mPass) {
      const id = decodeURIComponent(mPass[1]);
      if (!PASS_ID.test(id)) return sendJSON(res, 400, { error: 'Pass id 只能用 a-z 0-9 和短横线' });
      const file = join(PASSES_DIR, id + '.mjs');
      if (method === 'PUT') {
        const body = await readJSON(req);
        const meta = passMeta(id, body);
        if (!meta) return sendJSON(res, 400, { error: '缺少 code' });
        await ensureDir(PASSES_DIR);
        await writeAtomic(file, passToSource(meta));
        return sendJSON(res, 200, { ok: true, file: 'content/passes/' + id + '.mjs' });
      }
      if (method === 'DELETE') {
        if (!existsSync(file)) return sendJSON(res, 404, { error: '没有这个 Pass' });
        await unlink(file);
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ---- library ---- */
    if (p === '/library' && method === 'GET') return sendJSON(res, 200, { items: await listLibrary() });
    if (p === '/library' && method === 'POST') {
      const name = url.searchParams.get('name') || '';
      if (!UPLOAD_NAME.test(name)) return sendJSON(res, 400, { error: '文件名不合法' });
      const buf = await readBody(req, 32 * 1024 * 1024);
      await ensureDir(LIB_DIR);
      await writeAtomic(join(LIB_DIR, name), buf);
      return sendJSON(res, 200, { ok: true, url: LIB_URL + encodeURIComponent(name) });
    }
    const mLib = p.match(/^\/library\/([^/]+)$/);
    if (mLib && method === 'DELETE') {
      const name = decodeURIComponent(mLib[1]);
      if (!UPLOAD_NAME.test(name)) return sendJSON(res, 400, { error: '文件名不合法' });
      const file = join(LIB_DIR, name);
      if (!existsSync(file)) return sendJSON(res, 404, { error: '没有这张图' });
      await unlink(file);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---- effects ---- */
    if (p === '/effects' && method === 'GET') return sendJSON(res, 200, { effects: await listEffects() });
    const mEff = p.match(/^\/effects\/([^/]+)$/);
    if (mEff && method === 'PUT') {
      const id = decodeURIComponent(mEff[1]);
      if (!PASS_ID.test(id)) return sendJSON(res, 400, { error: '效果 id 只能用 a-z 0-9 和短横线' });
      const body = await readJSON(req);
      if (!body || !body.effect) return sendJSON(res, 400, { error: '缺少 effect' });
      const dir = join(EFFECTS_DIR, id);
      await ensureDir(join(dir, 'shaders'));
      for (const [rel, text] of Object.entries(body.shaders || {})) {
        const target = safeJoin(join('content', 'effects', id, rel));
        if (!target) return sendJSON(res, 400, { error: 'shader 路径越界: ' + rel });
        await writeAtomic(target, String(text));
      }
      await writeAtomic(join(dir, 'effect.json'), JSON.stringify(body.effect, null, 2) + '\n');
      return sendJSON(res, 200, { ok: true });
    }

    /* ---- 当前工程 ---- */
    if (p === '/doc' && method === 'GET') {
      if (!existsSync(DOC_FILE)) return sendJSON(res, 200, { doc: null });
      return sendJSON(res, 200, { doc: JSON.parse(await readFile(DOC_FILE, 'utf8')) });
    }
    if (p === '/doc' && method === 'PUT') {
      const body = await readJSON(req, 16 * 1024 * 1024);
      await writeAtomic(DOC_FILE, JSON.stringify(body && body.doc ? body.doc : body, null, 2) + '\n');
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: '没有这个接口: ' + p });
  };
}

/* ------------------------------ 静态文件 ------------------------------ */

export function createStatic(rootDir) {
  return async function serve(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = safeJoin(rel);
    if (!file) return sendText(res, 403, 'forbidden');
    try {
      const st = await stat(file);
      if (st.isDirectory()) return serve(req, res, new URL(url.pathname.replace(/\/?$/, '/') + 'index.html', url));
      const buf = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length });
      res.end(buf);
    } catch (e) {
      sendText(res, 404, 'not found: ' + rel);
    }
  };
}

/* ------------------------------ 组装服务 ------------------------------ */

export function createEditorServer(options) {
  const opts = options || {};
  const api = createApi();
  const serve = createStatic(ROOT);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return await serve(req, res, url);
    } catch (e) {
      console.error('[server]', req.method, url.pathname, e && e.message);
      if (!res.headersSent) sendJSON(res, 500, { error: e && e.message ? e.message : String(e) });
      else res.end();
    }
  });
}

export { ROOT };
