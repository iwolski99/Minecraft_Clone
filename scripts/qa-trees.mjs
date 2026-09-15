// Tree QA.
//
// Reported verbatim: "trees don't have enough leaves / wood comes out of the top
// of all the trees". Both halves of that are shape properties, so this suite
// measures them directly instead of eyeballing a screenshot:
//
//   * every species is swept over hundreds of generated shapes and checked for a
//     capped trunk (the top log always has a leaf over it *and* leaves beside
//     it), a dome/cone silhouette, a sane leaf count for the species and a
//     bounded horizontal reach;
//   * real chunks are generated for several seeds and every tree found in them
//     is re-derived from its own deterministic seed and compared block-for-block
//     with what the world actually contains. One missing block means the canopy
//     was clipped - by the chunk border, by the world ceiling or by the
//     decoration pass - which is the cross-chunk half of the same bug;
//   * the ids that ended up in the world are checked against the biome's own
//     tree list, and the village protection is measured so that it cannot be the
//     reason a biome looks bare.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { CHUNK_Y } = await load('world/chunk.js');
  const { B } = await load('world/blocks.js');
  const { biomeById } = await load('worldgen/biomes.js');
  const { Rng, hash2 } = await load('util/rng.js');
  const T = await load('worldgen/trees.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const info = (m) => console.log(`  . ${m}`);

  const LOG = new Set([B.oak_log, B.birch_log, B.spruce_log]);
  const LEAF = new Set([B.oak_leaves, B.birch_leaves, B.spruce_leaves]);
  const nameOf = new Map([
    [B.oak_log, 'oak_log'], [B.birch_log, 'birch_log'], [B.spruce_log, 'spruce_log'],
    [B.oak_leaves, 'oak_leaves'], [B.birch_leaves, 'birch_leaves'], [B.spruce_leaves, 'spruce_leaves'],
  ]);
  const label = (id) => nameOf.get(id) ?? String(id);

  /* ------------------------------------------------------------------ */
  /* Species table: what each shape is supposed to look like             */
  /* ------------------------------------------------------------------ */

  const SPECIES = [
    // trunk/leaves are inclusive ranges, width is the widest canopy layer.
    // `dome` marks the single-blob broadleaf species the reported bug was about:
    // their canopy may not keep growing above its widest layer (a spire reads as
    // "not enough leaves"), and their widest layer must be a solid plate.
    // `capMass` is the least number of leaves allowed in the 7x7x5 box around
    // the top of the trunk - the direct measure of "wood poking out of the top".
    { name: 'oak', fn: T.oakTree, log: B.oak_log, leaf: B.oak_leaves, trunk: [4, 6], leaves: [40, 100], width: 5, dome: true, aboveWidest: 2, maxLayers: 4, capMass: 40, minSide: 3 },
    { name: 'birch', fn: T.birchTree, log: B.birch_log, leaf: B.birch_leaves, trunk: [4, 6], leaves: [40, 100], width: 5, dome: true, aboveWidest: 2, maxLayers: 4, capMass: 40, minSide: 3 },
    // a big oak hangs its canopy off branches, so its layers legitimately reach
    // past the widest one, its branches replace leaves beside the trunk and it
    // is judged on canopy mass instead of a dome profile
    { name: 'big_oak', fn: T.bigOakTree, log: B.oak_log, leaf: B.oak_leaves, trunk: [7, 10], leaves: [120, 320], width: 7, dome: false, aboveWidest: 99, maxLayers: 8, capMass: 40, minSide: 1 },
    { name: 'spruce', fn: T.spruceTree, log: B.spruce_log, leaf: B.spruce_leaves, trunk: [7, 11], leaves: [60, 230], width: 5, dome: false, cone: true, aboveWidest: 99, maxLayers: 12, capMass: 20, minSide: 3 },
  ];
  const byLogAndTrunk = (logId, trunkLen) =>
    SPECIES.find((s) => s.log === logId && trunkLen >= s.trunk[0] && trunkLen <= s.trunk[1]) ?? null;

  /**
   * Everything this suite asserts about one tree, measured from its blocks.
   * `blocks` is a list of `[x, y, z, id]`.
   */
  function stats(blocks, logId, leafId) {
    const at = new Map();
    for (const [x, y, z, id] of blocks) at.set(`${x},${y},${z}`, id);
    const isLog = (x, y, z) => at.get(`${x},${y},${z}`) === logId;
    const isLeaf = (x, y, z) => at.get(`${x},${y},${z}`) === leafId;

    let trunkLen = 0;
    while (isLog(0, trunkLen, 0)) trunkLen++;
    const trunkTop = trunkLen - 1;

    let leaves = 0;
    let maxLeafY = -Infinity;
    let maxLogY = -Infinity;
    let maxR = 0;
    /** y -> { n: cells, w: layer width } */
    const layers = new Map();
    for (const [x, y, z, id] of blocks) {
      if (id === logId) {
        maxLogY = Math.max(maxLogY, y);
        maxR = Math.max(maxR, Math.abs(x), Math.abs(z));
      } else if (id === leafId) {
        leaves++;
        maxLeafY = Math.max(maxLeafY, y);
        maxR = Math.max(maxR, Math.abs(x), Math.abs(z));
        const l = layers.get(y) ?? { n: 0, w: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        l.n++;
        l.minX = Math.min(l.minX, x);
        l.maxX = Math.max(l.maxX, x);
        l.minZ = Math.min(l.minZ, z);
        l.maxZ = Math.max(l.maxZ, z);
        layers.set(y, l);
      }
    }
    for (const l of layers.values()) l.w = Math.max(l.maxX - l.minX, l.maxZ - l.minZ) + 1;

    /** how many of the four neighbours of the trunk at y are leaves */
    const sideLeaves = (y) =>
      (isLeaf(1, y, 0) ? 1 : 0) + (isLeaf(-1, y, 0) ? 1 : 0) + (isLeaf(0, y, 1) ? 1 : 0) + (isLeaf(0, y, -1) ? 1 : 0);

    // the highest log that still has leaves beside it; any log above that one is
    // bare wood sticking out of the canopy
    let lastCoveredY = -Infinity;
    for (let y = 0; y <= trunkTop; y++) if (sideLeaves(y) > 0) lastCoveredY = y;

    // widest layer (highest of the ties) and how many layers sit above it
    let widest = 0;
    let widestSpan = 0;
    let widestY = -Infinity;
    for (const [y, l] of layers) {
      if (l.w > widestSpan || (l.w === widestSpan && y > widestY)) {
        widestSpan = l.w;
        widest = l.n;
        widestY = y;
      }
    }
    let aboveWidest = 0;
    for (const y of layers.keys()) if (y > widestY) aboveWidest++;

    // leaf mass wrapped around the top of the trunk: a bare wooden spike scores
    // almost nothing here even though it may still have a single leaf on top
    let capMass = 0;
    for (const [x, y, z, id] of blocks) {
      if (id !== leafId) continue;
      if (Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= trunkTop - 2 && y <= trunkTop + 2) capMass++;
    }

    return {
      trunkLen, trunkTop, leaves, maxLeafY, maxLogY, maxR, layers, capMass,
      capLeaf: isLeaf(0, trunkTop + 1, 0),
      sideTop: sideLeaves(trunkTop),
      sideBelow: trunkTop > 0 ? sideLeaves(trunkTop - 1) : 4,
      lastCoveredY,
      widest, widestSpan, aboveWidest,
      canopyLayers: layers.size,
      maxHeight: Math.max(...blocks.map((b) => b[1])),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Part A: shape sweep                                                 */
  /* ------------------------------------------------------------------ */

  const SWEEP = 150;
  const sweepProblems = [];
  const sweepSizes = new Map();

  for (const sp of SPECIES) {
    const sizes = [];
    for (let i = 0; i < SWEEP; i++) {
      const shape = sp.fn(new Rng((i * 2654435761 + 0x9e3779b9) >>> 0));
      const s = stats(shape.blocks, sp.log, sp.leaf);
      sizes.push(s.leaves);
      const where = `${sp.name}#${i}`;
      const note = (m) => sweepProblems.push(`${where}: ${m}`);

      if (s.trunkLen < sp.trunk[0] || s.trunkLen > sp.trunk[1]) note(`trunk ${s.trunkLen} outside ${sp.trunk.join('..')}`);
      if (s.leaves < sp.leaves[0] || s.leaves > sp.leaves[1]) note(`${s.leaves} leaves outside ${sp.leaves.join('..')}`);
      // a leaf block at or above the top of the trunk
      if (!(s.maxLeafY >= s.trunkTop)) note(`highest leaf y=${s.maxLeafY} is below the trunk top y=${s.trunkTop}`);
      // no wood poking out of the top: the trunk top is capped and surrounded
      if (!s.capLeaf) note('no leaf directly above the top log');
      if (s.sideTop < sp.minSide) note(`only ${s.sideTop}/4 leaves beside the top log`);
      if (s.sideBelow < sp.minSide) note(`only ${s.sideBelow}/4 leaves beside the log under the top`);
      if (s.lastCoveredY < s.trunkTop) note(`bare trunk from y=${s.lastCoveredY + 1} up to y=${s.trunkTop}`);
      // the highest non-leaf block must be strictly below the highest leaf
      if (!(s.maxLogY < s.maxLeafY)) note(`highest log y=${s.maxLogY} is not below the highest leaf y=${s.maxLeafY}`);
      if (s.capMass < sp.capMass) note(`only ${s.capMass} leaves around the top of the trunk (want ${sp.capMass})`);
      if (sp.cone) {
        // spruce narrows toward the top: no layer may be wider than the one below
        const ys = [...s.layers.keys()].sort((a, b) => a - b);
        for (let k = 1; k < ys.length; k++) {
          if (s.layers.get(ys[k]).w > s.layers.get(ys[k - 1]).w) {
            note(`layer y=${ys[k]} (w=${s.layers.get(ys[k]).w}) is wider than y=${ys[k - 1]} below it`);
            break;
          }
        }
        if (ys.length && s.layers.get(ys[ys.length - 1]).w > 3) note(`tip layer is ${s.layers.get(ys[ys.length - 1]).w} wide`);
      }
      if (sp.dome) {
        // a broadleaf canopy is a dome, not a spire: it may not keep growing
        // above its widest layer, which is what made the canopy look thin
        if (s.aboveWidest > sp.aboveWidest) note(`${s.aboveWidest} layers above the widest layer (spire, not a dome)`);
        if (s.canopyLayers > sp.maxLayers) note(`canopy is ${s.canopyLayers} layers tall`);
        // the widest layer must be a solid mass, not a lattice
        if (s.widestSpan > 1 && s.widest < 0.65 * s.widestSpan * s.widestSpan) note(`widest layer has only ${s.widest} cells`);
      } else if (s.canopyLayers > sp.maxLayers) {
        note(`canopy is ${s.canopyLayers} layers tall`);
      }
      if (s.widestSpan < sp.width) note(`widest canopy layer is only ${s.widestSpan} wide`);
      // reach: terrain.ts only scans a one-chunk halo before decorating
      if (s.maxR > T.MAX_TREE_RADIUS) note(`reaches ${s.maxR} blocks from the trunk (max ${T.MAX_TREE_RADIUS})`);
      // no duplicate blocks, sane extent, honest shape.height
      const seen = new Set();
      for (const [x, y, z] of shape.blocks) {
        const k = `${x},${y},${z}`;
        if (seen.has(k)) note(`duplicate block at ${k}`);
        seen.add(k);
        if (y < 0 || y > 40) note(`block at y=${y} is outside the shape`);
      }
      if (shape.height !== s.maxHeight) note(`shape.height ${shape.height} != highest block ${s.maxHeight}`);
    }
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    sweepSizes.set(sp.name, `${Math.min(...sizes)}..${Math.max(...sizes)} (avg ${avg.toFixed(0)})`);
  }

  /** Collapses hundreds of failures into "kind xN (e.g. one example)". */
  const report = (problems, prefix) => {
    const kinds = new Map();
    for (const p of problems) {
      const kind = p.slice(p.indexOf(': ') + 2).replace(/-?\d+/g, 'N');
      const e = kinds.get(kind) ?? { n: 0, example: p };
      e.n++;
      kinds.set(kind, e);
    }
    for (const [kind, e] of [...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
      console.error(`  FAIL ${prefix} x${e.n}: ${kind}   (e.g. ${e.example})`);
    }
  };

  for (const sp of SPECIES) info(`${sp.name.padEnd(8)} ${SWEEP} shapes, leaves ${sweepSizes.get(sp.name)}`);
  report(sweepProblems, 'shape');
  check('shape sweep has no shape problems', sweepProblems.length === 0, `${sweepProblems.length} problems`);

  // cactus / dead bush are tree shapes too: no leaves, and they stay in range
  let leaflessBad = 0;
  for (const fn of [T.cactusTree, T.deadBushShape]) {
    for (let i = 0; i < 40; i++) {
      const shape = fn(new Rng(i + 1));
      if (shape.blocks.some(([, y, , id]) => LEAF.has(id) || y < 0 || y > 8)) leaflessBad++;
    }
  }
  check('cactus / dead bush stay leafless and in range', leaflessBad === 0, `${leaflessBad} bad shapes`);

  /* ------------------------------------------------------------------ */
  /* Part B: world sweep                                                 */
  /* ------------------------------------------------------------------ */

  // Six regions, each centred on a chunk that really grows trees, so the sweep
  // sees a few hundred trunks and several biomes instead of empty ocean.
  const REGIONS = [
    { seed: 4242, want: 'forest' },
    { seed: 9001, want: 'taiga' },
    { seed: 31337, want: 'birch_forest' },
    { seed: 20260101, want: 'snowy_taiga' },
    { seed: 777001, want: 'forest' },
    { seed: 5150, want: 'birch_forest' },
  ];
  const R = 3; // 7x7 chunks per region
  let trees = 0;
  let unmatched = 0;
  let missing = 0;
  let blocked = 0;
  let foreign = 0;
  let clippedByCeiling = 0;
  let unloadedRefs = 0;
  const speciesSeen = new Map();
  const biomesSeen = new Map();
  const worldProblems = [];
  const worst = [];
  const leafRatios = [];
  const ownRatios = [];
  const capMasses = [];
  let edgeTrees = 0;
  // In a dense forest neighbouring canopies trade cells (a later trunk can take
  // a leaf cell), so the world measures are looser than the shape ones.
  const WORLD_CAP_MASS = 25;

  /** Chunk origin of the densest tree biome the scan can find for `want`. */
  function pickOrigin(gen, want) {
    let best = [0, 0];
    let bestScore = -1;
    for (let cz = -20; cz <= 20; cz += 4) {
      for (let cx = -20; cx <= 20; cx += 4) {
        const b = biomeById(gen.columnInfo(cx * 16 + 8, cz * 16 + 8).biome);
        const score = b.treeDensity + (b.name === want ? 100 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = [cx, cz];
        }
      }
    }
    return best;
  }

  for (const region of REGIONS) {
    const { seed, want } = region;
    const gen = new TerrainGenerator(seed);
    const world = new World(seed, gen);
    const [ocx, ocz] = pickOrigin(gen, want);
    for (let cz = ocz - R; cz <= ocz + R; cz++) {
      for (let cx = ocx - R; cx <= ocx + R; cx++) {
        const c = world.createChunk(cx, cz);
        gen.generateChunk(c);
      }
    }
    const x0 = (ocx - R) * 16;
    const z0 = (ocz - R) * 16;
    const x1 = (ocx + R + 1) * 16;
    const z1 = (ocz + R + 1) * 16;

    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        // A tree is planted with its base exactly at (terrain surface + 1), so
        // that is where a trunk has to start. Branch logs of a big oak hang in
        // the canopy (or poke out of a hillside) and are never found this way.
        const base = gen.columnInfo(x, z).height + 1;
        if (base < 1 || base >= CHUNK_Y - 1) continue;
        const logId = world.getBlockAt(x, base, z);
        if (!LOG.has(logId)) continue;

        let trunkTop = base;
        while (LOG.has(world.getBlockAt(x, trunkTop + 1, z))) trunkTop++;
        const trunkLen = trunkTop - base + 1;

        // re-derive the shape this column must have been generated from
        const sp = byLogAndTrunk(logId, trunkLen);
        if (!sp) {
          unmatched++;
          if (worst.length < 6) worst.push(`seed ${seed} ${x},${z}: ${label(logId)} trunk ${trunkLen} matches no species`);
          continue;
        }
        const shape = sp.fn(new Rng(hash2(seed ^ 0x7211, x, z)));
        trees++;
        speciesSeen.set(sp.name, (speciesSeen.get(sp.name) ?? 0) + 1);

        const biome = biomeById(gen.columnInfo(x, z).biome);
        biomesSeen.set(biome.name, (biomesSeen.get(biome.name) ?? 0) + 1);

        // (1) the biome's own tree list must allow this species' log id
        const allowed = biome.trees.some((t) =>
          t.type === 'oak' || t.type === 'big_oak' ? logId === B.oak_log
            : t.type === 'birch' ? logId === B.birch_log
              : t.type === 'spruce' ? logId === B.spruce_log
                : false);
        if (!allowed) {
          worldProblems.push(`seed ${seed} ${x},${z}: ${label(logId)} tree in ${biome.name} (grows ${biome.trees.map((t) => t.type).join('/') || 'nothing'})`);
        }

        if (base + shape.height >= CHUNK_Y) {
          clippedByCeiling++;
          continue; // a tree at the build limit is clipped by design
        }

        // (2) every block of the shape that lands inside the generated region
        //     must be there: this is the cross-border clipping test
        let ownLeaves = 0;
        let treeMass = 0;
        let expectedLeaves = 0;
        // highest wood of this tree vs the highest leaves over its own
        // footprint: the literal "no wood poking out of the canopy" test,
        // measured on the world and limited to this tree's cells so a
        // neighbouring trunk cannot skew it
        let ownLogTop = -Infinity;
        let ownLeafTop = -Infinity;
        for (const [dx, dy, dz, id] of shape.blocks) {
          const wx = x + dx;
          const wy = base + dy;
          const wz = z + dz;
          if (wx < x0 || wx >= x1 || wz < z0 || wz >= z1) continue;
          if (wy < 1 || wy >= CHUNK_Y) {
            worldProblems.push(`seed ${seed} ${x},${z}: shape block at y=${wy} outside the world`);
            continue;
          }
          if (!world.isLoadedAt(wx, wz)) unloadedRefs++;
          if (id === sp.leaf) expectedLeaves++;
          const got = world.getBlockAt(wx, wy, wz);
          if (LEAF.has(got)) ownLeafTop = Math.max(ownLeafTop, wy);
          if (id === sp.log && LOG.has(got)) ownLogTop = Math.max(ownLogTop, wy);
          if (got === id) {
            if (id === sp.leaf) {
              ownLeaves++;
              treeMass++;
            }
            continue;
          }
          if (got === 0) {
            missing++;
            if (worst.length < 6) worst.push(`seed ${seed} ${x},${z}: ${label(id)} missing at ${wx},${wy},${wz}`);
          } else if (LOG.has(got) || LEAF.has(got)) {
            foreign++; // another tree's trunk/leaf won the cell
            if (id === sp.leaf) treeMass++;
          } else {
            blocked++; // terrain or a structure is in the way
          }
        }
        if (!(ownLogTop < ownLeafTop)) {
          worldProblems.push(`seed ${seed} ${x},${z}: highest log y=${ownLogTop} is not below the highest leaf y=${ownLeafTop}`);
        }

        // (3) the per-tree invariants, measured on what the world really holds.
        // A window around the trunk is only meaningful when the whole window is
        // inside the generated region (getBlockAt returns air for unloaded
        // chunks), so trees hugging the border are judged by the shape match.
        const windowed = x - 4 >= x0 && x + 4 < x1 && z - 4 >= z0 && z + 4 < z1;
        if (!windowed) {
          edgeTrees++;
        } else {
          if (!LEAF.has(world.getBlockAt(x, trunkTop + 1, z))) {
            worldProblems.push(`seed ${seed} ${x},${z}: no leaf above the trunk top (${label(world.getBlockAt(x, trunkTop + 1, z))})`);
          }
          let sideTop = 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (LEAF.has(world.getBlockAt(x + dx, trunkTop, z + dz))) sideTop++;
          }
          if (sideTop < 2) worldProblems.push(`seed ${seed} ${x},${z}: only ${sideTop}/4 leaves beside the top log`);
          // the direct measure of "wood out of the top": how much leaf mass is
          // wrapped around the top of the trunk in the world right now
          let capMass = 0;
          for (let y = trunkTop - 2; y <= trunkTop + 2; y++) {
            for (let dz = -3; dz <= 3; dz++) {
              for (let dx = -3; dx <= 3; dx++) {
                if (LEAF.has(world.getBlockAt(x + dx, y, z + dz))) capMass++;
              }
            }
          }
          if (capMass < WORLD_CAP_MASS) worldProblems.push(`seed ${seed} ${x},${z}: only ${capMass} leaves around the trunk top (want ${WORLD_CAP_MASS})`);
          capMasses.push(capMass);
        }
        // leaf count sanity: the species range was checked in part A, here it is
        // enough that the canopy is still tree material rather than a skeleton
        if (expectedLeaves > 0 && treeMass < expectedLeaves * 0.6) {
          worldProblems.push(`seed ${seed} ${x},${z}: only ${treeMass}/${expectedLeaves} canopy cells are still tree blocks`);
        }
        leafRatios.push(treeMass / Math.max(1, expectedLeaves));
        ownRatios.push(ownLeaves / Math.max(1, expectedLeaves));
      }
    }
  }

  const pct = (list, p) => {
    if (!list.length) return 0;
    const s = [...list].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  info(`world sweep: ${REGIONS.length} regions x ${(R * 2 + 1) ** 2} chunks -> ${trees} trees`);
  info(`species: ${[...speciesSeen].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  info(`biomes: ${[...biomesSeen].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  info(`canopy cells still tree blocks: min ${(pct(leafRatios, 0) * 100).toFixed(0)}%, median ${(pct(leafRatios, 0.5) * 100).toFixed(0)}% (own leaf id: median ${(pct(ownRatios, 0.5) * 100).toFixed(0)}%)`);
  info(`leaves around the trunk top: min ${pct(capMasses, 0)}, median ${pct(capMasses, 0.5)} (${edgeTrees} border trees judged by shape match only)`);
  info(`shape match: ${missing} missing, ${blocked} blocked by terrain, ${foreign} overwritten by a neighbour tree`);
  for (const w of worst) info(`unmatched trunk: ${w}`);
  report(worldProblems, 'world');

  check('a few hundred trees were inspected', trees >= 300, `${trees} trees`);
  check('every tree matches a known species', unmatched <= Math.max(2, trees * 0.01), `${unmatched} unmatched trunks`);
  check('at least three species appear across the regions', speciesSeen.size >= 3, [...speciesSeen.keys()].join(','));
  check('at least four biomes appear across the regions', biomesSeen.size >= 4, [...biomesSeen.keys()].join(','));
  check('every shape block inside the region is present (no border clipping)', missing === 0, `${missing} missing blocks`);
  check('all tree blocks live in loaded chunks', unloadedRefs === 0, `${unloadedRefs} references to unloaded chunks`);
  check('no tree violates the canopy invariants in the world', worldProblems.length === 0, `${worldProblems.length} problems`);
  check('no tree needs ceiling clipping', clippedByCeiling === 0, `${clippedByCeiling} trees at the build limit`);

  /* ------------------------------------------------------------------ */
  /* Part C: village protection must not swallow the world               */
  /* ------------------------------------------------------------------ */

  const gen = new TerrainGenerator(REGIONS[0].seed);
  let protectedCols = 0;
  let sampled = 0;
  for (let z = -512; z <= 512; z += 7) {
    for (let x = -512; x <= 512; x += 7) {
      sampled++;
      if (gen.structures.isVillageArea(x, z)) protectedCols++;
    }
  }
  const ratio = protectedCols / sampled;
  info(`village protection covers ${(ratio * 100).toFixed(2)}% of ${sampled} sampled columns`);
  check('village protection is local, not global', ratio < 0.2, `${(ratio * 100).toFixed(1)}% of columns protected`);

  /* ---- leaf decay ---- */
  {
    /*
     * Reported from play: leaves stayed floating when the trunk was removed.
     * The original decays any leaf more than four steps from a log, walking that
     * distance through the tree rather than measuring it as a straight line.
     */
    const { World: W } = await load('world/world.js');
    const { TerrainGenerator: TG } = await load('worldgen/terrain.js');
    const { blockByName: byName } = await load('world/blocks.js');
    const log = byName('oak_log')?.id ?? 0;
    const leaf = byName('oak_leaves')?.id ?? 0;
    const stone = byName('stone')?.id ?? 0;

    const buildTree = (w, ox, oy, oz) => {
      for (let y = 0; y < 4; y++) w.setBlock(ox, oy + y, oz, log);
      for (let dy = 3; dy <= 5; dy++) {
        const r = dy === 5 ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dz === 0 && dy < 5) continue;
            if (Math.abs(dx) === r && Math.abs(dz) === r && r === 2) continue;
            w.setBlock(ox + dx, oy + dy, oz + dz, leaf);
          }
        }
      }
    };

    const mk = () => {
      const w = new W(3, new TG(21));
      const c = w.createChunk(0, 0);
      new TG(21).generateChunk(c);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          for (let y = 0; y < 128; y++) w.setBlock(x, y, z, 0);
          w.setBlock(x, 60, z, stone);
        }
      }
      w.light.initialLight(c);
      return w;
    };

    const countLeaves = (w) => {
      let n = 0;
      for (let y = 58; y < 80; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) if (w.getBlockAt(x, y, z) === leaf) n++;
        }
      }
      return n;
    };

    {
      const w = mk();
      buildTree(w, 8, 61, 8);
      const before = countLeaves(w);
      w.setBlock(2, 62, 2, 0); // an unrelated break
      const after = countLeaves(w);
      info(`standing tree: ${before} leaves, ${after} after an unrelated break`);
      check('a standing tree keeps its leaves', before > 20 && after === before, `${before} -> ${after}`);
    }

    {
      const w = mk();
      buildTree(w, 8, 61, 8);
      const before = countLeaves(w);
      for (let y = 61; y < 65; y++) w.setBlock(8, y, 8, 0);
      const after = countLeaves(w);
      info(`trunk removed: ${before} leaves -> ${after}`);
      check('leaves decay once the trunk is gone', before > 20 && after === 0, `${before} -> ${after}`);
    }

    {
      const w = mk();
      buildTree(w, 8, 61, 8);
      const before = countLeaves(w);
      w.setBlock(8, 64, 8, 0); // only the top log
      const after = countLeaves(w);
      info(`one log of four removed: ${before} -> ${after}`);
      check('removing one log does not strip the canopy', after > before * 0.5, `${before} -> ${after}`);
    }
  }

  console.log(`trees: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
