// Headless first-person renderer.
//
// Browsers cannot launch in this environment, so this module rasterises the
// exact geometry the game's VoxelMesher produces, with the same lighting,
// texture atlas and fog maths as the WebGL shaders, and writes PNGs. It is the
// project's visual regression harness: UVs, winding, AO, chunk seams, water and
// sky can all be inspected without a GPU.

import path from 'node:path';
import { writePng } from './png.mjs';

const TAU = Math.PI * 2;

export async function run(OUT, load, args) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { biomeById } = await load('worldgen/biomes.js');

  const seed = Number(process.env.SEED || 20240910);
  const W = Number(process.env.QW || 900);
  const H = Number(process.env.QH || 520);
  const RD = Number(process.env.RD || 6);

  const atlas = buildBlockAtlas();
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);
  const mesher = new VoxelMesher(atlas);

  const shots = (args.length ? args : ['day', 'wide', 'night', 'cave']).filter((a) => !a.startsWith('--'));

  // Choose viewpoints from worldgen first so we know which chunks to build.
  const sites = pickSites(gen, shots, seed, biomeById);

  // Try to find a village so structures can be reviewed too.
  let village = null;
  for (let r = 1; r <= 40 && !village; r++) {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      const x = Math.round(Math.cos(a) * r * 100);
      const z = Math.round(Math.sin(a) * r * 100);
      gen.structures.stampsForChunk(x >> 4, z >> 4);
    }
    village = gen.structures.discovered.find((s) => s.kind === 'village') ?? null;
  }
  if (village) {
    sites.villageCentre = [village.x, village.z];
    const gy = gen.heightAt(village.x, village.z);
    // stand off the +X/+Z corner and look back at the well at the centre
    const vYaw = Math.PI / 4;
    sites.shots.village = {
      x: village.x + 20.5, y: gy + 7.5, z: village.z + 20.5,
      yaw: vYaw, pitch: -0.24, time: 0.22, fog: [80, 190], underwater: false,
    };
    sites.shots.villageclose = {
      x: village.x + 9.5, y: village.y + 1.7, z: village.z + 9.5,
      yaw: vYaw, pitch: -0.04, time: 0.22, fog: [70, 160], underwater: false,
    };
    console.log(`render: village at ${village.x} ${village.y} ${village.z}`);
  }

  // Generate around every distinct viewpoint region (the main site and the
  // village, when one was found) so all shots have geometry.
  const R = RD + 2;
  const centres = [sites.centre];
  if (sites.villageCentre) centres.push(sites.villageCentre);
  const chunkSet = new Set();
  const chunkList = [];
  for (const [cx0, cz0] of centres) {
    const ccx = Math.floor(cx0 / 16);
    const ccz = Math.floor(cz0 / 16);
    for (let cz = ccz - R; cz <= ccz + R; cz++) {
      for (let cx = ccx - R; cx <= ccx + R; cx++) {
        const k = cx * 100000 + cz;
        if (chunkSet.has(k)) continue;
        chunkSet.add(k);
        chunkList.push([cx, cz]);
      }
    }
  }

  const t0 = Date.now();
  for (const [cx, cz] of chunkList) {
    const c = world.createChunk(cx, cz);
    gen.generateChunk(c);
  }
  for (const [cx, cz] of chunkList) {
    const c = world.getChunk(cx, cz);
    if (c) world.light.initialLight(c);
  }
  const genMs = Date.now() - t0;

  // Place torches for the shots that ask for them, then re-run lighting so the
  // block-light channel is genuinely exercised (torches must visibly illuminate).
  const { B, blockByName } = await load('world/blocks.js');
  let torches = 0;
  for (const shot of shots) {
    const site = sites.shots[shot];
    if (!site || !site.torch) continue;
    const cp = Math.cos(site.pitch ?? 0);
    const lx = -Math.sin(site.yaw) * cp;
    const ly = Math.sin(site.pitch ?? 0);
    const lz = -Math.cos(site.yaw) * cp;
    // walk forward along the view direction and drop a torch every couple of
    // blocks, so lit ground and the flame itself are both in frame
    for (const d of [2, 3.5, 5, 7, 9]) {
      for (const side of [0, -1.6, 1.6]) {
        const tx = Math.floor(site.x + lx * d - lz * side);
        const tz = Math.floor(site.z + lz * d + lx * side);
        const ground = world.findSurfaceY(tx, tz, Math.max(1, Math.floor(site.y) - 4));
        if (ground < 0 || Math.abs(ground - site.y) > 5) continue;
        if (world.setBlock(tx, ground + 1, tz, B.torch, true)) torches++;
      }
    }
  }
  if (torches) {
    for (const [cx, cz] of chunkList) {
      const c = world.getChunk(cx, cz);
      if (c) c.dirty = true;
    }
  }

  /*
   * A "blocks" shot: a flat platform in the air with one of every block that has
   * ever rendered wrong, laid out in labelled rows. This is the closest thing to
   * standing in the world and looking, and it is how a block that samples the
   * wrong texel gets spotted instead of inferred.
   */
  if (shots.includes('blocks') || shots.includes('torchclose')) {
    const bx = sites.centre[0] + 6;
    const bz = sites.centre[1] + 6;
    const by = 100;
    const ground = gen.heightAt(bx, bz);
    const py = Math.max(by, ground + 24);
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        world.setBlock(bx + x, py - 1, bz + z, B.stone, true);
        for (let y = 0; y < 5; y++) world.setBlock(bx + x, py + y, bz + z, 0, true);
      }
    }
    const row = [
      ['stone', 'sand', 'glass', 'ice', 'water'],
      ['cactus', 'tall_grass', 'red_flower', 'yellow_flower', 'dead_bush'],
      ['oak_log', 'oak_leaves', 'oak_sapling', 'reeds', 'snow'],
      ['coal_ore', 'iron_ore', 'gravel', 'clay', 'bricks'],
      // everything still on the inset-box path, so a fault there is visible
      ['torch', 'oak_door', 'oak_fence', 'portal', 'pumpkin'],
    ];
    row.forEach((names, r) => {
      names.forEach((n, i) => {
        const def = world.getBlock ? null : null;
        const idOf = (nm) => blockByName(nm)?.id ?? 0;
        void def;
        world.setBlock(bx - 4 + i * 2, py, bz - 4 + r * 3, idOf(n), true);
        if (n === 'cactus' || n === 'reeds') {
          world.setBlock(bx - 4 + i * 2, py + 1, bz - 4 + r * 3, idOf(n), true);
          world.setBlock(bx - 4 + i * 2, py + 2, bz - 4 + r * 3, idOf(n), true);
        }
        if (n === 'water') {
          world.setBlock(bx - 4 + i * 2, py + 1, bz - 4 + r * 3, idOf(n), true);
        }
      });
    });
    sites.shots.blocks = {
      x: bx + 7.5, y: py + 3.2, z: bz + 7.5,
      yaw: Math.PI / 4, pitch: -0.42, time: 0.24, fog: [60, 220], underwater: false,
    };
    // The torch sits in the last row, right beside the wide shot's camera, so it
    // needs its own close-up to be judged at all.
    sites.shots.torchclose = {
      x: bx - 1.0, y: py + 1.7, z: bz + 10.6,
      yaw: Math.PI / 4, pitch: -0.2, time: 0.24, fog: [40, 160], underwater: false,
    };

    // Report the mean colour each placed block actually samples, so a block that
    // renders black is named rather than hunted for in the image. Alpha test
    // mirrors the shader: 0.5 for the opaque layer, 0.02 for the transparent one.
    const transparentLayer = new Set(['water', 'glass', 'ice', 'portal']);
    for (const names of row) {
      for (const n of names) {
        const def = blockByName(n);
        if (!def) continue;
        const test = transparentLayer.has(n) ? 0.02 : 0.5;
        // every face of the block, sampled at its four corners
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        let skipped = 0;
        const t = def.tex ?? {};
        const faces = [t.east ?? t.side ?? t.all ?? t.sprite, t.west ?? t.side ?? t.all ?? t.sprite, t.top ?? t.all ?? t.side ?? t.sprite, t.bottom ?? t.all ?? t.side ?? t.sprite, t.south ?? t.side ?? t.all ?? t.sprite, t.north ?? t.side ?? t.all ?? t.sprite];
        for (const tn of faces) {
          if (!tn) continue;
          const rect2 = atlas.uv(tn);
          for (const cu of [rect2.u0, rect2.u1]) {
            for (const cv of [rect2.v0, rect2.v1]) {
              const ax = Math.max(0, Math.min(atlas.width - 1, Math.floor(cu * atlas.width)));
              const ay = Math.max(0, Math.min(atlas.height - 1, Math.floor((1 - cv) * atlas.height)));
              const o = (ay * atlas.width + ax) * 4;
              const a = atlas.data[o + 3] / 255;
              if (a < test) {
                skipped++;
                continue;
              }
              r += atlas.data[o];
              g += atlas.data[o + 1];
              b += atlas.data[o + 2];
              count++;
            }
          }
        }
        if (!count) {
          console.log(`render:   ${n.padEnd(14)} ALL CORNERS DISCARDED (${skipped}) -> invisible`);
          continue;
        }
        const lum = 0.2126 * (r / count) + 0.7152 * (g / count) + 0.0722 * (b / count);
        const flag = lum < 40 ? '   <-- BLACK' : '';
        console.log(
          `render:   ${n.padEnd(14)} rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)}) lum ${lum.toFixed(1)} skipped ${skipped}${flag}`,
        );
      }
    }
  }


  /*
   * An "ocean" shot: a controlled sea carved at the main site with a sand shore,
   * so a body of water that renders black in daylight can be reproduced and
   * looked at. Reported from play as a "black void" with the sand around it
   * darkening, while the underwater overlay still worked.
   */
  if (shots.includes('ocean')) {
    const { SEA_LEVEL } = await load('world/chunk.js');
    const ox = sites.centre[0];
    const oz = sites.centre[1];
    const sandId = blockByName('sand')?.id ?? 0;
    const stoneId = blockByName('stone')?.id ?? 0;
    const waterId = blockByName('water')?.id ?? 0;
    for (let z = oz - 26; z <= oz + 26; z++) {
      for (let x = ox - 26; x <= ox + 26; x++) {
        const r = Math.hypot(x - ox, z - oz);
        if (r > 24) continue;
        // carve from well above the local surface, or the camera ends up inside
        // solid rock and the whole frame renders black
        const top = Math.max(SEA_LEVEL + 12, gen.heightAt(x, z) + 12);
        for (let y = SEA_LEVEL - 8; y <= top; y++) world.setBlock(x, y, z, 0, true);
        world.setBlock(x, SEA_LEVEL - 7, z, stoneId, true);
        for (let y = SEA_LEVEL - 6; y <= SEA_LEVEL; y++) world.setBlock(x, y, z, waterId, true);
        if (r > 17) {
          const step = Math.floor((r - 17) / 2);
          for (let y = SEA_LEVEL + 1; y <= SEA_LEVEL + step; y++) world.setBlock(x, y, z, sandId, true);
        }
      }
    }
    const ccx0 = Math.floor((ox - 26) / 16);
    const ccz0 = Math.floor((oz - 26) / 16);
    const ccx1 = Math.floor((ox + 26) / 16);
    const ccz1 = Math.floor((oz + 26) / 16);
    for (let cz = ccz0; cz <= ccz1; cz++) {
      for (let cx = ccx0; cx <= ccx1; cx++) {
        const k = cx * 100000 + cz;
        if (chunkSet.has(k)) continue;
        chunkSet.add(k);
        chunkList.push([cx, cz]);
        const c = world.createChunk(cx, cz);
        gen.generateChunk(c);
      }
    }
    for (let cz = ccz0; cz <= ccz1; cz++) {
      for (let cx = ccx0; cx <= ccx1; cx++) {
        const c = world.getChunk(cx, cz);
        if (c) world.light.initialLight(c);
      }
    }
    sites.shots.ocean = {
      // inside the basin, a few blocks above the surface, looking across it
      x: ox + 13.5, y: SEA_LEVEL + 3.0, z: oz + 13.5,
      yaw: Math.PI / 4, pitch: -0.12, time: 0.22, fog: [90, 260], underwater: false,
    };
    sites.shots.oceanunder = {
      x: ox + 4.5, y: SEA_LEVEL - 3.0, z: oz + 4.5,
      yaw: Math.PI / 4, pitch: -0.05, time: 0.22, fog: [90, 260], underwater: true,
    };
    console.log(`render: ocean basin carved at ${ox} ${oz}, sea level ${SEA_LEVEL}`);
  }


  const t1 = Date.now();
  const tris = [];
  for (const [cx, cz] of chunkList) {
    const c = world.getChunk(cx, cz);
    if (!c) continue;
    const res = mesher.build(world, c);
    if (res.opaque) collect(tris, res.opaque, cx * 16, cz * 16, false);
    if (res.transparent) collect(tris, res.transparent, cx * 16, cz * 16, true);
  }
  const meshMs = Date.now() - t1;

  // diagnostic: confirm the block-light channel actually made it into the meshes
  {
    let litTris = 0;
    let maxBlk = 0;
    for (const t of tris) {
      const v = t.lit[t.a * 2 + 1];
      if (v > 0.12) litTris++;
      if (v > maxBlk) maxBlk = v;
    }
    console.log(`render: block-lit triangles ${litTris}, peak block light ${maxBlk}/255`);
  }

  for (const shot of shots) {
    const site = sites.shots[shot] ?? sites.shots.day;
    const image = renderView(atlas, tris, site, W, H);
    writePng(path.join(OUT, `view-${shot}.png`), W, H, image.pixels);
    console.log(
      `render[${shot}]: ${image.drawn} tris drawn, camera ${site.x.toFixed(1)} ${site.y.toFixed(1)} ${site.z.toFixed(1)} yaw ${site.yaw.toFixed(2)} pitch ${site.pitch.toFixed(2)}`,
    );
    if (shot === 'ocean' || shot === 'oceanunder') {
      // Is the water actually in the triangle list, and is it reaching the
      // transparent pass? An invisible water surface shows the unlit sea floor,
      // which reads as a black void in daylight.
      const trans = tris.filter((t) => t.transparent);
      let alphaMin = 1;
      let alphaMax = 0;
      let alphaSum = 0;
      for (const t of trans) {
        const a = t.transparentAlpha ?? -1;
        if (a < 0) continue;
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        alphaSum += a;
      }
      const mean = trans.length ? alphaSum / trans.length : 0;
      console.log(
        `render[${shot}]: transparent tris ${trans.length} of ${tris.length}; blend alpha ${alphaMin.toFixed(2)}..${alphaMax.toFixed(2)} mean ${mean.toFixed(2)}; pixels drawn ${image.drawn}`,
      );
    }
  }
  console.log(
    `render: ${tris.length} triangles built in ${meshMs} ms (worldgen ${genMs} ms, ${torches} torches placed), textures ${atlas.count}`,
  );
}

