/**
 * CubeWorld entry point.
 *
 * Boots the canvas + UI shell and hands control to the Game.
 */

import { Game } from './game.js';

function boot(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app container missing from index.html');

  app.innerHTML = `
    <canvas id="game"></canvas>
    <div id="ui">
      <div id="hud-root"></div>
      <div id="container-root"></div>
      <div id="screen-root"></div>
      <div id="debug-root"></div>
    </div>
  `;

  const canvas = app.querySelector('#game') as HTMLCanvasElement;
  const ui = app.querySelector('#ui') as HTMLElement;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Each UI layer owns its own container: building one must never wipe another.
  const layers = {
    hud: app.querySelector('#hud-root') as HTMLElement,
    containers: app.querySelector('#container-root') as HTMLElement,
    screens: app.querySelector('#screen-root') as HTMLElement,
    debug: app.querySelector('#debug-root') as HTMLElement,
  };

  let game: Game;
  try {
    game = new Game(canvas, layers);
    const params = new URLSearchParams(location.search);
    // ?tier=0|1|2 forces a terrain material directly: 0 = the full custom
    // shader, 1 = the plain textured material, 2 = flat colours.
    const forced = params.get('tier');
    if (forced !== null) {
      game.renderer3d.setForcedTier(Number(forced) || 0);
    }
    // ?safe=1 is shorthand for ?tier=1
    if (params.get('safe') === '1') {
      game.renderer3d.setForcedTier(1);
    }
    // ?probe=1 draws a row of material/texture swatches over the frame so a
    // single screenshot shows which combination the GPU refuses to render.
    if (params.get('probe') === '1') {
      game.renderer3d.enableProbe(game.renderer3d.sky.cloudTexture);
      const names = [
        '1 solid',
        '2 basic+blocks',
        '3 basic+checker',
        '4 shader+blocks',
        '5 shader+checker',
        '6 shader+clouds',
        '7 basic+items',
      ];
      const strip = document.createElement('div');
      strip.style.cssText = 'position:fixed;left:0;right:0;top:14%;height:16px;z-index:90;pointer-events:none';
      names.forEach((n, i) => {
        const el = document.createElement('span');
        el.textContent = n;
        // matches the probe's NDC x positions: -0.72 + i * 0.24, width 0.16
        el.style.cssText =
          `position:absolute;left:${(( -0.72 + i * 0.24 + 0.08 + 1) / 2 * 100).toFixed(2)}%;transform:translateX(-50%);` +
          'font:11px/1.3 monospace;color:#fff;text-shadow:1px 1px 0 #000,0 0 4px #000;white-space:nowrap';
        strip.appendChild(el);
      });
      app.appendChild(strip);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    layers.screens.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:#12141c;color:#e8b0b0;font:14px monospace;padding:40px;text-align:center;pointer-events:auto">
      <div><b>CubeWorld failed to start</b><br><br>${msg.replace(/</g, '&lt;')}<br><br>
      <span style="color:#9aa4b4">Your browser needs WebGL 2 support.</span></div></div>`;
    console.error(e);
    return;
  }

  // handy for debugging from the browser console
  (window as unknown as Record<string, unknown>).cubeworld = game;

  // Surface anything that escapes the frame loop so a failure is never silent.
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:99;display:none;padding:8px 12px;background:rgba(120,10,10,0.94);' +
    'color:#ffe0e0;font:12px/1.5 monospace;white-space:pre-wrap;max-height:30vh;overflow:auto;pointer-events:auto';
  app.appendChild(banner);
  const showBanner = (label: string, detail: string): void => {
    if (banner.style.display === 'block') return;
    banner.textContent = `${label}\n${detail}\n\n(press F5 to reload; the browser console has the full trace)`;
    banner.style.display = 'block';
  };
  window.addEventListener('error', (e) => {
    showBanner('Uncaught error', `${e.message}\n${e.filename ?? ''}:${e.lineno ?? 0}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    showBanner('Unhandled promise rejection', r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
