/**
 * Browser diagnostic harness.
 *
 * The sandbox this project is developed in cannot launch a browser (Chromium's
 * mojo named pipes are blocked), so the only way to see what the real WebGL
 * pipeline does is to have a browser report on itself. This module boots the
 * real Game - the exact same construction path as src/main.ts - starts a world
 * programmatically, lets the real requestAnimationFrame loop run for a few
 * seconds, then prints everything we wish we could see in a debugger: shader
 * compile failures, renderer statistics, scene contents and - most importantly
 * - the actual RGBA values read back out of the drawing buffer.
 *
 * Load it through diagnostic.html. It never requires pointer lock or any user
 * interaction.
 */

import * as THREE from 'three';
import { Game } from './game.js';
import { SaveSystem, WorldMeta } from './save/save.js';
import { getBlock } from './world/blocks.js';

/* ------------------------------------------------------------------ */
/* Error + console capture                                             */
/* ------------------------------------------------------------------ */

interface ExceptionRecord {
  label: string;
  message: string;
  stack: string;
}

const exceptions: ExceptionRecord[] = [];
const consoleLog: string[] = [];
/** Failures from startWorld / world creation, kept separate from console noise. */
const startErrors: string[] = [];

/**
 * Format console arguments for the report. Errors keep their stack; objects are
 * serialised defensively because three.js objects can be cyclic.
 */
function formatArg(a: unknown): string {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return String(a);
  if (typeof a === 'function') return `[function ${a.name || 'anonymous'}]`;
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(a, (_k, v: unknown) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }) ?? String(a)
    );
  } catch {
    return Object.prototype.toString.call(a);
  }
}

function pushConsole(kind: 'error' | 'warn', args: unknown[]): void {
  const text = args.map(formatArg).join(' ');
  // Shader compile errors arrive through console.error with the full shader
  // source in a follow-up argument, so keep a generous slice.
  consoleLog.push(`[${kind}] ${text.length > 4000 ? `${text.slice(0, 4000)}\n...<truncated>` : text}`);
  // The call site tells us *where* in the pipeline the message came from
  // (three.js internals, our mesher, the HUD...).
  const stack = new Error(`console.${kind} call site`).stack;
  if (stack) consoleLog.push(indent(`  call site:\n${stack.split('\n').slice(2, 6).join('\n')}`, '    '));
}

