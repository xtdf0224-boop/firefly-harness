// SPDX-License-Identifier: LGPL-3.0-only
// This file is a JavaScript port of src/edge_tts/drm.py from edge-tts by rany and the edge-tts contributors
// (https://github.com/rany2/edge-tts), which is licensed under the GNU LGPL v3. The port is by xtdf0224-boop and
// stays under the same licence; the rest of this project is MIT. See licenses/edge-tts-NOTICE.txt.
// It is plain JavaScript inside the app, so it can be replaced by another build of the same function.
//
// Sec-MS-GEC token for Microsoft's Edge read-aloud endpoint ("v2" format, "<16 hex>-<64 hex>").
// The service rejects the older plain-SHA256 token with HTTP 403. This is a literal port of
// generate_sec_ms_gec_v2 from the edge-tts project (rany2/edge-tts, edge_tts/drm.py, v7.3): a SHA-256
// variant with a pre-seeded first block plus a second "CS64" digest. BigInt keeps every step exact;
// the token is computed once per 5-minute window, so speed does not matter.
'use strict';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const M = 0xFFFFFFFFn;
const WIN_EPOCH = 11644473600;

const SHA256_INITIAL = [0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An, 0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n];
const SHA256_STATE = [0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An, 0x6C006F49n, 0x04BD35ABn, 0xFEB0A7E4n, 0x03EFFBD2n];
const SHA256_SCHEDULE = [
  0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0x0CFA32BAn, 0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n,
  0xF9E70AB6n, 0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0x00E5AB33n, 0xD258B060n, 0x72766564n,
];
const K = [
  0x428A2F98n, 0x71374491n, 0xB5C0FBCFn, 0xE9B5DBA5n, 0x3956C25Bn, 0x59F111F1n, 0x923F82A4n, 0xAB1C5ED5n,
  0xD807AA98n, 0x12835B01n, 0x243185BEn, 0x550C7DC3n, 0x72BE5D74n, 0x80DEB1FEn, 0x9BDC06A7n, 0xC19BF174n,
  0xE49B69C1n, 0xEFBE4786n, 0x0FC19DC6n, 0x240CA1CCn, 0x2DE92C6Fn, 0x4A7484AAn, 0x5CB0A9DCn, 0x76F988DAn,
  0x983E5152n, 0xA831C66Dn, 0xB00327C8n, 0xBF597FC7n, 0xC6E00BF3n, 0xD5A79147n, 0x06CA6351n, 0x14292967n,
  0x27B70A85n, 0x2E1B2138n, 0x4D2C6DFCn, 0x53380D13n, 0x650A7354n, 0x766A0ABBn, 0x81C2C92En, 0x92722C85n,
  0xA2BFE8A1n, 0xA81A664Bn, 0xC24B8B70n, 0xC76C51A3n, 0xD192E819n, 0xD6990624n, 0xF40E3585n, 0x106AA070n,
  0x19A4C116n, 0x1E376C08n, 0x2748774Cn, 0x34B0BCB5n, 0x391C0CB3n, 0x4ED8AA4An, 0x5B9CCA4Fn, 0x682E6FF3n,
  0x748F82EEn, 0x78A5636Fn, 0x84C87814n, 0x8CC70208n, 0x90BEFFFAn, 0xA4506CEBn, 0xBEF9A3F7n, 0xC67178F2n,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7n;
// Round constants for the pre-seeded block: constant 14 is replaced.
const K_BLOCK = K.map((v, i) => (i === 14 ? SHA256_ADJUSTMENT : v));
const SIGMA0_ADJUSTMENT = 0x059C0B80n;
const SIGMA1_ADJUSTMENT = 0x000B92C0n;

const CS64_COEFFICIENTS = [
  [0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn], [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn],
  [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn], [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn],
  [0x06064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n], [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n],
  [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xF2F90B1An;
const CS64_ADJUSTMENT1 = 0x0B1A0000n;

const rol16 = (v) => { v &= M; return ((v << 16n) | (v >> 16n)) & M; };
const ror = (x, n) => ((x >> n) | (x << (32n - n))) & M;
const sigma0 = (v) => (ror(v, 7n) ^ ror(v, 18n) ^ (v >> 3n)) & M;
const sigma1 = (v) => (ror(v, 17n) ^ ror(v, 19n) ^ (v >> 10n)) & M;
const mod = (a, n) => ((a % n) + n) % n;

/** Little-endian 32-bit words, zero-padded to an even count. */
function wordsLe4Even(buf) {
  const padded = Buffer.concat([buf, Buffer.alloc(mod(-buf.length, 4))]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(BigInt(padded.readUInt32LE(i)));
  if (words.length % 2) words.push(0n);
  return words;
}

/** SHA-256 compression rounds from `first` to 63 over a 64-word schedule. */
function rounds(state, words, first = 0) {
  const k = first === 14 ? K_BLOCK : K;
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = (h + (ror(e, 6n) ^ ror(e, 11n) ^ ror(e, 25n)) + (g ^ (e & (f ^ g))) + k[i] + words[i]) & M;
    const t2 = ((ror(a, 2n) ^ ror(a, 13n) ^ ror(a, 22n)) + ((a & b) | (c & (a | b)))) & M;
    h = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, from = 16) {
  for (let i = from; i < 64; i++) {
    words.push((sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) & M);
  }
}

/** Initial state derived from the first seven bytes of the token data. */
function sha256Init(head) {
  const words = new Array(14).fill(0n);
  words.push(BigInt(head.readUIntBE(0, 3)));
  words.push(BigInt(head.readUInt32BE(3)));
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) value += index === 16 ? (sigma1(words[index - 2]) ^ SIGMA1_ADJUSTMENT) : sigma1(words[index - 2]);
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) value += index === 29 ? (sigma0(words[index - 15]) ^ SIGMA0_ADJUSTMENT) : sigma0(words[index - 15]);
    words.push(value & M);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - K[14]) & M);
  expandSchedule(words, 31);
  const working = rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) & M);
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt too short');
  const length = 57 + data.length;
  const tail = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(mod(55 - length, 64))]);
  const bits = Buffer.alloc(8);
  bits.writeBigUInt64BE(BigInt(length) * 8n);
  const padded = Buffer.concat([tail, bits]);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(BigInt(padded.readUInt32BE(off + i * 4)));
    expandSchedule(words);
    const working = rounds(state, words);
    state = state.map((x, i) => (x + working[i]) & M);
  }
  const out = Buffer.alloc(32);
  state.forEach((v, i) => out.writeUInt32BE(Number(v), i * 4));
  return out;
}

