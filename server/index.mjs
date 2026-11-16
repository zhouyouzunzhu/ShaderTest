// 启动入口：node server/index.mjs [--port 5177] [--open]
// 只监听 127.0.0.1；静态托管仓库根目录，/api/* 走 server/api.mjs

import { createEditorServer, ROOT } from './api.mjs';
import { exec } from 'node:child_process';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes('--' + name);

const port = Number(flag('port', process.env.PORT || 5177));
const host = '127.0.0.1';

const server = createEditorServer();
server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log(`ShaderLab  http://${host}:${port}/`);
  console.log(`  根目录  ${ROOT}`);
  console.log('  passes/  library/  effects/  project.json 都可以直接读写');
  if (has('open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 被占用了，换一个：node server/index.mjs --port 5180`);
    process.exit(1);
  }
  throw e;
});
