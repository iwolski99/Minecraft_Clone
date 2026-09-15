// Mob model QA.
//
// Reported verbatim: "pigs, chickens, and cows spawn correctly, but I think it's
// sheep that spawn with a inverted clone of it self underneath it. Like it looks
// like some scary creature." The rig builders are pure data, so this suite walks
// every built rig and asserts the geometry-level contract that bug broke:
//
//   * the whole rig stands on y = 0 - no part hangs below the ground, which is
//     exactly where the sheep's stray fleece box was landing,
//   * no two body-sized parts float apart from each other (a duplicated body
//     shows up as a second torso-sized box separated in y),
//   * the rig holds exactly the parts its spec list declares,
//   * no geometry has a degenerate/inverted bounding box or a NaN vertex,
//   * every mesh shares the mob material, and every UV addresses a tile that is
//     really painted in the uploaded (row-flipped) mob atlas.

export async function run(load) {
  const THREE = await import('three');
  const { createMob, SPECS } = await load('entities/mobs.js');
  const models = await load('entities/models.js');
  const { Rng } = await load('util/rng.js');

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

  // Atlas layout (asserted below rather than trusted).
  const TILE = 16;
  const COLS = 4;
  const ROWS = 4;

  const meshesOf = (root) => {
    const out = [];
    root.traverse((o) => {
      if (o.isMesh) out.push(o);
    });
    return out;
  };
  const findPart = (root, name) => {
    let found = null;
    root.traverse((o) => {
      if (o.name === name) found = o;
    });
    return found;
  };
  const boxOf = (obj) => new THREE.Box3().setFromObject(obj);
  const fmt = (b) =>
    `[${b.min.x.toFixed(2)},${b.min.y.toFixed(2)},${b.min.z.toFixed(2)} .. ${b.max.x.toFixed(2)},${b.max.y.toFixed(2)},${b.max.z.toFixed(2)}]`;

  /** Is this 16x16 atlas tile painted? (payload is already row-flipped) */
  const tileIsPainted = (data, w, col, row) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (data[((row * TILE + y) * w + col * TILE + x) * 4 + 3] >= 250) return true;
      }
    }
    return false;
  };

  /* ------------------------------------------------------------------ */
  /* Build one rig per mob type through the real game path               */
  /* ------------------------------------------------------------------ */

  // Every rig's lowest point must be y = 0: a mob that dips below its origin
  // buries its feet (or its face) in the block it is standing on. There are no
  // exceptions - the spider's legs were shortened and its head raised so it
  // stands on the ground like everything else.
  const GROUND_Y = {};

  const rigs = [];
  for (const type of Object.keys(SPECS)) {
    const mob = createMob(type, 0, 0, 0, new Rng(1234));
    const root = mob.buildObject();
    root.updateMatrixWorld(true);
    const model = SPECS[type].model;
    rigs.push({
      type,
      root,
      material: root.userData.mobMaterial,
      atlas: models.mobAtlas(model, models.RIG_TILES[model]),
      grounded: true,
    });
  }
  // The arrow is a rig too, but it is a projectile: centred, not standing.
  {
    const built = models.buildMobRig('arrow');
    built.root.updateMatrixWorld(true);
    rigs.push({ type: 'arrow', root: built.root, material: built.material, atlas: built.atlas, grounded: false });
  }

  for (const { type, root, material, atlas, grounded } of rigs) {
    const meshes = meshesOf(root);
    const specs = models.mobPartSpecs(type);
    const whole = boxOf(root);
    info(`${type.padEnd(8)} ${String(meshes.length).padStart(2)} meshes, bbox ${fmt(whole)}`);

    /* ---- 1. the declared part list is what got built ---- */
    check(`${type}: a spec list exists`, Array.isArray(specs) && specs.length > 0);
    check(`${type}: mesh count matches the declared parts`, meshes.length === specs.length, `${meshes.length} meshes vs ${specs.length} specs`);
    const names = specs.map((s) => s.name);
    check(`${type}: part names are unique`, new Set(names).size === names.length, names.join(','));
    const missing = names.filter((n) => !findPart(root, n));
    check(`${type}: every declared part exists in the graph`, missing.length === 0, missing.join(','));

    /* ---- 2. it stands on the ground ---- */
    check(`${type}: bbox is finite`, whole.min.toArray().every(Number.isFinite) && whole.max.toArray().every(Number.isFinite), fmt(whole));
    if (grounded) {
      const groundY = GROUND_Y[type] ?? 0;
      check(`${type}: no part hangs below the ground`, whole.min.y >= groundY - 0.02, `min y ${whole.min.y.toFixed(3)} (expected ~${groundY})`);
      check(`${type}: the rig touches the ground`, whole.min.y <= groundY + 0.05, `min y ${whole.min.y.toFixed(3)} (expected ~${groundY})`);
      check(`${type}: rig is not absurdly large`, whole.max.y < 3 && whole.max.x < 2 && whole.max.z < 2, fmt(whole));
    } else {
      check(`${type}: projectile rig is centred on its origin`, Math.abs(whole.min.y + whole.max.y) < 0.05, fmt(whole));
    }

    /* ---- 3. no duplicated / detached body ---- */
    const parts = meshes.map((m) => ({ name: m.parent?.name ?? m.name, box: boxOf(m) }));
    const sizes = parts.map((p) => p.box.getSize(new THREE.Vector3()));
    const biggestFoot = Math.max(...sizes.map((s) => s.x * s.z));
    let duplicateBoxes = 0;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i];
        const b = parts[j];
        const sizeA = sizes[i];
        const sizeB = sizes[j];
        const sameBox =
          Math.abs(a.box.min.x - b.box.min.x) < 1e-6 && Math.abs(a.box.min.y - b.box.min.y) < 1e-6 && Math.abs(a.box.min.z - b.box.min.z) < 1e-6 &&
          Math.abs(a.box.max.x - b.box.max.x) < 1e-6 && Math.abs(a.box.max.y - b.box.max.y) < 1e-6 && Math.abs(a.box.max.z - b.box.max.z) < 1e-6;
        if (sameBox) {
          duplicateBoxes++;
          console.error(`  FAIL ${type}: ${a.name} and ${b.name} occupy the same volume ${fmt(a.box)}`);
        }
        // Torso-sized parts that share a footprint must be stacked, not
        // detached: a second body floating under the animal is the reported
        // sheep bug. "Torso-sized" is judged on footprint, so a stubby leg next
        // to a small torso (creeper, chicken) is not mistaken for a body.
        const footA = sizeA.x * sizeA.z;
        const footB = sizeB.x * sizeB.z;
        if (footA < biggestFoot * 0.4 || footB < biggestFoot * 0.4) continue;
        const shared =
          Math.max(0, Math.min(a.box.max.x, b.box.max.x) - Math.max(a.box.min.x, b.box.min.x)) *
          Math.max(0, Math.min(a.box.max.z, b.box.max.z) - Math.max(a.box.min.z, b.box.min.z));
        if (shared / Math.min(footA, footB) < 0.5) continue; // side by side, fine
        const gap = Math.max(a.box.min.y, b.box.min.y) - Math.min(a.box.max.y, b.box.max.y);
        check(`${type}: ${a.name} and ${b.name} are not a detached body`, gap <= 0.02, `gap ${gap.toFixed(3)} between ${fmt(a.box)} and ${fmt(b.box)}`);
      }
    }
    check(`${type}: no two parts are the same box`, duplicateBoxes === 0, `${duplicateBoxes} duplicate boxes`);

    /* ---- 4. sane geometry ---- */
    let geometryProblems = 0;
    for (const m of meshes) {
      const g = m.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const size = bb.getSize(new THREE.Vector3());
      const inverted = bb.min.x > bb.max.x || bb.min.y > bb.max.y || bb.min.z > bb.max.z;
      const degenerate = size.x < 1e-4 || size.y < 1e-4 || size.z < 1e-4;
      const finite = bb.min.toArray().every(Number.isFinite) && bb.max.toArray().every(Number.isFinite);
      let nan = 0;
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count * 3; i++) if (!Number.isFinite(pos.array[i])) nan++;
      if (inverted || degenerate || !finite || nan) {
        geometryProblems++;
        console.error(`  FAIL ${type}: ${m.parent?.name} geometry ${inverted ? 'inverted ' : ''}${degenerate ? 'degenerate ' : ''}${nan ? `${nan} NaN ` : ''}${fmt(bb)}`);
      }
      if (g.index && g.index.count % 3 !== 0) geometryProblems++;
    }
    check(`${type}: no degenerate or inverted geometry`, geometryProblems === 0, `${geometryProblems} bad geometries`);

    /* ---- 5. shared material + painted atlas texels ---- */
    check(`${type}: rig exposes a shared material`, !!material && material.isMaterial === true);
    let materialProblems = 0;
    for (const m of meshes) if (m.material !== material) materialProblems++;
    check(`${type}: every mesh uses the shared mob material`, materialProblems === 0, `${materialProblems} meshes with another material`);

    const texture = atlas.texture;
    const data = texture.image.data;
    const w = texture.image.width;
    check(
      `${type}: atlas is a 4x4 grid of 16px tiles`,
      w === COLS * TILE && texture.image.height === ROWS * TILE,
      `${w}x${texture.image.height}`,
    );
    const bySlot = new Map([...atlas.slots].map(([name, slot]) => [slot, name]));

    let uvProblems = 0;
    let uvSamples = 0;
    const slotsHit = new Set();
    for (const m of meshes) {
      const uv = m.geometry.attributes.uv;
      if (!uv) {
        uvProblems++;
        continue;
      }
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        uvSamples++;
        if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
          uvProblems++;
          continue;
        }
        // canvas convention: v = 1 is the top row (see Atlas.uvSlot/uvRect)
        const col = Math.min(COLS - 1, Math.floor(u * COLS));
        const row = Math.min(ROWS - 1, Math.floor((1 - v) * ROWS));
        const slot = row * COLS + col;
        slotsHit.add(slot);
        if (!bySlot.has(slot)) uvProblems++;
        // the payload is uploaded row-flipped, so canvas tile row r lives at ROWS-1-r
        else if (!tileIsPainted(data, w, col, ROWS - 1 - row)) uvProblems++;
      }
    }
    check(`${type}: every UV lands on a painted atlas tile`, uvProblems === 0, `${uvProblems} of ${uvSamples} vertices`);
    check(`${type}: the rig samples more than one tile`, slotsHit.size >= Math.min(2, atlas.slots.size), `${slotsHit.size} tiles`);

    // the upload must be row-flipped: painted tiles appear at mirrored tile rows
    const expected = new Set();
    for (const slot of atlas.slots.values()) expected.add((ROWS - 1 - Math.floor(slot / COLS)) * COLS + (slot % COLS));
    let painted = 0;
    let stray = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!tileIsPainted(data, w, col, row)) continue;
        painted++;
        if (!expected.has(row * COLS + col)) stray++;
      }
    }
    check(`${type}: uploaded atlas is row-flipped`, stray === 0 && painted === expected.size, `${painted} painted tiles, ${expected.size} expected, ${stray} stray`);
  }

  /* ---- the material is shared between instances of one type ---- */
  const sheepA = createMob('sheep', 0, 0, 0, new Rng(1));
  const sheepB = createMob('sheep', 3, 0, 0, new Rng(2));
  const rootA = sheepA.buildObject();
  const rootB = sheepB.buildObject();
  check(
    'instances of a mob type share one atlas + material',
    rootA.userData.mobMaterial === rootB.userData.mobMaterial && !!rootA.userData.mobMaterial,
  );

  /* ---- the sheep, specifically ---- */
  const sheepRoot = rigs.find((r) => r.type === 'sheep').root;
  // the box of the part itself, not of its pivot's whole subtree
  const meshBox = (name) => {
    const mesh = meshesOf(sheepRoot).find((m) => m.parent?.name === name);
    return mesh ? boxOf(mesh) : null;
  };
  const woolBox = meshBox('wool');
  const bodyBox = meshBox('body');
  check('sheep: has a body mesh and a fleece mesh', !!woolBox && !!bodyBox);
  if (woolBox && bodyBox) {
    const gap = Math.max(bodyBox.min.y, woolBox.min.y) - Math.min(bodyBox.max.y, woolBox.max.y);
    info(`sheep body ${fmt(bodyBox)}`);
    info(`sheep wool ${fmt(woolBox)}`);
    check('sheep: the fleece wraps the body', gap < 0, `gap ${gap.toFixed(3)}`);
    check(
      'sheep: the fleece is centred on the body',
      Math.abs((woolBox.min.y + woolBox.max.y) / 2 - (bodyBox.min.y + bodyBox.max.y) / 2) < 0.06,
      fmt(woolBox),
    );
  }

  console.log(`models: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
