/**
 * F3-style debug overlay plus an in-game command console.
 *
 * Commands are deliberately simple and exist so the game can be exercised
 * quickly during development and benchmarking.
 */

import type { Game } from './game.js';
import { CHUNK_Y } from './world/chunk.js';
import { itemDisplay } from './items/items.js';

const HELP = [
  '/help                 list commands',
  '/time <0..1|day|noon|night|dusk|dawn>',
  '/gamemode <survival|creative>',
  '/give <item> [count]  give an item',
  '/tp <x> <y> <z>       teleport (y optional)',
  '/seed                 print the world seed',
  '/locate <village|dungeon>',
  '/weather <clear|rain|snow>',
  '/summon <mob>         pig cow sheep chicken zombie skeleton spider creeper',
  '/spawn                return to the world spawn',
  '/heal                 restore health and hunger',
  '/rd <4..16>           render distance',
  '/save                 save now',
  '/pos1 /pos2 /fill     mark a box and fill it with the held block',
  '/fly                  toggle creative flight',
  '/noclip               toggle collision-free flying',
  '/killall              remove all mobs',
];

export class DebugConsole {
  private game: Game;
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private bar: HTMLElement;
  private history: string[] = [];
  private historyIndex = -1;
  overlayVisible = false;
  private pos1: [number, number, number] | null = null;
  private pos2: [number, number, number] | null = null;
  private messages: string[] = [];
  private tickTimer = 0;

