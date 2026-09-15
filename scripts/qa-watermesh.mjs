// Does a water block actually become a rendered mesh?
//
// Reported from play: swimming in water, F3 says the targeted block is sand (the
// raycast skipping liquid is correct), but the water surface is invisible. So the
// block is in the world and the mesher is never the suspect - the question is
// whether the mesh reaches the scene, with the right material, and visible.
//
// This drives the real ChunkManager against a real World and inspects the scene
// graph it produces. No GPU involved: a mesh that is missing, empty, transparent
// or pointed at the wrong material is a plain object-graph fact.

export async function run(load) {
  const THREE = await import('three');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { ChunkManager } = await load('world/chunkmanager.js');
  const { blockByName } = await load('world/blocks.js');
  const { SEA_LEVEL } = await load('world/chunk.js');
  const { createAtlasTexture, createTerrainMaterial, createTerrainUniforms } = await load('render/materials.js');

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

  const idOf = (n) => blockByName(n)?.id ?? 0;
  const water = idOf('water');

  const gen = new TerrainGenerator(21);
  const world = new World(21, gen);
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const c = world.createChunk(cx, cz);
      gen.generateChunk(c);
      // carve a sea into every column of these chunks
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const wx = cx * 16 + x;
          const wz = cz * 16 + z;
          for (let y = SEA_LEVEL; y < 110; y++) world.setBlock(wx, y, wz, 0, true);
          for (let y = SEA_LEVEL - 5; y <= SEA_LEVEL - 1; y++) world.setBlock(wx, y, wz, water, true);
        }
      }
    }
  }
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const c = world.getChunk(cx, cz);
      if (c) world.light.initialLight(c);
    }
  }

  // exactly the materials the Renderer builds
  const atlas = buildBlockAtlas();
  const uniforms = createTerrainUniforms(createAtlasTexture(atlas));
  uniforms.uAlphaTest.value = 0.5;
  const waterUniforms = { ...uniforms, uAlphaTest: { value: 0.02 } };
  const opaqueMat = createTerrainMaterial(uniforms, { transparent: false });
  const waterMat = createTerrainMaterial(waterUniforms, { transparent: true, water: true });

  info(`opaque material: ${opaqueMat.name}, transparent=${opaqueMat.transparent}, uAlphaTest=${uniforms.uAlphaTest.value}`);
  info(`water  material: ${waterMat.name}, transparent=${waterMat.transparent}, uAlphaTest=${waterUniforms.uAlphaTest.value}`);
  check('the water material is the transparent one', waterMat.transparent === true);
  check('the water material does not share the opaque alpha test', waterUniforms.uAlphaTest !== uniforms.uAlphaTest);

  const mesher = new VoxelMesher(atlas);
  const cm = new ChunkManager(world, mesher, opaqueMat, waterMat);
  cm.setCentre(0, 0);
  cm.enabled = true;
  const state = { radius: 3, pass: 0, index: 0 };
  // drive the streamer until it settles
  for (let i = 0; i < 4000; i++) {
    const rem = cm.preloadStep(state, 8);
    if (rem <= 0) break;
  }

  let transparentMeshes = 0;
  let transparentTris = 0;
  let invisibleTransparent = 0;
  let wrongMaterial = 0;
  let emptyTransparent = 0;
  let opaqueMeshes = 0;

  cm.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const idx = g.getIndex();
    const tris = idx ? idx.count / 3 : 0;
    const isWater = o.material === waterMat;
    if (o.material === opaqueMat) opaqueMeshes++;
    if (!isWater) return;
    transparentMeshes++;
    transparentTris += tris;
    if (o.visible !== true) invisibleTransparent++;
    if (o.material !== waterMat) wrongMaterial++;
    if (tris === 0) emptyTransparent++;
  });

  info(`chunk meshes: ${opaqueMeshes} opaque, ${transparentMeshes} water (${transparentTris} triangles)`);
  if (invisibleTransparent) info(`${invisibleTransparent} water meshes are not visible`);
  if (emptyTransparent) info(`${emptyTransparent} water meshes have no triangles`);
  if (wrongMaterial) info(`${wrongMaterial} water meshes use the wrong material`);

  check('water produces meshes at all', transparentMeshes > 0, String(transparentMeshes));
  check('water meshes contain triangles', transparentTris > 500, String(transparentTris));
  check('no water mesh is hidden', invisibleTransparent === 0, String(invisibleTransparent));
  check('no water mesh is empty', emptyTransparent === 0, String(emptyTransparent));

  // are the water meshes actually inside the scene group, and is the group in a scene?
  const inGroup = cm.group.children.length;
  info(`chunk group holds ${inGroup} children`);
  check('the chunk group carries the water meshes', inGroup >= transparentMeshes, `${inGroup} vs ${transparentMeshes}`);

  // the material the water meshes use must still be the live one after any swap
  cm.setMaterials(opaqueMat, waterMat);
  let stillWater = 0;
  cm.group.traverse((o) => {
    if (o.isMesh && o.material === waterMat) stillWater++;
  });
  check('water meshes survive a material swap', stillWater === transparentMeshes, `${stillWater} vs ${transparentMeshes}`);

  // and one representative water mesh: material flags the GPU actually uses
  let sample = null;
  cm.group.traverse((o) => {
    if (!sample && o.isMesh && o.material === waterMat) sample = o;
  });
  if (sample) {
    const m = sample.material;
    const g = sample.geometry;
    info(
      `sample water mesh: ${g.getIndex()?.count ?? 0} indices, material transparent=${m.transparent} depthWrite=${m.depthWrite} depthTest=${m.depthTest} side=${m.side} alphaTest=${m.alphaTest} visible=${sample.visible}`,
    );
    check('sample water mesh has geometry', (g.getIndex()?.count ?? 0) > 0);
    check('sample water mesh is visible', sample.visible === true);
    check('sample water material writes no depth', m.depthWrite === false);
    check('sample water material keeps depth testing', m.depthTest === true);
    check('sample water material blends', m.transparent === true);
  } else {
    check('found a sample water mesh', false);
  }

  console.log(`watermesh: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  void THREE;
}