/* ------------------------------------------------------------------ */

/**
 * Pick the compass direction with the most open view (lowest average terrain a
 * few dozen blocks out), so screenshots show landscape instead of a hillside.
 */
function mostOpenYaw(gen, x, z, y) {
  let bestYaw = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 24; i++) {
    const yaw = (i / 24) * TAU - Math.PI;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    let score = 0;
    for (const d of [8, 16, 26, 40, 60]) {
      // score mostly by whether the view is blocked, then by how far it reaches
      const h = gen.columnInfo(Math.round(x + dx * d), Math.round(z + dz * d)).height;
      score += Math.max(0, h - y) * (1 + (60 - d) / 20);
    }
    if (score < bestScore) {
      bestScore = score;
      bestYaw = yaw;
    }
  }
  return bestYaw;
}

function collect(out, data, ox, oz, transparent) {
  const idx = data.indices;
  const pos = data.positions;
  const uv = data.uvs;
  const col = data.colors;
  const lit = data.light;
  for (let i = 0; i < idx.length; i += 3) {
    out.push({
      a: idx[i], b: idx[i + 1], c: idx[i + 2],
      pos, uv, col, lit,
      ox, oz, transparent,
    });
  }
}

/* ------------------------------------------------------------------ */

function pickSites(gen, shots, seed, biomeById) {  const sites = { centre: [0, 0], shots: {} };

  // find a pleasant land column with trees nearby
  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < 1400; r += 8) {
    const a = r * 2.399963;
    const x = Math.round(Math.cos(a) * r);
    const z = Math.round(Math.sin(a) * r);
    const info = gen.columnInfo(x, z);
    const b = biomeById(info.biome);
    if (info.height <= 63) continue;
    let score = info.height - 63;
    if (b.name === 'forest') score += 34;
    if (b.name === 'plains') score += 22;
    if (b.name === 'birch_forest') score += 26;
    if (b.name === 'taiga') score += 18;
    if (b.name === 'desert') score += 6;
    if (b.name === 'ocean' || b.name === 'deep_ocean') score -= 50;
    if (b.name === 'snowy_mountains' || b.name === 'mountains') score -= 14;
    if (score > bestScore) {
      bestScore = score;
      best = { x, z, info, biome: b.name };
    }
  }
  if (!best) best = { x: 0, z: 0, info: gen.columnInfo(0, 0), biome: 'plains' };
  sites.centre = [best.x, best.z];

  const y = best.info.height + 1;
  const ground = best.info.height;

  // Aim the camera at the most open direction so the screenshots show landscape
  // rather than the inside of a hillside.
  const lookYaw = mostOpenYaw(gen, best.x, best.z, ground);

  // day: eye level looking across the landscape
  sites.shots.day = {
    x: best.x + 0.5, y: ground + 1.62, z: best.z + 0.5,
    yaw: lookYaw, pitch: -0.06, time: 0.24, fog: [70, 150], underwater: false,
  };
  // wide: slightly elevated, longer view
  sites.shots.wide = {
    x: best.x + 0.5, y: ground + 4.2, z: best.z + 0.5,
    yaw: lookYaw, pitch: -0.2, time: 0.2, fog: [90, 210], underwater: false, fov: 78,
  };
  // night with torches placed along the view direction
  sites.shots.night = {
    x: best.x + 0.5, y: ground + 1.62, z: best.z + 0.5,
    yaw: lookYaw, pitch: -0.04, time: 0.78, fog: [40, 110], underwater: false, torch: true,
  };
  // find a cave for the underground shot
  let cave = null;
  for (let r = 0; r < 260 && !cave; r += 6) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU + r;
      const x = Math.round(best.x + Math.cos(a) * r);
      const z = Math.round(best.z + Math.sin(a) * r);
      const h = gen.columnInfo(x, z).height;
      for (let yy = 22; yy < Math.min(h - 6, 52); yy++) {
        if (gen.caves.isCarved(x, yy, z, h, gen.caves.regionAt(x, z))) {
          cave = { x: x + 0.5, y: yy, z: z + 0.5 };
          break;
        }
      }
      if (cave) break;
    }
  }
  sites.shots.cave = cave
    ? { x: cave.x, y: cave.y, z: cave.z, yaw: 0.9, pitch: 0.0, time: 0.25, fog: [8, 34], underwater: false, torch: true }
    : { ...sites.shots.night, pitch: -0.5 };

  // underwater shot if the spawn biome is near an ocean
  let water = null;
  for (let r = 0; r < 300 && !water; r += 8) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const x = Math.round(best.x + Math.cos(a) * r);
      const z = Math.round(best.z + Math.sin(a) * r);
      const info = gen.columnInfo(x, z);
      if (info.height < 58 && info.height > 48) {
        water = { x: x + 0.5, y: 59.5, z: z + 0.5 };
        break;
      }
    }
  }
  if (water) {
    sites.shots.underwater = { ...water, yaw: 0.4, pitch: 0.0, time: 0.24, fog: [1, 22], underwater: true };
  }

  void shots;
  void seed;
  return sites;
}