function cs64Digest(data, digest) {
  let keyA = BigInt(digest.readUInt32LE(0)) | 1n;
  let keyB = BigInt(digest.readUInt32LE(4)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => (coef * factors[i % 2]) & M);
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (index % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & M);
    offsets.push(offset & M);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76F50F34n) & M;
    swapAcc += ((rol16(q) * 0xC3EFEA97n) + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881CE3Cn) & M;
    swapLast = ((rol16(q) * 0x35BD1EC9n) + q) & M;
    swapAcc = (swapAcc + swapLast) & M;

    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xCF98B111n) & M;
    state = (rol16(state) * 0x87085B9Fn) & M;
    state = (rol16(state) * 0x12CEB96Dn) & M;
    state = (rol16(state) * 0x257E1D83n) & M;
    acc += state;
    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xA27416F5n) & M;
    t = (rol16(t) * 0xD38396FFn) & M;
    state = (rol16((rol16(t) * 0x7C932B89n) & M) * 0xBFA49F69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

/** Sec-MS-GEC value for a unix time in seconds (default: now). Valid for a 5-minute window. */
function secMsGec(unixSeconds = Date.now() / 1000) {
  let ticks = Math.floor(unixSeconds) + WIN_EPOCH;
  ticks -= ticks % 300;
  const data = Buffer.from(`${BigInt(ticks) * 10000000n}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = sha256Digest(data);
  const [lo, hi] = cs64Digest(data, digest);
  const cs = Buffer.alloc(8);
  cs.writeUInt32LE(Number(lo), 0);
  cs.writeUInt32LE(Number(hi), 4);
  return `${cs.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

module.exports = { secMsGec, TRUSTED_CLIENT_TOKEN };
