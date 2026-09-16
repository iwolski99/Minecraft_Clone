// GLSL static lint.
//
// A shader that *uses* a uniform it never *declares* is a compile error: the
// program fails to link and three.js draws nothing for that material, silently.
// That is exactly how the water and glass panes disappeared - a `uAlphaTest`
// reference added to WATER_FRAG without the matching declaration. Nothing in the
// suite compiled a shader, and the existing uniform check only walked uniforms
// that were already declared, so it could not see a missing one.
//
// This walks the shader sources directly and asserts the contract both ways.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './compile.mjs';

export async function run() {
  const file = path.join(ROOT, 'src', 'render', 'materials.ts');
  const src = fs.readFileSync(file, 'utf8');

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

  const blocks = [...src.matchAll(/const\s+(\w+)\s*=\s*\/\* glsl \*\/\s*`([\s\S]*?)`;/g)];
  check('shader sources found', blocks.length >= 4, `${blocks.length} blocks`);
  info(`linting ${blocks.length} shader sources`);

  const shaders = new Map();
  for (const [, name, body] of blocks) shaders.set(name, body);

  const BUILTIN = new Set([
    'uv', 'uv1', 'uv2', 'position', 'normal', 'color', 'modelMatrix', 'modelViewMatrix',
    'projectionMatrix', 'viewMatrix', 'normalMatrix', 'cameraPosition', 'isOrthographic',
    'instanceMatrix', 'logDepthBufFC',
  ]);

  const undeclaredUses = [];
  const declaredNotUsed = [];
  const varyingProblems = [];

  for (const [name, body] of shaders) {
    const declaredUniforms = new Set([...body.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]));
    // every uXxx identifier that appears in code (not inside a comment)
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const used = new Set([...code.matchAll(/\bu[A-Z]\w*\b/g)].map((m) => m[0]));

    for (const u of used) {
      if (BUILTIN.has(u)) continue;
      if (!declaredUniforms.has(u)) undeclaredUses.push(`${name}: uses ${u} without declaring it`);
    }
    for (const d of declaredUniforms) {
      // a uniform that is declared and never referenced is dead weight, not a bug
      if (!used.has(d)) declaredNotUsed.push(`${name}: ${d}`);
    }

    // varyings must match between the vertex and fragment stage of the same pair
    const declaredVaryings = new Set([...body.matchAll(/^\s*varying\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]));
    for (const v of declaredVaryings) {
      if (!new RegExp(`\\b${v}\\b`).test(code)) varyingProblems.push(`${name}: varying ${v} never used`);
    }
  }

  if (undeclaredUses.length) info(`undeclared uniform references: ${undeclaredUses.join(' | ')}`);
  if (declaredNotUsed.length) info(`declared but unused (dead weight only): ${declaredNotUsed.join(', ')}`);

  check('no shader uses an undeclared uniform', undeclaredUses.length === 0, undeclaredUses.slice(0, 6).join(' | '));
  check('no shader declares an unused varying', varyingProblems.length === 0, varyingProblems.slice(0, 6).join(' | '));

  // paired stages must agree on every varying they share
  const pairs = [
    ['TERRAIN_VERT', 'TERRAIN_FRAG'],
    ['WATER_VERT', 'WATER_FRAG'],
    ['SKY_VERT', 'SKY_FRAG'],
    ['CLOUD_VERT', 'CLOUD_FRAG'],
  ];
  const varyingOf = (n) =>
    new Set([...(shaders.get(n) ?? '').matchAll(/^\s*varying\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]));
  const mismatched = [];
  for (const [vert, frag] of pairs) {
    if (!shaders.has(vert) || !shaders.has(frag)) continue;
    const v = varyingOf(vert);
    const f = varyingOf(frag);
    // A vertex varying the fragment never reads is legal (the value is simply
    // interpolated and dropped). The reverse is a compile error in the fragment
    // stage, so only that direction is asserted.
    for (const name of f) if (!v.has(name)) mismatched.push(`${frag} reads ${name}, ${vert} does not declare it`);
  }
  check('every varying a fragment stage reads is declared by its vertex stage', mismatched.length === 0, mismatched.slice(0, 6).join(' | '));

  // the two terrain stages must declare the same uniform set, or one of them
  // will reference something the compiler cannot resolve
  const uni = (n) => new Set([...(shaders.get(n) ?? '').matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]));
  const terrainV = uni('TERRAIN_VERT');
  const waterV = uni('WATER_VERT');
  const terrainF = uni('TERRAIN_FRAG');
  const waterF = uni('WATER_FRAG');
  info(`TERRAIN_FRAG uniforms: ${[...terrainF].sort().join(', ')}`);
  info(`WATER_FRAG uniforms  : ${[...waterF].sort().join(', ')}`);
  check('WATER_FRAG declares uAlphaTest', waterF.has('uAlphaTest'));
  check('TERRAIN_FRAG declares uAlphaTest', terrainF.has('uAlphaTest'));
  // uTime is only required where it is actually referenced; the terrain vertex
  // stage has no animation and legitimately omits it.
  const usesTime = (n) => /\buTime\b/.test((shaders.get(n) ?? '').replace(/\/\*[\s\S]*?\*\//g, ''));
  for (const stage of ['TERRAIN_VERT', 'WATER_VERT', 'TERRAIN_FRAG', 'WATER_FRAG']) {
    if (usesTime(stage)) check(`${stage} declares uTime because it uses it`, uni(stage).has('uTime'));
  }

  /*
   * Argument types of calls to user-defined shader functions.
   *
   * GLSL has no implicit conversion between vector sizes, so passing a vec3 to a
   * function declared `float f(vec2)` is a compile error - and a failing shader
   * fails *silently* at runtime: three.js logs to the browser console, which
   * nothing here can see, and draws nothing for that material. That is exactly
   * how the night sky lost every star: four calls to hash(starCell + 1.7) where
   * starCell is a vec3. Nothing in the suite compiled a shader, so the whole sky
   * quietly became the clear colour and looked like a starless night.
   */
  const typeErrors = [];
  for (const [name, body] of shaders) {
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const vars = new Map();
    for (const m of code.matchAll(/\b(vec[234])\s+(\w+)\s*[=;,)]/g)) vars.set(m[2], m[1]);
    const funcs = new Map();
    for (const m of code.matchAll(/\b(?:float|vec[234]|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
      funcs.set(
        m[1],
        m[2].split(',').map((p) => (p.match(/\b(vec[234])\b/) ?? [])[1] ?? null),
      );
    }
    for (const [fname, params] of funcs) {
      if (params.every((p) => p === null)) continue;
      const callRe = new RegExp(`\\b${fname}\\s*\\(([^()]*)\\)`, 'g');
      for (const call of code.matchAll(callRe)) {
        call[1].split(',').forEach((arg, i) => {
          const want = params[i];
          if (!want) return;
          // A bare identifier, optionally with a scalar offset, keeps its type.
          // One followed by `.` is being swizzled - `starCell.xy` is a vec2 even
          // though `starCell` is a vec3 - so member access clears the type
          // rather than reporting the variable's own.
          for (const m of arg.matchAll(/\b([A-Za-z_]\w*)\b(\.?)/g)) {
            const id = m[1];
            if (m[2] === '.') continue;
            const have = vars.get(id);
            if (have && have !== want) {
              typeErrors.push(`${name}: ${fname}() argument ${i + 1} takes ${want} but ${id} is ${have}`);
            }
          }
        });
      }
    }
  }
  if (typeErrors.length) info(`shader type errors: ${typeErrors.slice(0, 6).join(' | ')}`);
  check('shader calls pass arguments of the declared type', typeErrors.length === 0, `${typeErrors.length} bad call(s)`);

  /*
   * Aurora.
   *
   * The reference renderer draws the dome as flat colour and never runs this
   * fragment shader, so the aurora cannot be seen in a headless render - the
   * same limit that hid the stars. What can be checked is the two things most
   * likely to be wrong: that it cannot appear during the day, and that the band
   * occupies a sensible range of elevation rather than washing the whole sky.
   */
  {
    const sky = shaders.get('SKY_FRAG') ?? '';
    const auroraStart = sky.indexOf('Aurora.');
    check('the sky shader contains an aurora', auroraStart >= 0);
    if (auroraStart >= 0) {
      const body = sky.slice(auroraStart);
      const end = body.indexOf('square sun and moon');
      const aurora = end > 0 ? body.slice(0, end) : body;
      /*
       * Night gating. uStarAmount is the night factor: 0 by day, 1 at night. If
       * either contribution to the colour omits it, the aurora would glow in
       * daylight - which is the failure a headless render would never show.
       */
      const contributions = [...aurora.matchAll(/col \+=([^;]*);/g)].map((m) => m[1]);
      info(`aurora colour contributions: ${contributions.length}`);
      check('the aurora adds colour somewhere', contributions.length > 0);
      const ungated = contributions.filter((c) => !c.includes('uStarAmount'));
      check('every aurora contribution is gated on night', ungated.length === 0, `${ungated.length} ungated`);

      /*
       * Band shape, evaluated from the same expression the shader uses. This
       * tests the maths, not the GLSL executing - it cannot catch a compile
       * error, which is what the type lint above is for.
       */
      const smoothstep = (a, b, x) => {
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      const bandAt = (el) => smoothstep(0.02, 0.2, el) * (1 - smoothstep(0.34, 0.72, el));
      const samples = [0, 0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.72, 0.9, 1.0].map((el) => ({ el, v: bandAt(el) }));
      info(`aurora band: ${samples.map((s) => `${s.el}:${s.v.toFixed(2)}`).join(' ')}`);
      check('the aurora is absent at and below the horizon', samples[0].v === 0 && samples[1].v === 0);
      check('the aurora peaks in the lower sky', bandAt(0.25) > 0.9, String(bandAt(0.25).toFixed(2)));
      check('the aurora fades out before overhead', bandAt(0.8) < 0.01, String(bandAt(0.8).toFixed(3)));
      check('the aurora never covers the zenith', bandAt(1.0) === 0);
    }
  }

  /*
   * Block scope.
   *
   * A variable declared inside an `if` and used after it is a compile error in
   * GLSL, and it takes the whole stage down: the fragment shader does not
   * compile, three.js draws nothing for that material, and the only trace is a
   * line in the browser console. That is how the sky silently became a flat
   * sheet - `vec3 dn` was declared inside the star block and the aurora further
   * down used it. The result was no gradient, no stars and a different colour by
   * day, reported as "the sky looks overcast", and it could not be found from
   * inside this repo at all.
   *
   * The check tracks brace depth. A use shallower than its declaration is
   * definitely out of scope. A use at the same depth in a *sibling* block is not
   * caught, which errs toward silence rather than false alarms.
   */
  const scopeErrors = [];
  for (const [name, body] of shaders) {
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    /*
     * Track block *identity*, not depth.
     *
     * Comparing depth alone cannot see this bug at all: the star block and the
     * aurora block are siblings at the same depth, so a declaration in one and a
     * use in the other look identical to a use in the same scope. A variable is
     * visible only if the chain of blocks it was declared in is a prefix of the
     * chain where it is used.
     */
    const declared = new Map(); // identifier -> array of enclosing block ids
    const stack = [];
    let nextBlock = 0;
    const tokenRe = /\{|\}|[A-Za-z_]\w*|\d+\.?\d*/g;
    const tokens = [];
    for (const m of code.matchAll(tokenRe)) tokens.push({ text: m[0] });
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].text;
      if (t === '{') {
        stack.push(nextBlock++);
        continue;
      }
      if (t === '}') {
        stack.pop();
        continue;
      }
      const isIdent = /^[A-Za-z_]\w*$/.test(t);
      const prev = tokens[i - 1]?.text;
      if (isIdent && /^(float|int|bool|vec[234]|mat[234]|sampler2D)$/.test(prev ?? '')) {
        declared.set(t, stack.slice());
        continue;
      }
      if (!isIdent) continue;
      const scope = declared.get(t);
      if (!scope) continue;
      // visible only when the declaration's block chain encloses the use
      const encloses = scope.length <= stack.length && scope.every((b, k) => stack[k] === b);
      if (!encloses) {
        scopeErrors.push(
          `${name}: ${t} is declared inside a block but used outside it`,
        );
      }
    }
  }
  if (scopeErrors.length) info(`shader scope errors: ${[...new Set(scopeErrors)].slice(0, 4).join(' | ')}`);
  check(
    'no shader uses a variable outside the block it was declared in',
    scopeErrors.length === 0,
    `${scopeErrors.length} out-of-scope use(s)`,
  );

  console.log(`shaders: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
