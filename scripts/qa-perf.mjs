// Frame-cost profiler.
//
// Reported from play: ~24 FPS at render distance 10 with ~1M triangles on screen.
// Before changing anything, measure what the frame is actually made of, so the
// work goes where the cost is instead of where it is comfortable to look.
//
// Everything here is a plain object-graph or typed-array fact, so it needs no
// GPU: vertex bytes, index bytes, draw calls after a real frustum test, triangles
// submitted, and the wall-clock cost of generating and meshing a chunk.

export async function run(load) {
  const THREE = await import('three');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { CHUNK_X, CHUNK_Z, CHUNK_Y } = await load('world/chunk.js');

  // Real sky material, so the overdraw report cannot describe a state that no
  // longer exists.
  let sky = null;
  try {
    const { Sky } = await load('render/sky.js');
    sky = new Sky(new THREE.Scene());
  } catch (e) {
    sky = null;
  }

  const info = (m) => console.log(`  . ${m}`);
  const section = (m) => console.log(`\n  --- ${m} ---`);

  const RD = Number(process.env.RD || 10);
  const seed = 20240910;
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);

  section(`world at render distance ${RD}`);

  // Generate the same footprint the streamer would.
  const R = RD + 2;
  const chunks = [];
  const t0 = Date.now();
  for (let cz = -R; cz <= R; cz++) {
    for (let cx = -R; cx <= R; cx++) {
      const c = world.createChunk(cx, cz);
      gen.generateChunk(c);
      chunks.push(c);
    }
  }
  const genMs = Date.now() - t0;
  info(`generated ${chunks.length} chunks in ${genMs} ms (${(genMs / chunks.length).toFixed(2)} ms/chunk)`);

  const t1 = Date.now();
  for (const c of chunks) world.light.initialLight(c);
  const lightMs = Date.now() - t1;
  info(`lit ${chunks.length} chunks in ${lightMs} ms (${(lightMs / chunks.length).toFixed(2)} ms/chunk)`);

  const atlas = buildBlockAtlas();
  const mesher = new VoxelMesher(atlas);

  const t2 = Date.now();
  let faces = 0;
  const meshes = [];
  for (const c of chunks) {
    const res = mesher.build(world, c);
    faces += res.faceCount;
    const ox = c.cx * CHUNK_X;
    const oz = c.cz * CHUNK_Z;
    if (res.opaque) meshes.push({ data: res.opaque, ox, oz, water: false });
    if (res.transparent) meshes.push({ data: res.transparent, ox, oz, water: true });
  }
  const meshMs = Date.now() - t2;
  info(`meshed ${chunks.length} chunks in ${meshMs} ms (${(meshMs / chunks.length).toFixed(2)} ms/chunk), ${faces} faces`);

  /* ---------------- vertex and index bytes ---------------- */

  section('vertex bandwidth');
  let vTotal = 0;
  let iTotal = 0;
  let opaqueMeshes = 0;
  let waterMeshes = 0;
  const bytes = { positions: 0, uvs: 0, colors: 0, light: 0, indices: 0 };
  let maxVerts = 0;
  for (const m of meshes) {
    const d = m.data;
    const v = d.positions.length / 3;
    vTotal += v;
    iTotal += d.indices.length;
    bytes.positions += d.positions.byteLength;
    bytes.uvs += d.uvs.byteLength;
    bytes.colors += d.colors.byteLength;
    bytes.light += d.light.byteLength;
    bytes.indices += d.indices.byteLength;
    if (v > maxVerts) maxVerts = v;
    if (m.water) waterMeshes++;
    else opaqueMeshes++;
  }
  const vertBytes = bytes.positions + bytes.uvs + bytes.colors + bytes.light;
  const perVert = vertBytes / Math.max(1, vTotal);
  info(`meshes: ${opaqueMeshes} opaque + ${waterMeshes} water = ${meshes.length}`);
  info(`vertices ${vTotal.toLocaleString()}, indices ${iTotal.toLocaleString()} (${(iTotal / 3).toLocaleString()} triangles)`);
  info(`largest mesh: ${maxVerts.toLocaleString()} vertices (a Uint16 index buffer holds 65,535)`);
  info(`per vertex: positions ${(bytes.positions / vTotal).toFixed(1)}B, uvs ${(bytes.uvs / vTotal).toFixed(1)}B, colors ${(bytes.colors / vTotal).toFixed(1)}B, light ${(bytes.light / vTotal).toFixed(1)}B = ${perVert.toFixed(1)}B`);
  info(`index bytes per triangle: ${(bytes.indices / Math.max(1, iTotal / 3)).toFixed(1)}B`);
  const totalMB = (vertBytes + bytes.indices) / 1048576;
  info(`total geometry: ${totalMB.toFixed(1)} MB  (vertices ${(vertBytes / 1048576).toFixed(1)} MB, indices ${(bytes.indices / 1048576).toFixed(1)} MB)`);

  /* ---------------- what a frame actually submits ---------------- */

  section('one frame, after frustum culling');
  // Stand at the spawn looking along -Z, the way the game starts.
  const cx = 0;
  const cz = 0;
  const surface = gen.heightAt(cx, cz);
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, Math.max(400, RD * 16 * 2.4));
  cam.position.set(cx + 0.5, surface + 1.6, cz + 0.5);
  cam.rotation.order = 'YXZ';
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );

  let drawnMeshes = 0;
  let drawnTris = 0;
  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  for (const m of meshes) {
    const d = m.data;
    // a chunk mesh spans 16 x 128 x 16 at its origin
    box.min.set(m.ox, 0, m.oz);
    box.max.set(m.ox + CHUNK_X, CHUNK_Y, m.oz + CHUNK_Z);
    box.getBoundingSphere(sphere);
    if (!frustum.intersectsSphere(sphere)) continue;
    drawnMeshes++;
    drawnTris += d.indices.length / 3;
  }
  info(`draw calls: ${drawnMeshes} of ${meshes.length} meshes`);
  info(`triangles submitted: ${drawnTris.toLocaleString()} of ${(iTotal / 3).toLocaleString()}`);
  info(`vertex bytes submitted this frame: ${((drawnTris / Math.max(1, iTotal / 3)) * vertBytes / 1048576).toFixed(1)} MB`);

  /* ---------------- the overdraw question ---------------- */

  section('full-screen passes');
  info('clear: 1 full-screen fill');
  /*
   * Derived from the real sky material, not from memory.
   *
   * This line used to assert "drawn first with depthTest false -> one
   * full-screen fill of overdraw under all terrain". That was true once and
   * stayed in the report for many rounds after the dome became a proper skybox
   * with depthTest on and renderOrder 900 - so the profile described a cost that
   * no longer existed. A report that cannot go stale is the only kind worth
   * reading.
   */
  {
    const skyObj = sky && sky.dome ? sky.dome : null;
    const mat = skyObj ? skyObj.material : null;
    if (!mat) {
      info('sky dome: not constructed');
    } else {
      const dtest = mat.depthTest !== false;
      const order = skyObj.renderOrder ?? 0;
      info(
        `sky dome: depthTest ${dtest ? 'on' : 'OFF'}, renderOrder ${order}` +
          (dtest && order > 0
            ? ' -> drawn last behind terrain, only visible pixels are shaded'
            : ' -> covers the whole screen before terrain, one full-screen fill of overdraw'),
      );
    }
  }
  info('water: blended over terrain, no depth write');
  info(`terrain: ${drawnMeshes} draws`);

  /* ---------------- CPU cost of a draw call ---------------- */

  section('draw-call budget');
  const perDrawUs = 25;
  info(`at ~${perDrawUs}us of three.js CPU bookkeeping per draw call, ${drawnMeshes} draws cost ~${((drawnMeshes * perDrawUs) / 1000).toFixed(1)} ms/frame`);
  info(`60 FPS needs 16.7 ms total; 24 FPS means 41.7 ms`);

  console.log('\nperf: reported (no pass/fail - this is a measurement)');
}
