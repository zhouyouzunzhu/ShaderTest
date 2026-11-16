// ShaderLab 本地服务探测（server/ 目录那套）
// 有服务：passes / library / effects / project.json 都落在项目目录，页面里能直接存；
// 没服务（双击 index.html）：退回浏览器本地存储，功能不变但不能写盘。

(function () {
  const SL = (window.SL = window.SL || {});

  function req(method, url, body, raw) {
    const opt = { method: method, cache: 'no-store' };
    if (body !== undefined) {
      opt.headers = raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' };
      opt.body = raw ? body : JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  SL.server = {
    on: false,
    root: '',
    checked: false,

    /** 探活；file:// 下 fetch 会直接抛错，这里吞掉 */
    init: function () {
      if (typeof fetch !== 'function' || location.protocol === 'file:') {
        SL.server.checked = true;
        return Promise.resolve(false);
      }
      return fetch('/api/ping', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          SL.server.checked = true;
          if (d && d.ok) { SL.server.on = true; SL.server.root = d.root || ''; }
          return SL.server.on;
        })
        .catch(function () { SL.server.checked = true; return false; });
    },

    listPasses: function () { return req('GET', '/api/passes').then(function (d) { return d.passes || []; }); },
    putPass: function (id, meta) { return req('PUT', '/api/passes/' + encodeURIComponent(id), meta); },
    delPass: function (id) { return req('DELETE', '/api/passes/' + encodeURIComponent(id)); },

    listLibrary: function () { return req('GET', '/api/library').then(function (d) { return d.items || []; }); },
    uploadLibrary: function (name, buf) { return req('POST', '/api/library?name=' + encodeURIComponent(name), buf, true); },
    delLibrary: function (name) { return req('DELETE', '/api/library/' + encodeURIComponent(name)); },

    listEffects: function () { return req('GET', '/api/effects').then(function (d) { return d.effects || []; }); },
    putEffect: function (id, effect, shaders) {
      return req('PUT', '/api/effects/' + encodeURIComponent(id), { effect: effect, shaders: shaders || {} });
    },

    getDoc: function () { return req('GET', '/api/doc').then(function (d) { return d.doc || null; }); },
    putDoc: function (doc) { return req('PUT', '/api/doc', { doc: doc }); }
  };
})();
