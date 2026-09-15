// Runtime bootstrap for the standalone build.
//
// Inlined verbatim into dist/cubeworld.html by scripts/build-standalone.mjs.
// Kept as a real file rather than a template string so the regular expressions
// below need no escaping.
//
// It reads the embedded module sources, registers each one as a Blob URL in
// dependency order (rewriting import specifiers to those URLs as it goes), and
// finally imports the entry module. No server, no network, no import map.
(async () => {
  const read = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent : null;
  };

  const threeSrc = read('cw-three');
  const modulesJson = read('cw-modules');
  if (!threeSrc || !modulesJson) {
    document.body.innerHTML =
      '<pre style="color:#f88;font:13px monospace;padding:24px">CubeWorld: embedded payload missing.</pre>';
    return;
  }

  const THREE_PATH = 'vendor/three/three.module.js';
  const sources = JSON.parse(modulesJson.replace(/<\\\/script/gi, '</script'));

  const urls = new Map();
  const makeBlob = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

  // Only real module specifiers: bare "three", or a relative path ending in .js.
  // A looser pattern also matches prose inside comments and strings, which would
  // leave a module registered under a bogus name and the page unable to boot.
  const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])((?:\.\.?\/)[^'"\n]*?\.js|three)(['"])/g;

  const resolve = (from, spec) => {
    if (spec === 'three') return THREE_PATH;
    if (spec.charAt(0) !== '.') return spec;
    const base = from.split('/').slice(0, -1);
    const parts = spec.split('/');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '.' || part === '') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    return base.join('/');
  };

  // three.js has no relative imports of its own, so it goes first.
  urls.set(THREE_PATH, makeBlob(threeSrc));

  const pending = new Map(Object.entries(sources));
  const maxPasses = pending.size + 2;
  for (let pass = 0; pass < maxPasses && pending.size > 0; pass++) {
    let progressed = false;
    for (const entry of Array.from(pending)) {
      const rel = entry[0];
      const src = entry[1];
      let ready = true;
      const rewritten = src.replace(IMPORT_RE, (match, head, quote, spec, close) => {
        const target = resolve(rel, spec);
        const url = urls.get(target);
        if (!url) {
          ready = false;
          return match;
        }
        return head + quote + url + close;
      });
      if (!ready) continue;
      urls.set(rel, makeBlob(rewritten));
      pending.delete(rel);
      progressed = true;
    }
    if (!progressed) break;
  }

  if (pending.size > 0) {
    document.body.innerHTML =
      '<pre style="color:#f88;font:13px monospace;padding:24px;white-space:pre-wrap">' +
      'CubeWorld: could not resolve ' +
      pending.size +
      ' module(s):\n' +
      Array.from(pending.keys()).join('\n') +
      '</pre>';
    return;
  }

  try {
    await import(urls.get('src/main.js'));
  } catch (e) {
    document.body.innerHTML =
      '<pre style="color:#f88;font:13px monospace;padding:24px;white-space:pre-wrap">CubeWorld failed to start\n\n' +
      (e && e.stack ? e.stack : String(e)) +
      '</pre>';
  }
})();