/** Install the interceptors. Must run before anything constructs a Game. */
function installCapture(): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    pushConsole('error', args);
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    pushConsole('warn', args);
    originalWarn(...args);
  };
  window.addEventListener('error', (e: ErrorEvent) => {
    exceptions.push({
      label: 'window.onerror',
      message: `${e.message} (${e.filename || '?'}:${e.lineno ?? '?'}:${e.colno ?? '?'})`,
      stack: e.error instanceof Error ? e.error.stack ?? '(no stack)' : '(no Error object)',
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason;
    exceptions.push({
      label: 'unhandledrejection',
      message: r instanceof Error ? r.message : formatArg(r),
      stack: r instanceof Error ? r.stack ?? '(no stack)' : '(not an Error)',
    });
  });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const f = (n: number, digits = 3): string => (Number.isFinite(n) ? n.toFixed(digits) : String(n));
const indent = (s: string, pad: string): string => s.split('\n').join(`\n${pad}`);
const rgba = (p: number[]): string => `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`;
/** A pixel counts as "dark" when all three colour channels are very low. */
const isDark = (p: number[] | undefined): boolean => !!p && p[0] < 60 && p[1] < 60 && p[2] < 60;

/** Wait for `count` real animation frames (or until the ms cap is reached). */
function countFrames(count: number, msCap: number): Promise<{ frames: number; elapsed: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let frames = 0;
    const tick = (): void => {
      frames++;
      const elapsed = performance.now() - t0;
      if (frames >= count || elapsed >= msCap) {
        resolve({ frames, elapsed });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* ------------------------------------------------------------------ */
/* Page shell                                                          */
/* ------------------------------------------------------------------ */

/** Build the same DOM structure src/main.ts builds, plus our report panel. */
function buildShell(): { canvas: HTMLCanvasElement; layers: { hud: HTMLElement; containers: HTMLElement; screens: HTMLElement; debug: HTMLElement } } {
  // diagnostic.html provides #app; be forgiving if this module is instead
  // loaded into a bare page, rather than throwing before we can report.
  let app = document.getElementById('app');
  if (!app) {
    app = document.createElement('div');
    app.id = 'app';
    document.body.appendChild(app);
  }
  app.innerHTML = `
    <canvas id="game"></canvas>
    <div id="ui">
      <div id="hud-root"></div>
      <div id="container-root"></div>
      <div id="screen-root"></div>
      <div id="debug-root"></div>
    </div>
    <div id="diag-panel">
      <div id="diag-status">CubeWorld diagnostics: starting...</div>
      <pre id="diag-report"></pre>
      <div id="diag-buttons"><button id="diag-copy" type="button">Copy report</button></div>
    </div>`;
  const canvas = app.querySelector('#game') as HTMLCanvasElement;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // Each UI layer owns its own container; building one must never wipe another.
  const layers = {
    hud: app.querySelector('#hud-root') as HTMLElement,
    containers: app.querySelector('#container-root') as HTMLElement,
    screens: app.querySelector('#screen-root') as HTMLElement,
    debug: app.querySelector('#debug-root') as HTMLElement,
  };
  return { canvas, layers };
}

function setStatus(text: string): void {
  const el = document.getElementById('diag-status');
  if (el) el.textContent = text;
}

/** Publish the report and wire up the copy button. */
function showReport(text: string): void {
  const pre = document.getElementById('diag-report');
  if (pre) pre.textContent = text;
  setStatus('CubeWorld diagnostics complete - use "Copy report" and paste the text back.');
  const btn = document.getElementById('diag-copy') as HTMLButtonElement | null;
  if (btn) btn.addEventListener('click', () => void copyText(text, btn));
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    return;
  } catch {
    /* clipboard API unavailable (insecure context / denied) - use the fallback */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-10000px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    btn.textContent = 'Copied!';
  } catch {
    btn.textContent = 'Copy failed - select the text manually';
  }
  ta.remove();
}

/* ------------------------------------------------------------------ */
/* Pixel probe                                                         */
/* ------------------------------------------------------------------ */

interface PixelSample {
  label: string;
  x: number;
  y: number;
  rgba: number[];
}

interface Probe {
  label: string;
  samples: PixelSample[];
  error: string | null;
}

/** Read a few pixels back out of the drawing buffer. */
function readPixels(canvas: HTMLCanvasElement, label: string): Probe {
  // canvas.getContext returns the very same context three.js created.
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return { label, samples: [], error: 'no WebGL2 context' };
  const w = canvas.width;
  const h = canvas.height;
  const px = new Uint8Array(4);
  // NOTE: readPixels coordinates are framebuffer pixels with the origin at the
  // BOTTOM-left, so y=0 is the bottom of the image, not the top.
  const points = [
    { label: 'centre', x: w >> 1, y: h >> 1 },
    { label: '1/4 up from centre', x: w >> 1, y: Math.floor(h * 0.75) },
    { label: '3/4 up from centre', x: w >> 1, y: Math.floor(h * 0.25) },
    { label: 'bottom-left corner', x: 1, y: 1 },
  ];
  const samples: PixelSample[] = [];
  try {
    for (const p of points) {
      px.fill(0);
      gl.readPixels(p.x, p.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      samples.push({ label: p.label, x: p.x, y: p.y, rgba: [px[0], px[1], px[2], px[3]] });
      const err = gl.getError();
      if (err !== 0) return { label, samples, error: `gl.getError()=${err} after readPixels at ${p.label}` };
    }
  } catch (e) {
    return { label, samples, error: e instanceof Error ? e.message : String(e) };
  }
  return { label, samples, error: null };
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

interface ReportInput {
  game: Game | null;
  bootError: Error | null;
  probes: Probe[];
  endProbe: Probe | null;
  frames: number;
  elapsedMs: number;
  avgFrameMs: number;
  startedWorld: boolean;
}

function buildReport(c: ReportInput): string {
  const { game, bootError, probes, endProbe, frames, elapsedMs, avgFrameMs, startedWorld } = c;
  const out: string[] = [];
  const section = (title: string): void => {
    out.push('', `--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
  };

  section('ERRORS');
  out.push(`Game construction error : ${bootError ? `${bootError.name}: ${bootError.message}` : 'none'}`);
  if (bootError?.stack) out.push(indent(bootError.stack, '  '));
  out.push(`World start errors      : ${startErrors.length}`);
  for (const e of startErrors) out.push(indent(e, '  '));
  out.push(`Uncaught errors / unhandled rejections: ${exceptions.length}`);
  for (const e of exceptions) {
    out.push(`  [${e.label}] ${e.message}`);
    out.push(indent(e.stack, '    '));
  }
  out.push(`console.error / console.warn messages: ${consoleLog.length}`);
  for (const line of consoleLog) out.push(indent(line, '  '));

  section('PIXEL PROBE (drawing buffer readback)');
  if (!probes.length) out.push('  not collected (no renderer)');
  for (const probe of probes) {
    out.push(`  [${probe.label}]`);
    if (probe.error) out.push(`    readPixels failed: ${probe.error}`);
    else {
      for (const s of probe.samples) {
        out.push(
          `    ${s.label.padEnd(21)} fb(${String(s.x).padStart(4)}, ${String(s.y).padStart(4)}) = ${rgba(s.rgba)}${isDark(s.rgba) ? '   <- dark' : ''}`,
        );
      }
    }
  }
  // Informational only: three.js renders with preserveDrawingBuffer:false, so the
  // buffer is formally undefined once the frame has been composited. The probes
  // taken inside frames above are the authoritative ones.
  if (endProbe && !endProbe.error && endProbe.samples.length) {
    out.push(`  (informational) post-loop centre = ${rgba(endProbe.samples[0].rgba)} - undefined with preserveDrawingBuffer:false`);
  }

  section('WEBGL CONTEXT');
  if (game) {
    try {
      const gl = game.renderer3d.renderer.domElement.getContext('webgl2') as WebGL2RenderingContext | null;
      if (!gl) out.push('  no WebGL2 context on the canvas!');
      else {
        out.push(`  VERSION                  : ${String(gl.getParameter(gl.VERSION))}`);
        out.push(`  SHADING_LANGUAGE_VERSION : ${String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))}`);
        out.push(`  VENDOR / RENDERER        : ${String(gl.getParameter(gl.VENDOR))} / ${String(gl.getParameter(gl.RENDERER))}`);
        out.push(`  gl.getError()            : ${gl.getError()} (0 = NO_ERROR)`);
        out.push(`  drawingBufferSize        : ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`);
        out.push(`  context lost             : ${gl.isContextLost()}`);
      }
    } catch (e) {
      out.push(`  context query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else out.push('  no renderer (Game construction failed)');

  section('RENDERER INFO');
  if (game) {
    const rd = game.renderer3d.renderDiagnostics;
    out.push(`  frame sample            : ${rd.selfTest}`);
    out.push(`  frame sample detail     : ${rd.note}`);
    out.push(`  distinct colours seen   : ${rd.distinctColours} over ${rd.sampledPixels} sampled pixels`);
    out.push(`  terrain material tier   : ${game.renderer3d.terrainTier}  (0 = custom shader, 1 = plain textured, 2 = flat colour)`);
    const r = game.renderer3d.renderer;
    const info = r.info;
    out.push(`  info.render   : calls=${info.render.calls} triangles=${info.render.triangles} points=${info.render.points} lines=${info.render.lines} frame=${info.render.frame}`);
    out.push(`  info.memory   : geometries=${info.memory.geometries} textures=${info.memory.textures}`);
    const programs = info.programs ?? [];
    out.push(`  info.programs : ${programs.length}`);
    for (const p of programs) {
      // three.js attaches `diagnostics` to the internal program object at
      // runtime but @types/three does not declare it, hence the cast.
      const d = (p as unknown as { diagnostics?: { runnable?: boolean; programLog?: string; vertexShader?: { log?: string }; fragmentShader?: { log?: string } } }).diagnostics;
      const bad =
        d && d.runnable === false
          ? ` >>> NOT RUNNABLE: ${String(d.programLog ?? '')}${d.vertexShader?.log ? ` | vs: ${d.vertexShader.log}` : ''}${d.fragmentShader?.log ? ` | fs: ${d.fragmentShader.log}` : ''}`
          : '';
      out.push(`    #${p.id} name="${p.name}" usedTimes=${p.usedTimes}${bad}`);
    }
    out.push(`  stats.fps=${f(game.renderer3d.stats.fps, 1)} drawCalls=${game.renderer3d.stats.drawCalls} triangles=${game.renderer3d.stats.triangles}`);
  } else out.push('  no renderer (Game construction failed)');

  section('SCENE');
  if (game) {
    const scene = game.renderer3d.scene;
    let meshes = 0;
    let points = 0;
    let groups = 0;
    for (const child of scene.children) {
      if (child instanceof THREE.Mesh) meshes++;
      else if (child instanceof THREE.Points) points++;
      else if (child instanceof THREE.Group) groups++;
    }
    out.push(`  scene.children : ${scene.children.length} (Mesh=${meshes} Points=${points} Group=${groups})`);
    out.push(`  children       : ${scene.children.map((x) => x.name || x.type).join(', ')}`);
    const chunkGroup = game.chunkManager.group;
    let withGeometry = 0;
    let indices = 0;
    for (const child of chunkGroup.children) {
      const geo = (child as THREE.Mesh).geometry as THREE.BufferGeometry | null | undefined;
      if (!geo) continue;
      withGeometry++;
      indices += geo.getIndex()?.count ?? 0;
    }
    out.push(`  chunk group children            : ${chunkGroup.children.length}`);
    out.push(`  ...with non-null geometry       : ${withGeometry}`);
    out.push(`  ...total index count            : ${indices} (${(indices / 3).toFixed(0)} triangles)`);
    out.push(`  chunkManager.stats: ${JSON.stringify(game.chunkManager.stats)}`);
  } else out.push('  no scene (Game construction failed)');

  section('PLAYER');
  if (game) {
    const p = game.player;
    out.push(`  position : ${f(p.position.x)} ${f(p.position.y)} ${f(p.position.z)}   eyeY: ${f(p.eyeY)}`);
    out.push(`  yaw/pitch: ${f(p.yaw, 4)} / ${f(p.pitch, 4)}`);
    out.push(`  gameMode : ${String(p.gameMode)} (player) / ${String(game.gameMode)} (game)`);
    out.push(`  onGround : ${p.onGround}   inWater: ${p.inWater}   headInWater: ${p.headInWater}   flying: ${p.flying}`);
    out.push(`  health/hunger/air: ${p.health} / ${p.hunger} / ${p.air}   running: ${game.running}`);
    out.push(`  velocity : ${f(p.velocity.x, 2)} ${f(p.velocity.y, 2)} ${f(p.velocity.z, 2)}`);
  } else out.push('  no player (Game construction failed)');

  section('WORLD');
  if (game) {
    const world = game.world;
    const p = game.player.position;
    const px = Math.floor(p.x);
    const pz = Math.floor(p.z);
    const groundY = Math.floor(p.y);
    const eyeY = Math.floor(game.player.eyeY);
    const idAt = (y: number): string => {
      const id = world.getBlockAt(px, y, pz);
      return `${id} (${getBlock(id).name})`;
    };
    out.push(`  world.seed        : ${world.seed}   dimension: ${world.dimension}`);
    out.push(`  world.loadedCount : ${world.loadedCount}`);
    out.push(`  heightAt(${px}, ${pz}): ${world.heightAt(px, pz)}`);
    out.push(`  block at feet     : y=${groundY} -> ${idAt(groundY)}`);
    out.push(`  block at eye      : y=${eyeY} -> ${idAt(eyeY)}`);
    out.push(`  block above eye   : y=${eyeY + 1} -> ${idAt(eyeY + 1)}`);
    out.push(`  light at eye      : sky=${world.getSkyLightAt(px, eyeY, pz)} block=${world.getBlockLightAt(px, eyeY, pz)}`);
    out.push(`  chunk at player   : ${world.getChunkAt(px, pz) ? 'loaded' : 'MISSING'} (${px >> 4}, ${pz >> 4})   centre: ${game.chunkManager.centre.join(', ')}   renderDistance: ${game.chunkManager.renderDistance}`);
  } else out.push('  no world (Game construction failed)');

  section('CAMERA');
  if (game) {
    const cam = game.renderer3d.camera;
    out.push(`  position : ${f(cam.position.x)} ${f(cam.position.y)} ${f(cam.position.z)}`);
    out.push(`  rotation : ${f(cam.rotation.x, 4)} ${f(cam.rotation.y, 4)} ${f(cam.rotation.z, 4)} (order ${cam.rotation.order})`);
    out.push(`  fov/near/far/aspect: ${f(cam.fov, 2)} / ${f(cam.near, 3)} / ${f(cam.far, 1)} / ${f(cam.aspect, 4)}`);
  } else out.push('  no camera (Game construction failed)');

  section('ENVIRONMENT');
  out.push(`  document.pointerLockElement : ${document.pointerLockElement ? 'SET' : 'null (expected - no user gesture)'}`);
  out.push(`  userAgent                   : ${navigator.userAgent}`);
  out.push(`  devicePixelRatio            : ${window.devicePixelRatio}   innerSize: ${window.innerWidth}x${window.innerHeight}`);
  out.push(`  frames in ${f(elapsedMs / 1000, 2)}s : ${frames} (avg ${f(avgFrameMs, 1)} ms/frame, ~${f(frames / Math.max(0.001, elapsedMs / 1000), 1)} fps)`);
  out.push(`  startedWorld successfully   : ${startedWorld}`);
  return out.join('\n');
}

/** One short human-readable conclusion drawn from the report's raw numbers. */
function buildVerdict(probes: Probe[], game: Game | null): string {
  const shaderNoise = consoleLog.filter((l) => /shader|program|compile|link/i.test(l)).length;
  // The last probe is the settled-world one; fall back to whatever we have.
  const probe = probes[probes.length - 1];
  const samples = probe?.samples ?? [];
  const centre = samples.find((s) => s.label.startsWith('centre'))?.rgba;
  const allDark = samples.length > 0 && samples.every((s) => isDark(s.rgba));
  const meshed = game ? game.chunkManager.stats.meshed : -1;

  if (exceptions.length > 0) return `VERDICT: ${exceptions.length} uncaught error(s) - the game loop threw; see ERRORS above.`;
  if (shaderNoise > 0) return 'VERDICT: shader compile/link failure suspected - console.error captured shader-related messages (see ERRORS).';
  if (!probe || probe.error) return `VERDICT: could not read the drawing buffer (${probe?.error ?? 'no renderer'}) - cannot tell whether the canvas is drawn.`;
  if (!centre) return 'VERDICT: no pixel samples collected.';
  if (allDark) return 'VERDICT: canvas is uniform dark - chunk meshes are probably not rendering (check chunkManager.stats and the chunk index count above).';
  if (isDark(centre) && meshed === 0) return 'VERDICT: centre pixel is dark and no chunk is meshed - chunk streaming/meshing is not producing geometry.';
  if (!isDark(centre) && meshed === 0) return 'VERDICT: the centre pixel is coloured but nothing is meshed - we are seeing the sky/clear colour only.';
  return 'VERDICT: canvas contains more than one colour - the 3D pipeline is drawing something (compare with the failing run).';
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let game: Game | null = null;
let framesSeen = 0;
let elapsedMs = 0;

async function boot(): Promise<void> {
  installCapture();
  setStatus('CubeWorld diagnostics: building the game...');

  // Everything after this point must end up in the report even if it throws, so
  // the whole boot is one try/catch and the report is built in the tail.
  let bootError: Error | null = null;
  let startedWorld = false;
  const probes: Probe[] = [];
  let endProbe: Probe | null = null;
  const t0 = performance.now();

  try {
    const shell = buildShell();
    const canvas = shell.canvas;

    setStatus('CubeWorld diagnostics: constructing the Game...');
    try {
      game = new Game(canvas, shell.layers);
    } catch (e) {
      bootError = e instanceof Error ? e : new Error(String(e));
    }
    // Expose it for manual poking, exactly like main.ts does.
    (window as unknown as Record<string, unknown>).cubeworld = game;

    if (game) {
      // Probe the drawing buffer from inside render(): three.js draws with
      // preserveDrawingBuffer:false, so the buffer is undefined between frames
      // and reading it from a timer would report nothing useful.
      interface DiagRenderer {
        render(): void;
      }
      const renderer = game.renderer3d.renderer as unknown as DiagRenderer;
      const originalRender = renderer.render.bind(renderer);
      let probesTaken = 0;
      let armedAfterStart = false;
      // Probe once on the very first drawn frame (the menu/loading frame), then
      // again exactly once after the world has had a second to settle.
      //
      // CRITICAL: the wrapper must forward (scene, camera) verbatim. Calling
      // originalRender() with no arguments passes `undefined` as the scene, and
      // three.js dereferences `scene.matrixWorldAutoUpdate` immediately, which
      // aborts every frame before a single draw call - the instrumentation would
      // be reporting on a renderer it had itself broken.
      renderer.render = (scene?: unknown, camera?: unknown): void => {
        (originalRender as unknown as (s?: unknown, c?: unknown) => void)(scene, camera);
        if (probesTaken === 0) {
          probesTaken = 1;
          probes.push(readPixels(canvas, 'first rendered frame (before the world started)'));
        } else if (armedAfterStart && probesTaken === 1) {
          probesTaken = 2;
          probes.push(readPixels(canvas, 'settled world, ~1 s after startWorld resolved'));
        }
      };

      setStatus('CubeWorld diagnostics: starting a creative world...');
      try {
        const meta: WorldMeta = {
          id: 'diag-world',
          name: 'Diagnostic World',
          seed: 1337,
          gameMode: 'creative',
          createdAt: Date.now(),
          lastPlayed: Date.now(),
          playTime: 0,
        };
        // The same path the "Create world" screen uses, minus the UI.
        SaveSystem.upsertMeta(meta);
        await game.startWorld(meta, 'creative');
        startedWorld = true;
      } catch (e) {
        startErrors.push(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e));
      }

      // Let the world run for ~1 s, then arm the second probe.
      await countFrames(60, 1500);
      armedAfterStart = true;

      // Let the real rAF loop run some more: this covers several
      // streaming/meshing passes so chunkManager.stats is meaningful.
      setStatus('CubeWorld diagnostics: letting the real frame loop run for ~6 s...');
      const run = await countFrames(300, 5000);
      framesSeen = run.frames;
      elapsedMs = run.elapsed;

      // Informational only - see the note in the report.
      try {
        const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
        if (gl) {
          const px = new Uint8Array(4);
          gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          endProbe = { label: 'post-loop centre', samples: [{ label: 'post-loop centre', x: canvas.width >> 1, y: canvas.height >> 1, rgba: [px[0], px[1], px[2], px[3]] }], error: null };
        }
      } catch {
        /* informational probe - failures are not interesting */
      }
    } else {
      setStatus('CubeWorld diagnostics: Game construction failed, reporting what we can...');
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (e) {
    // Last-resort catch: something outside the Game (DOM, import, ...) failed.
    if (!bootError) bootError = e instanceof Error ? e : new Error(String(e));
  }
  if (elapsedMs === 0) elapsedMs = performance.now() - t0;
  const avgFrameMs = framesSeen > 0 ? elapsedMs / framesSeen : 0;

  const report = [
    buildVerdict(probes, game),
    '',
    `CubeWorld browser diagnostic - ${new Date().toISOString()}`,
    `URL: ${location.href}`,
    buildReport({ game, bootError, probes, endProbe, frames: framesSeen, elapsedMs, avgFrameMs, startedWorld }),
  ].join('\n');

  try {
    showReport(report);
  } catch (e) {
    // Never leave the page blank - even a broken report beats no report.
    showReport(`VERDICT: the diagnostic itself failed: ${e instanceof Error ? e.stack : String(e)}`);
  }
  // Also mirror it to the console, so it can be copied from devtools if the page
  // text is awkward to select.
  console.log(report);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
