// Tiny stack VM for make.fun tiny-stack-vm-01-run-20261122. Follows the kit
// ISA exactly as the reference VM does (wrapping 32-bit math, unsigned ops,
// DIV/MOD edges, 5-bit shifts, PUSH8 sign extension, all ten traps).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Decode tables: immediate length, values popped, values pushed per opcode.
// KNOWN marks real opcodes; anything else traps 5.
const IMM = new Uint8Array(256), POPN = new Uint8Array(256), PUSHN = new Uint8Array(256), KNOWN = new Uint8Array(256);
for (const [o, i, p, u] of [
  [0, 0, 0, 0], [1, 1, 0, 1], [2, 4, 0, 1], [3, 0, 1, 0], [4, 0, 1, 2],
  [5, 0, 2, 2], [6, 0, 2, 3], [7, 0, 3, 3], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1], [0x53, 0, 1, 0],
]) { IMM[o] = i; POPN[o] = p; PUSHN[o] = u; KNOWN[o] = 1; }
// Binary ops 0x10-0x22 (0x1f is no opcode): pop 2 push 1, except NEG/NOT.
for (let o = 0x10; o <= 0x22; o++) {
  if (o === 0x1f) continue;
  POPN[o] = o === 0x17 || o === 0x1b ? 1 : 2;
  PUSHN[o] = 1;
  KNOWN[o] = 1;
}

const DIG = new Uint8Array(12); // decimal digits, least first
// Appends decimal v to out at ol; new length, or -1 past the 65,536 limit.
function putNum(out, ol, v) {
  let x = v, neg = false;
  if (x < 0) { neg = true; x = -x; }
  let d = 0;
  do { DIG[d++] = 48 + (x % 10); x = Math.floor(x / 10); } while (x > 0);
  const len = d + (neg ? 1 : 0);
  if (ol + len > 65536) return -1;
  if (neg) out[ol++] = 45;
  while (d > 0) out[ol++] = DIG[--d];
  return ol;
}

// Runs one program; returns { out, code }.
function run(prog, input) {
  const n = prog.length, st = new Int32Array(256), cs = new Int32Array(64), mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code) => ({ out: out.subarray(0, ol), code });
  for (;;) {
    if (steps === 1000000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = prog[pc];
    if (!KNOWN[op]) return end(5);
    const im = IMM[op];
    if (pc + im >= n) return end(9);
    steps++;
    const nx = pc + 1 + im, po = POPN[op];
    if (sp < po) return end(2);
    if (sp - po + PUSHN[op] > 256) return end(3);
    pc = nx;
    switch (op) {
      case 0x00: return end(0);
      case 0x01: st[sp++] = (prog[nx - 1] << 24) >> 24; break;
      case 0x02: st[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24); break;
      case 0x03: sp--; break;
      case 0x04: st[sp] = st[sp - 1]; sp++; break;
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; }
      case 0x06: st[sp] = st[sp - 2]; sp++; break;
      case 0x07: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; }
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break;
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = st[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33:
        if (cp === 64) return end(7);
        cs[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return end(8);
        pc = cs[--cp];
        break;
      case 0x40: {
        const a = st[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: {
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a >= 256) return end(6);
        sp -= 2;
        mem[a] = v;
        break;
      }
      case 0x50: {
        const nl = putNum(out, ol, st[sp - 1]);
        if (nl < 0) return end(11);
        sp--;
        ol = nl;
        break;
      }
      case 0x51:
        if (ol + 1 > 65536) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: st[sp++] = ip < input.length ? input[ip++] : -1; break;
      case 0x53: return end(st[--sp] & 255);
      default: { // binary ops 0x10-0x16, 0x18-0x1a, 0x1c-0x1e, 0x20-0x22
        const b = st[sp - 1], a = st[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) {
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) {
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = a >>> 0 < (b >>> 0) ? 1 : 0;
        sp -= 2;
        st[sp++] = r;
      }
    }
  }
}

for (const id of readdirSync(IN_DIR).sort()) {
  const r = run(new Uint8Array(readFileSync(join(IN_DIR, id, 'program.bin'))), new Uint8Array(readFileSync(join(IN_DIR, id, 'input.bin'))));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), r.out);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), r.code + '\n');
}