/* ------------------------------------------------------------------ */
/* Rasteriser                                                          */
/* ------------------------------------------------------------------ */

const SKY = {
  dayTop: [0.247, 0.498, 0.863],
  dayHorizon: [0.663, 0.796, 0.941],
  nightTop: [0.012, 0.02, 0.055],
  nightHorizon: [0.039, 0.063, 0.141],
  duskHorizon: [0.878, 0.478, 0.235],
  duskTop: [0.172, 0.247, 0.471],
  below: [0.039, 0.063, 0.125],
};

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function skyState(time) {
  const a = time * TAU;
  const sun = [Math.cos(a), Math.sin(a), 0.28];
  const len = Math.hypot(sun[0], sun[1], sun[2]);
  sun[0] /= len;
  sun[1] /= len;
  sun[2] /= len;
  const day = smooth(-0.14, 0.26, sun[1]);
  const dusk = Math.max(0, 1 - Math.abs(sun[1]) / 0.32) * smooth(-0.28, -0.02, sun[1]);
  const top = mix3(mix3(SKY.nightTop, SKY.dayTop, day), SKY.duskTop, dusk * 0.7);
  const horizon = mix3(mix3(SKY.nightHorizon, SKY.dayHorizon, day), SKY.duskHorizon, dusk * 0.85);
  const skyLight = mix3([0.13, 0.16, 0.29], [1.0, 0.99, 0.95], day);
  const ambient = mix3([0.02, 0.023, 0.038], [0.055, 0.058, 0.07], day);
  return { sun, day, top, horizon, skyLight, ambient, fog: horizon };
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function renderView(atlas, tris, site, W, H) {
  const pixels = new Uint8ClampedArray(W * H * 4);
  const depth = new Float32Array(W * H).fill(Infinity);
  const sky = skyState(site.time ?? 0.25);
  const fov = ((site.fov ?? 75) * Math.PI) / 180;
  const f = 1 / Math.tan(fov / 2);
  const aspect = W / H;

  const cy = Math.cos(site.yaw);
  const sy = Math.sin(site.yaw);
  const cp = Math.cos(site.pitch);
  const sp = Math.sin(site.pitch);

  // World -> view. Camera basis:
  //   forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))
  //   right   = ( cos(yaw), 0, -sin(yaw))
  //   zView   = -forward, so points in front have a positive depth.
  const toView = (wx, wy, wz) => {
    const dx = wx - site.x;
    const dy = wy - site.y;
    const dz = wz - site.z;
    const rx = dx * cy - dz * sy;
    const rz = dx * sy + dz * cy;
    const vx = rx;
    const vy = dy * cp + rz * sp;
    const depth = dy * sp - rz * cp;
    return [vx, vy, depth];
  };

  // ---- sky background -------------------------------------------------
  for (let y = 0; y < H; y++) {
    const ndcY = (1 - (2 * y) / H) / f;
    for (let x = 0; x < W; x++) {
      const ndcX = ((2 * x) / W - 1) * aspect / f;
      // screen ray: view space is (ndcX, ndcY, -1), forward is -zView
      const vx = ndcX;
      const vy = ndcY;
      const wx = vx * cy + vy * sp * sy - sy * cp;
      const wy = vy * cp + sp;
      const wz = -vx * sy + vy * sp * cy - cy * cp;
      const wl = Math.hypot(wx, wy, wz) || 1;
      const dx = wx / wl;
      const dy = wy / wl;
      const dz = wz / wl;
      const up = dy;
      let col;
      if (up >= 0) {
        col = mix3(sky.horizon, sky.top, Math.pow(Math.min(1, up), 0.62));
      } else {
        col = mix3(sky.horizon, SKY.below, Math.min(1, -up * 2.4));
      }
      const sd = Math.max(0, dx * sky.sun[0] + dy * sky.sun[1] + dz * sky.sun[2]);
      const glow = Math.pow(sd, 220) * 1.4 + Math.pow(sd, 6) * 0.22;
      col = [col[0] + glow, col[1] + glow * 0.96, col[2] + glow * 0.78];
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > 0 && sd > 0) {
        const right = normalize(cross(sky.sun, [0, 1, 0]));
        const upv = normalize(cross(right, sky.sun));
        const ex = Math.abs(dx * right[0] + dy * right[1] + dz * right[2]);
        const ey = Math.abs(dx * upv[0] + dy * upv[1] + dz * upv[2]);
        if (Math.max(ex, ey) < 0.03) col = [1.6, 1.5, 1.15];
      }
      const o = (y * W + x) * 4;
      pixels[o] = col[0] * 255;
      pixels[o + 1] = col[1] * 255;
      pixels[o + 2] = col[2] * 255;
      pixels[o + 3] = 255;
    }
  }

  // ---- terrain --------------------------------------------------------
  const fogNear = site.fog ? site.fog[0] : 70;
  const fogFar = site.fog ? site.fog[1] : 150;
  const fogCol = site.underwater ? [0.09, 0.24, 0.5] : sky.fog;

  let drawn = 0;
  const ordered = site.underwater ? tris : tris;
  // opaque pass
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (t.transparent) continue;
    if (raster(atlas, pixels, depth, t, site, toView, f, aspect, W, H, fogNear, fogFar, fogCol, sky, false)) drawn++;
  }
  // transparent pass, back to front (approximate: sort by camera distance)
  const trans = [];
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (!t.transparent) continue;
    const px = t.pos[t.a * 3] + t.ox;
    const pz = t.pos[t.a * 3 + 2] + t.oz;
    trans.push([(px - site.x) ** 2 + (pz - site.z) ** 2, i]);
  }
  trans.sort((a, b) => b[0] - a[0]);
  for (const [, i] of trans) {
    if (raster(atlas, pixels, depth, ordered[i], site, toView, f, aspect, W, H, fogNear, fogFar, fogCol, sky, true)) drawn++;
  }

  return { pixels, drawn };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function raster(atlas, pixels, depth, t, site, toView, f, aspect, W, H, fogNear, fogFar, fogCol, sky, blend) {
  const { pos, uv, col, lit, ox, oz } = t;
  const idxs = [t.a, t.b, t.c];
  const vx = [];
  const vy = [];
  const vz = [];
  const uu = [];
  const vv = [];
  const cr = [];
  const cg = [];
  const cb = [];
  const ls = [];
  const lb = [];
  const iw = [];
  for (let k = 0; k < 3; k++) {
    const i = idxs[k];
    const wx = pos[i * 3] + ox;
    const wy = pos[i * 3 + 1];
    const wz = pos[i * 3 + 2] + oz;
    const [a, b, c] = toView(wx, wy, wz);
    // `c` is the view-space depth (positive in front of the camera)
    if (c < 0.06) return false;
    const invw = 1 / c;
    vx.push((a * f) / aspect / c);
    vy.push((b * f) / c);
    vz.push(c);
    iw.push(invw);
    // uv is a normalised Uint16 and light a normalised Uint8; the shader divides
    // by 65535 and 255 respectively, so the reference renderer must too.
    uu.push(uv[i * 2] / 65535);
    vv.push(uv[i * 2 + 1] / 65535);
    cr.push(col[i * 4] / 255);
    cg.push(col[i * 4 + 1] / 255);
    cb.push(col[i * 4 + 2] / 255);
    ls.push(lit[i * 2] / 255);
    lb.push(lit[i * 2 + 1] / 255);
  }

  const sx = vx.map((v) => ((v + 1) * 0.5) * W);
  const sy = vy.map((v) => (1 - (v + 1) * 0.5) * H);

  const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
  if (Math.abs(area) < 1e-9) return false;

  const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
  const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
  if (minX > maxX || minY > maxY) return false;

  const invArea = 1 / area;
  const ambient = sky.ambient;
  const skyL = sky.skyLight;
  const blockL = [1.0, 0.72, 0.42];
  let touched = false;

  for (let py = minY; py <= maxY; py++) {
    const fy = py + 0.5;
    for (let px = minX; px <= maxX; px++) {
      const fx = px + 0.5;
      let w0 = ((sx[1] - fx) * (sy[2] - fy) - (sx[2] - fx) * (sy[1] - fy)) * invArea;
      let w1 = ((sx[2] - fx) * (sy[0] - fy) - (sx[0] - fx) * (sy[2] - fy)) * invArea;
      let w2 = 1 - w0 - w1;
      if (w0 < -0.0001 || w1 < -0.0001 || w2 < -0.0001) continue;
      w0 = Math.max(0, w0);
      w1 = Math.max(0, w1);
      w2 = Math.max(0, w2);

      const iwSum = w0 * iw[0] + w1 * iw[1] + w2 * iw[2];
      const z = 1 / iwSum;
      const o = py * W + px;
      if (z >= depth[o]) continue;

      const bu = (w0 * uu[0] * iw[0] + w1 * uu[1] * iw[1] + w2 * uu[2] * iw[2]) / iwSum;
      const bv = (w0 * vv[0] * iw[0] + w1 * vv[1] * iw[1] + w2 * vv[2] * iw[2]) / iwSum;
      const sr = (w0 * cr[0] * iw[0] + w1 * cr[1] * iw[1] + w2 * cr[2] * iw[2]) / iwSum;
      const sg = (w0 * cg[0] * iw[0] + w1 * cg[1] * iw[1] + w2 * cg[2] * iw[2]) / iwSum;
      const sb = (w0 * cb[0] * iw[0] + w1 * cb[1] * iw[1] + w2 * cb[2] * iw[2]) / iwSum;
      const sl = (w0 * ls[0] * iw[0] + w1 * ls[1] * iw[1] + w2 * ls[2] * iw[2]) / iwSum;
      const sbl = (w0 * lb[0] * iw[0] + w1 * lb[1] * iw[1] + w2 * lb[2] * iw[2]) / iwSum;

      const tx = Math.max(0, Math.min(atlas.width - 1, Math.floor(bu * atlas.width)));
      const ty = Math.max(0, Math.min(atlas.height - 1, Math.floor((1 - bv) * atlas.height)));
      const to = (ty * atlas.width + tx) * 4;
      const ta = atlas.data[to + 3] / 255;
      /*
       * Model each layer's shader exactly, alpha test included.
       *
       * The opaque terrain shader tests at 0.5; the shared transparent-layer
       * shader tests at 0.02 and blends with the texel's own alpha. Getting this
       * wrong is not cosmetic: dropping the opaque test draws a cross plant's
       * clear texels as opaque black, which is the exact artefact this whole
       * investigation started from. An instrument that skips the test the shader
       * performs cannot see what the shader sees.
       */
      const alphaTest = blend ? 0.02 : 0.5;
      if (ta < alphaTest) continue;

      const lr = Math.max(Math.max(skyL[0] * sl, blockL[0] * sbl), ambient[0]);
      const lg = Math.max(Math.max(skyL[1] * sl, blockL[1] * sbl), ambient[1]);
      const lbl = Math.max(Math.max(skyL[2] * sl, blockL[2] * sbl), ambient[2]);

      let r = (atlas.data[to] / 255) * sr * lr;
      let g = (atlas.data[to + 1] / 255) * sg * lg;
      let b = (atlas.data[to + 2] / 255) * sb * lbl;

      const fog = Math.min(1, Math.max(0, (z - fogNear) / Math.max(1, fogFar - fogNear)));
      const fg = fog * fog * (3 - 2 * fog);
      r = r + (fogCol[0] - r) * fg;
      g = g + (fogCol[1] - g) * fg;
      b = b + (fogCol[2] - b) * fg;

      const po = o * 4;
      if (blend) {
        /*
         * Match the transparent-layer shader: alpha is the texel's own alpha
         * times the material's `uOpacity`. The water material sets that to 0.6
         * so the sea floor shows through; without modelling it here the render
         * showed water at its raw ~86% and could not show the difference.
         */
        const alpha = ta * (t.waterOpacity ?? 0.6);
        pixels[po] = pixels[po] * (1 - alpha) + r * 255 * alpha;
        pixels[po + 1] = pixels[po + 1] * (1 - alpha) + g * 255 * alpha;
        pixels[po + 2] = pixels[po + 2] * (1 - alpha) + b * 255 * alpha;
      } else {
        pixels[po] = r * 255;
        pixels[po + 1] = g * 255;
        pixels[po + 2] = b * 255;
        depth[o] = z;
      }
      touched = true;
    }
  }
  return touched;
}
