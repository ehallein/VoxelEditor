'use strict';
const fs = require('fs');
const { decodeTree, getVoxel, SOLID, LEAF, INTERIOR } = require('./voxelcore.js');

const meta = JSON.parse(fs.readFileSync('terrain_voxel.json', 'utf8'));
const buf = fs.readFileSync('terrain_voxel.bin');
const nodeCount = meta.nodeCount, leafDataCount = meta.leafDataCount;
const treeDepth = meta.treeDepth, leafSize = meta.leafSize;
const all = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const nodesU32 = all.subarray(0, nodeCount);
const leafDataU32 = all.subarray(nodeCount, nodeCount + leafDataCount);
const root = decodeTree(nodesU32, leafDataU32, treeDepth);

const gb = meta.gridBounds, res = meta.voxelResolution;
const nbx = Math.round((gb.max[0] - gb.min[0]) / (4 * res));
const nby = Math.round((gb.max[1] - gb.min[1]) / (4 * res));
const nbz = Math.round((gb.max[2] - gb.min[2]) / (4 * res));
const maxVX = nbx * leafSize, maxVY = nby * leafSize, maxVZ = nbz * leafSize;

function computeHeightMap(clipWorldY) {
  const hmax = new Int16Array(nbx * nbz).fill(-1);
  const clipVY = (clipWorldY !== null) ? Math.floor((clipWorldY - gb.min[1]) / res) : Infinity;
  function walk(node, depth, bx0, by0, bz0) {
    if (node === null) return;
    if (by0 * leafSize > clipVY) return;
    const sideBlocks = 1 << (treeDepth - depth);
    if (node.t === INTERIOR) {
      const half = sideBlocks >> 1;
      for (let oct = 0; oct < 8; oct++) {
        const c = node.c[oct]; if (!c) continue;
        const xb = oct & 1, yb = (oct >> 1) & 1, zb = (oct >> 2) & 1;
        walk(c, depth + 1, bx0 + xb * half, by0 + yb * half, bz0 + zb * half);
      }
      return;
    }
    if (bx0 >= nbx || bz0 >= nbz) return;
    if (node.t === SOLID) {
      const natTop = (by0 + sideBlocks) * leafSize - 1;
      const topVY = Math.min(natTop, clipVY);
      const x1 = Math.min(nbx, bx0 + sideBlocks), z1 = Math.min(nbz, bz0 + sideBlocks);
      for (let bx = bx0; bx < x1; bx++) for (let bz = bz0; bz < z1; bz++) {
        const idx = bx * nbz + bz;
        if (topVY > hmax[idx]) hmax[idx] = topVY;
      }
    } else {
      let best = -1;
      for (let ly = 3; ly >= 0 && best < 0; ly--) {
        const vy = by0 * leafSize + ly;
        if (vy > clipVY) continue;
        for (let lz = 0; lz < 4 && best < 0; lz++) {
          for (let lx = 0; lx < 4; lx++) {
            const bit = lx + 4 * ly + 16 * lz;
            const word = bit < 32 ? node.lo : node.hi;
            if ((word >>> (bit & 31)) & 1) { best = vy; break; }
          }
        }
      }
      if (best >= 0) {
        const idx = bx0 * nbz + bz0;
        if (best > hmax[idx]) hmax[idx] = best;
      }
    }
  }
  walk(root, 0, 0, 0, 0);
  return hmax;
}

function bruteTop(bx, bz, clipVY) {
  const x0 = bx * leafSize, z0 = bz * leafSize;
  let best = -1;
  for (let y = Math.min(maxVY, clipVY + 1) - 1; y >= 0; y--) {
    let any = false;
    for (let dx = 0; dx < leafSize && !any; dx++) for (let dz = 0; dz < leafSize; dz++) {
      if (getVoxel(root, treeDepth, x0 + dx, y, z0 + dz)) { any = true; break; }
    }
    if (any) { best = y; break; }
  }
  return best;
}

console.log('=== unclipped: compare corrected traversal vs brute force on random columns ===');
const hmUnclipped = computeHeightMap(null);
let mism = 0, checked = 0;
for (let i = 0; i < 3000; i++) {
  const bx = Math.floor(Math.random() * nbx), bz = Math.floor(Math.random() * nbz);
  const fast = hmUnclipped[bx * nbz + bz];
  const brute = bruteTop(bx, bz, maxVY - 1);
  checked++;
  if (fast !== brute) { mism++; if (mism <= 5) console.log('mismatch at', bx, bz, 'fast=', fast, 'brute=', brute); }
}
console.log('checked', checked, 'mismatches', mism);

console.log('=== clipped: pick a clip mid-way, compare ===');
const clipY = gb.min[1] + (gb.max[1] - gb.min[1]) * 0.4;
const clipVY = Math.floor((clipY - gb.min[1]) / res);
const hmClipped = computeHeightMap(clipY);
let mism2 = 0, checked2 = 0, clippedSomewhere = 0;
for (let i = 0; i < 3000; i++) {
  const bx = Math.floor(Math.random() * nbx), bz = Math.floor(Math.random() * nbz);
  const fast = hmClipped[bx * nbz + bz];
  const brute = bruteTop(bx, bz, clipVY);
  checked2++;
  if (fast !== hmUnclipped[bx*nbz+bz]) clippedSomewhere++;
  if (fast !== brute) { mism2++; if (mism2 <= 5) console.log('mismatch at', bx, bz, 'fast=', fast, 'brute=', brute); }
}
console.log('clip world Y =', clipY.toFixed(2), 'clipVY=', clipVY);
console.log('checked', checked2, 'mismatches', mism2, 'columns actually altered by clip (sampled)', clippedSomewhere);
