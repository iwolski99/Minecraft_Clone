// Shared TypeScript compilation helpers.
//
// The project intentionally drives the TypeScript compiler in-process instead of
// shelling out to a bundler: it keeps `npm run dev` / `npm run build` working in
// constrained environments and removes an entire class of toolchain failures.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  skipLibCheck: true,
  noFallthroughCasesInSwitch: true,
  useDefineForClassFields: true,
  isolatedModules: true,
  sourceMap: false,
  declaration: false,
  removeComments: false,
  forceConsistentCasingInFileNames: true,
  types: [],
};

/** Collect every .ts file under src/ (excluding ambient .d.ts). */
export function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

function formatDiagnostic(d) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    const rel = path.relative(ROOT, d.file.fileName);
    return `${rel}(${line + 1},${character + 1}): error TS${d.code}: ${msg}`;
  }
  return `error TS${d.code}: ${msg}`;
}

function report(diagnostics) {
  const list = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  for (const d of list) console.error(formatDiagnostic(d));
  return list;
}

/**
 * Compile the whole program once.
 * @param {string} outDir
 * @returns {{ ok: boolean, emitted: string[] }}
 */
export function compileOnce(outDir) {
  const files = sourceFiles();
  const program = ts.createProgram(files, { ...COMPILER_OPTIONS, outDir, rootDir: ROOT });
  const errors = report(ts.getPreEmitDiagnostics(program));
  if (errors.length) return { ok: false, emitted: [] };

  const emitted = [];
  const result = program.emit(undefined, (fileName, data) => {
    fs.mkdirSync(path.dirname(fileName), { recursive: true });
    fs.writeFileSync(fileName, data);
    emitted.push(fileName);
  });
  const post = report(result.diagnostics);
  return { ok: post.length === 0, emitted };
}

/**
 * Copy a file, retrying briefly on Windows sharing violations.
 *
 * A running dev server can hand the same destination to a browser at the moment
 * the watcher rebuilds, which surfaces as EBUSY. Asset copying must never be
 * able to kill the dev server, so this returns false instead of throwing.
 */
function safeCopy(src, dst, attempts = 6) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  for (let i = 0; i < attempts; i++) {
    try {
      fs.copyFileSync(src, dst);
      return true;
    } catch (e) {
      const code = e && e.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
        console.warn(`  asset copy failed for ${path.basename(dst)}: ${code ?? e}`);
        return false;
      }
      // brief spin: the handle is almost always released within a few ms
      const until = Date.now() + 12 * (i + 1);
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  console.warn(`  asset copy skipped (file busy): ${path.relative(ROOT, dst)}`);
  return false;
}

/** Copy the static shell + the three.js runtime into an output directory. */
export function copyStatic(outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  // every .html entry point at the repo root (index.html, diagnostic.html, ...)
  for (const name of fs.readdirSync(ROOT)) {
    if (!name.endsWith('.html')) continue;
    safeCopy(path.join(ROOT, name), path.join(outDir, name));
  }

  // stylesheets and any other non-TS assets that live under src/
  const copyAssets = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) copyAssets(p);
      else if (!e.name.endsWith('.ts')) safeCopy(p, path.join(outDir, path.relative(ROOT, p)));
    }
  };
  copyAssets(path.join(ROOT, 'src'));

  // Only the ES module build is used, and it is self-contained (no relative
  // imports). Copying the webgpu/node bundles as well costs ~6 MB per rebuild
  // and was the source of the EBUSY crashes.
  const threeBuild = path.join(ROOT, 'node_modules', 'three', 'build');
  const vendorDir = path.join(outDir, 'vendor', 'three');
  const needed = ['three.module.js'];
  const main = path.join(threeBuild, 'three.module.js');
  if (fs.existsSync(main)) {
    const src = fs.readFileSync(main, 'utf8');
    for (const m of src.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) needed.push(path.basename(m[1]));
  }
  for (const f of needed) {
    const from = path.join(threeBuild, f);
    if (fs.existsSync(from)) safeCopy(from, path.join(vendorDir, f));
  }
}

/** Start an incremental watch build. Returns the watch program handle. */
export function watchBuild(outDir, onDone) {
  const options = { ...COMPILER_OPTIONS, outDir, rootDir: ROOT };
  let lastEmit = 0;
  const notify = () => {
    // debounce: one notification per build, not per emitted file
    const now = Date.now();
    if (now - lastEmit < 50) return;
    lastEmit = now;
    if (onDone) onDone();
  };

  const host = ts.createWatchCompilerHost(
    path.join(ROOT, 'tsconfig.json'),
    options,
    ts.sys,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    (d) => {
      if (d.code === 6194 || d.code === 6193) return; // "starting compilation" / "found N errors"
      const line = formatDiagnostic(d);
      if (d.category === ts.DiagnosticCategory.Error) console.error(line);
    },
    () => undefined,
  );

  // Force our own file list so tsconfig `include` cannot drift from the watcher.
  const origCreate = host.createProgram;
  host.createProgram = (rootNames, opts, host2, oldProgram) =>
    origCreate(sourceFiles(), opts, host2, oldProgram);

  // Emit, then notify explicitly: relying on the watch-status callback meant the
  // static assets were only re-copied when TypeScript happened to report a
  // status change, so edited output could sit stale on disk.
  const origPost = host.afterProgramCreate;
  host.afterProgramCreate = (program) => {
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (diags.length) {
      for (const d of diags) console.error(formatDiagnostic(d));
      console.error(`\n  ${diags.length} type error(s) - output not updated\n`);
      return;
    }
    if (origPost) origPost(program);
    // `program.emit()` has run by now; write the static shell alongside it
    try {
      copyStatic(outDir);
    } catch (e) {
      console.error('  asset copy failed:', e && e.message ? e.message : e);
    }
    notify();
  };

  return ts.createWatchProgram(host);
}