  constructor(root: HTMLElement, game: Game) {
    this.game = game;
    const wrap = document.createElement('div');
    wrap.id = 'command-bar';
    wrap.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;display:none;padding:6px 8px;background:rgba(0,0,0,0.72);z-index:45;pointer-events:auto;';
    wrap.innerHTML = `<input type="text" id="command-input" autocomplete="off" spellcheck="false"
      style="width:100%;background:transparent;border:none;outline:none;color:#e8e8e8;font:inherit;font-size:14px" />`;
    root.appendChild(wrap);
    this.bar = wrap;
    this.input = wrap.querySelector('#command-input') as HTMLInputElement;

    const overlay = document.createElement('div');
    overlay.id = 'debug';
    overlay.className = 'hidden';
    root.appendChild(overlay);
    this.overlay = overlay;
    // keep the F3 text refreshed even when the game loop is paused
    this.tickTimer = window.setInterval(() => {
      if (this.overlayVisible) this.overlay.textContent = this.text();
    }, 200);

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(this.input.value);
        this.input.value = '';
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.history.length) {
          this.historyIndex = Math.max(0, this.historyIndex < 0 ? this.history.length - 1 : this.historyIndex - 1);
          this.input.value = this.history[this.historyIndex] ?? '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.history.length) {
          this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
          this.input.value = this.history[this.historyIndex] ?? '';
        }
      }
    });
  }

  get isTyping(): boolean {
    return this.bar.style.display !== 'none';
  }

  open(): void {
    this.bar.style.display = 'block';
    this.input.focus();
    document.exitPointerLock?.();
  }

  close(): void {
    this.bar.style.display = 'none';
    this.input.blur();
    if (this.game.running) this.game.requestPointerLock();
  }

  /** Forwarded from the game's keydown while the console is open. */
  handleKey(_e: KeyboardEvent): void {
    /* the input element handles its own keys */
  }

  toggleOverlay(): void {
    this.overlayVisible = !this.overlayVisible;
    this.overlay.classList.toggle('hidden', !this.overlayVisible);
    if (this.overlayVisible) this.overlay.textContent = this.text();
  }

  private notify(msg: string): void {
    this.messages.push(msg);
    if (this.messages.length > 6) this.messages.shift();
    this.game.hud.showToast(msg, 3);
  }

  submit(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    this.history.push(line);
    this.historyIndex = -1;
    const parts = line.replace(/^\//, '').split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const g = this.game;
    const num = (s: string | undefined, dflt: number): number => {
      const v = Number(s);
      return Number.isFinite(v) ? v : dflt;
    };

    switch (cmd) {
      case 'help':
        for (const h of HELP) this.notify(h);
        break;
      case 'time': {
        const a = (parts[1] ?? '').toLowerCase();
        const presets: Record<string, number> = { day: 0.2, noon: 0.25, night: 0.75, dusk: 0.5, dawn: 0.0, sunrise: 0.0, sunset: 0.5 };
        const t = a in presets ? presets[a] : Number(a);
        if (!Number.isFinite(t)) {
          this.notify(`time is ${g.skyTime.toFixed(3)}`);
        } else {
          g.setSkyTime(t);
          this.notify(`time set to ${t}`);
        }
        break;
      }
      case 'gamemode':
      case 'gm': {
        const m = (parts[1] ?? '').toLowerCase();
        if (m === 'creative' || m === 'c' || m === '1') g.debugSetGameMode('creative');
        else if (m === 'survival' || m === 's' || m === '0') g.debugSetGameMode('survival');
        else this.notify('usage: /gamemode <survival|creative>');
        break;
      }
      case 'give': {
        const item = parts[1];
        const count = Math.max(1, Math.min(6400, num(parts[2], 1)));
        if (!item) {
          this.notify('usage: /give <item> [count]');
          break;
        }
        this.notify(g.debugGive(item, count) ? `Gave ${count} ${itemDisplay(item)}` : `Unknown item: ${item}`);
        break;
      }
      case 'tp': {
        const x = num(parts[1], g.player.position.x);
        const z = num(parts[2], g.player.position.z);
        let y = num(parts[3], NaN);
        if (!Number.isFinite(y)) {
          g.debugTeleport(x, CHUNK_Y - 2, z);
          g.debugEnsureChunks(x, z);
          // drop onto the surface
          for (let yy = CHUNK_Y - 2; yy > 0; yy--) {
            if (g.world.isSolidAt(Math.floor(x), yy, Math.floor(z))) {
              y = yy + 1.1;
              break;
            }
          }
          if (!Number.isFinite(y)) y = 70;
        }
        g.debugTeleport(x, y, z);
        this.notify(`Teleported to ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`);
        break;
      }
      case 'seed':
        this.notify(`Seed: ${g.world.seed}`);
        break;
      case 'locate': {
        const kind = (parts[1] ?? 'village').toLowerCase() === 'dungeon' ? 'dungeon' : 'village';
        this.notify(g.debugLocate(kind));
        break;
      }
      case 'weather':
        g.debugSetWeather((parts[1] ?? 'clear').toLowerCase() as 'clear' | 'rain' | 'snow');
        this.notify(`Weather: ${parts[1] ?? 'clear'}`);
        break;
      case 'summon': {
        const type = (parts[1] ?? 'pig').toLowerCase();
        g.debugSpawnMob(type);
        this.notify(`Summoned ${type}`);
        break;
      }
      case 'spawn':
        g.debugTeleport(g.player.spawnPoint.x, g.player.spawnPoint.y, g.player.spawnPoint.z);
        this.notify('Returned to spawn');
        break;
      case 'heal':
        g.player.health = g.player.maxHealth;
        g.player.hunger = 20;
        g.player.air = g.player.maxAir;
        g.player.dead = false;
        this.notify('Healed');
        break;
      case 'rd': {
        const rd = Math.max(4, Math.min(16, Math.round(num(parts[1], g.settings.renderDistance))));
        g.updateSettings({ renderDistance: rd });
        this.notify(`Render distance: ${rd}`);
        break;
      }
      case 'save':
        g.save();
        this.notify('Saved');
        break;
      case 'pos1':
        this.pos1 = [Math.floor(g.player.position.x), Math.floor(g.player.position.y), Math.floor(g.player.position.z)];
        this.notify(`pos1 = ${this.pos1.join(' ')}`);
        break;
      case 'pos2':
        this.pos2 = [Math.floor(g.player.position.x), Math.floor(g.player.position.y), Math.floor(g.player.position.z)];
        this.notify(`pos2 = ${this.pos2.join(' ')}`);
        break;
      case 'fill': {
        const held = g.inventory.held;
        const blockId = held ? g.debugHeldBlockId() : 0;
        if (!this.pos1 || !this.pos2) {
          this.notify('Set /pos1 and /pos2 first');
          break;
        }
        if (!blockId) {
          this.notify('Hold a block to fill with');
          break;
        }
        const [x0, y0, z0] = this.pos1;
        const [x1, y1, z1] = this.pos2;
        let count = 0;
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
              if (g.world.setBlock(x, y, z, blockId, true)) count++;
            }
          }
        }
        g.chunkManager.markAllDirty();
        this.notify(`Filled ${count} blocks`);
        break;
      }
      case 'fly':
        g.player.flying = !g.player.flying;
        this.notify(`Flying: ${g.player.flying}`);
        break;
      case 'noclip':
        g.player.gameMode = g.player.gameMode === 'creative' ? 'survival' : 'creative';
        g.player.flying = true;
        this.notify(`Game mode: ${g.player.gameMode}`);
        break;
      case 'killall':
        for (const e of g.mobs.entities.slice()) g.mobs.remove(e);
        this.notify('Removed all entities');
        break;
      default:
        this.notify(`Unknown command: ${cmd} (try /help)`);
        break;
    }
  }

  /** Live text for the F3 overlay. */
  text(): string {
    const g = this.game;
    const st = g.chunkManager.stats;
    const lines = g.debugInfo();
    const rd = g.renderer3d.renderDiagnostics;
    const fs = g.renderer3d.frameStats;
    lines.push(
      `FPS ${g.renderer3d.stats.fps.toFixed(0)}  world draws ${g.renderer3d.worldDrawCalls}  tris ${(g.renderer3d.worldTriangles / 1000).toFixed(1)}k`,
    );
    lines.push(
      `Frame ${fs.frameMs.toFixed(1)}ms (peak ${fs.frameMsMax.toFixed(1)})  JS ${fs.jsMs.toFixed(1)}ms (peak ${fs.jsMsMax.toFixed(1)})  ${fs.cpuShare > 0.7 ? 'CPU-BOUND' : fs.cpuShare < 0.35 ? 'GPU-BOUND' : 'mixed'} ${(fs.cpuShare * 100).toFixed(0)}%`,
    );
    lines.push(`Render ${rd.selfTest}  ${rd.note}`);
    lines.push(
      `Terrain ${['custom shader', 'plain textured', 'flat colour'][g.renderer3d.terrainTier] ?? 'custom shader'}`,
    );
    lines.push(
      `Chunks ${st.loaded} loaded / ${st.meshed} meshed / ${st.pending} pending  faces ${(st.faces / 1000).toFixed(1)}k`,
    );
    lines.push(`Gen ${st.genMs.toFixed(1)}ms  Mesh ${st.meshMs.toFixed(1)}ms  RD ${g.settings.renderDistance}`);
    lines.push(`Entities ${g.mobs.entities.length}  Drops ${g.drops.count}  Particles ${g.particleSystem.activeCount}`);
    for (const line of g.cameraTrace.summary().split('\n')) lines.push(line);
    lines.push(g.renderer3d.sky.cloudDebug());
    lines.push(`Mode ${g.player.gameMode}  ${g.player.flying ? 'flying' : g.player.onGround ? 'ground' : 'air'}  ${g.player.inWater ? 'water' : ''}`);
    for (const m of this.messages.slice(-4)) lines.push(`> ${m}`);
    return lines.join('\n');
  }
}
