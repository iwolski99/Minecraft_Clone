/**
 * Captures three.js shader compile and link failures.
 *
 * A program that fails to compile does not throw. three.js writes the driver's
 * log to `console.error` and then draws *nothing* for that material, so the
 * symptom is always the same: something in the world silently is not there. That
 * has cost this project a lot of time - invisible water, invisible glass, a
 * missing sky, and a starless night were all this one failure mode, and every one
 * of them was found by looking at a screenshot rather than by a test.
 *
 * The reason no headless check caught them is that the log goes to the browser
 * console, and nothing here can read a browser console. So it is captured here
 * instead, at the one place every shader passes through, and surfaced in the F3
 * overlay where it can be read and reported.
 *
 * Install before the renderer creates any material. It only wraps `console.error`
 * and passes every call straight through, so nothing is hidden from the real
 * console - it is duplicated, not intercepted.
 */

export interface ShaderFault {
  /** the driver's message, trimmed */
  message: string;
  /** how many times a failing shader has been reported */
  count: number;
}

let installed = false;
let faults: ShaderFault[] = [];
let total = 0;

/** True for the messages three.js emits when a program fails. */
function looksLikeShaderFailure(args: unknown[]): boolean {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : ''))
    .join(' ');
  return (
    /THREE\.WebGLProgram/i.test(text) ||
    /shader(?:\s+\w+)?\s*(?:error|failed)/i.test(text) ||
    /could not (?:be )?compile/i.test(text) ||
    /VALIDATE_STATUS/i.test(text) ||
    /Program Info Log/i.test(text) ||
    /Shader Error/i.test(text)
  );
}

function describe(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a);
    else if (a instanceof Error) parts.push(a.message);
  }
  const text = parts.join('\n').replace(/\s+/g, ' ').trim();
  return text.length > 400 ? text.slice(0, 400) + '...' : text;
}

/** Wrap console.error so shader failures are recorded as well as logged. */
export function installShaderFaultCapture(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    if (!looksLikeShaderFailure(args)) return;
    total++;
    const message = describe(args) || 'shader failure (no message)';
    // keep the newest few, and count repeats of the same one
    const existing = faults.find((f) => f.message === message);
    if (existing) existing.count++;
    else faults.push({ message, count: 1 });
    if (faults.length > 4) faults = faults.slice(-4);
  };
}

/** How many shader failures have been seen, and the most recent messages. */
export function shaderFaults(): { total: number; faults: readonly ShaderFault[] } {
  return { total, faults };
}

/** One line for the F3 overlay. */
export function shaderFaultLine(): string {
  if (total === 0) return 'Shaders OK (no compile or link failures)';
  const first = faults[0];
  return `SHADER FAILURES ${total}: ${first ? first.message.slice(0, 120) : 'unknown'}`;
}

export function resetShaderFaults(): void {
  faults = [];
  total = 0;
}
