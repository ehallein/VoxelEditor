'use strict';
const fs = require('fs');
const { decodeTree, encodeTree, compact, getVoxel, setVoxel } = require('./voxelcore.js');

const meta = JSON.parse(fs.readFileSync('terrain_voxel.json', 'utf8'));
const buf = fs.readFileSync('terrain_voxel.bin');
const nodeCount = meta.nodeCount, leafDataCount = meta.leafDataCount;
const treeDepth = meta.treeDepth, leafSize = meta.leafSize;

const all = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const nodesU32 = all.subarray(0, nodeCount);
const leafDataU32 = all.subarray(nodeCount, nodeCount + leafDataCount);

console.log('=== decode ===');
const t0 = Date.now();
const root = decodeTree(nodesU32, leafDataU32, treeDepth);
console.log('decoded in', Date.now() - t0, 'ms');

console.log('=== re-encode (no edits) and compare stats ===');
const enc = encodeTree(root, treeDepth);
console.log('orig  nodeCount=%d numInteriorNodes=%d numMixedLeaves=%d leafDataCount=%d',
  meta.nodeCount, meta.numInteriorNodes, meta.numMixedLeaves, meta.leafDataCount);
console.log('reenc nodeCount=%d numInteriorNodes=%d numMixedLeaves=%d leafDataCount=%d',
  enc.nodes.length, enc.numInteriorNodes, enc.numMixedLeaves, enc.leafData.length);
const solidLeavesOrig = meta.nodeCount - meta.numInteriorNodes - meta.numMixedLeaves;
const solidLeavesReenc = enc.nodes.length - enc.numInteriorNodes - enc.numMixedLeaves;
console.log('solidLeaves orig=%d reenc=%d', solidLeavesOrig, solidLeavesReenc);

const statsOK = enc.nodes.length === meta.nodeCount &&
  enc.numInteriorNodes === meta.numInteriorNodes &&
  enc.numMixedLeaves === meta.numMixedLeaves &&
  enc.leafData.length === meta.leafDataCount;
console.log('STATS MATCH:', statsOK);

console.log('=== round-trip occupancy check (random samples) ===');
const root2 = decodeTree(enc.nodes, enc.leafData, treeDepth);
const NB = 1 << treeDepth;
const VOX = NB * leafSize;
// bias samples toward the actual populated region for a meaningful test
const gb = meta.gridBounds, res = meta.voxelResolution;
const nbx = Math.round((gb.max[0] - gb.min[0]) / (4 * res));
const nby = Math.round((gb.max[1] - gb.min[1]) / (4 * res));
const nbz = Math.round((gb.max[2] - gb.min[2]) / (4 * res));
const maxVX = nbx * leafSize, maxVY = nby * leafSize, maxVZ = nbz * leafSize;
console.log('grid voxel extents:', maxVX, maxVY, maxVZ, ' (cube', VOX, ')');

let mismatches = 0, solidCount = 0, N = 500000;
for (let i = 0; i < N; i++) {
  const vx = Math.floor(Math.random() * maxVX);
  const vy = Math.floor(Math.random() * maxVY);
  const vz = Math.floor(Math.random() * maxVZ);
  const a = getVoxel(root, treeDepth, vx, vy, vz);
  const b = getVoxel(root2, treeDepth, vx, vy, vz);
  if (a) solidCount++;
  if (a !== b) mismatches++;
}
console.log('samples=%d solid=%d mismatches=%d', N, solidCount, mismatches);

console.log('=== edit test: carve a hole then fill it back, verify ===');
const holder = { root: root2 };
// pick a solid voxel near the middle of the populated region to test on
let testVX=-1, testVY=-1, testVZ=-1;
for (let tries = 0; tries < 200000 && testVX < 0; tries++) {
  const vx = Math.floor(Math.random() * maxVX);
  const vy = Math.floor(Math.random() * maxVY);
  const vz = Math.floor(Math.random() * maxVZ);
  if (getVoxel(holder.root, treeDepth, vx, vy, vz)) { testVX=vx; testVY=vy; testVZ=vz; }
}
console.log('test voxel', testVX, testVY, testVZ, 'was solid:', getVoxel(holder.root, treeDepth, testVX, testVY, testVZ));
setVoxel(holder, treeDepth, testVX, testVY, testVZ, false);
console.log('after clear:', getVoxel(holder.root, treeDepth, testVX, testVY, testVZ));
setVoxel(holder, treeDepth, testVX, testVY, testVZ, true);
console.log('after re-set:', getVoxel(holder.root, treeDepth, testVX, testVY, testVZ));

// bulk edit: add a solid 20^3 cube somewhere empty, then verify all voxels solid, then remove it
console.log('=== bulk brush test (20^3 cube add+verify+remove) ===');
const bx0 = Math.floor(maxVX/2), by0 = maxVY + 10, bz0 = Math.floor(maxVZ/2); // above terrain -> likely empty
const S = 20;
const t1 = Date.now();
for (let x=0;x<S;x++) for (let y=0;y<S;y++) for (let z=0;z<S;z++) {
  setVoxel(holder, treeDepth, bx0+x, by0+y, bz0+z, true);
}
console.log('added', S*S*S, 'voxels in', Date.now()-t1, 'ms');
let allSolid = true;
for (let x=0;x<S;x++) for (let y=0;y<S;y++) for (let z=0;z<S;z++) {
  if (!getVoxel(holder.root, treeDepth, bx0+x, by0+y, bz0+z)) allSolid = false;
}
console.log('all solid after add:', allSolid);
for (let x=0;x<S;x++) for (let y=0;y<S;y++) for (let z=0;z<S;z++) {
  setVoxel(holder, treeDepth, bx0+x, by0+y, bz0+z, false);
}
let allEmpty = true;
for (let x=0;x<S;x++) for (let y=0;y<S;y++) for (let z=0;z<S;z++) {
  if (getVoxel(holder.root, treeDepth, bx0+x, by0+y, bz0+z)) allEmpty = false;
}
console.log('all empty after remove:', allEmpty);

console.log('=== compact() + re-encode after edits, verify occupancy stable ===');
const compacted = compact(holder.root);
const enc2 = encodeTree(compacted, treeDepth);
console.log('post-edit nodeCount=%d numInteriorNodes=%d numMixedLeaves=%d leafDataCount=%d',
  enc2.nodes.length, enc2.numInteriorNodes, enc2.numMixedLeaves, enc2.leafData.length);
const root3 = decodeTree(enc2.nodes, enc2.leafData, treeDepth);
let mism2 = 0;
for (let i = 0; i < N; i++) {
  const vx = Math.floor(Math.random() * maxVX);
  const vy = Math.floor(Math.random() * maxVY);
  const vz = Math.floor(Math.random() * maxVZ);
  const a = getVoxel(holder.root, treeDepth, vx, vy, vz);
  const b = getVoxel(root3, treeDepth, vx, vy, vz);
  if (a !== b) mism2++;
}
console.log('post-compact-reencode mismatches over', N, 'samples:', mism2);

console.log('\nALL RESULTS:');
console.log('stats match (clean round trip):', statsOK);
console.log('random sample mismatches (clean round trip):', mismatches);
console.log('post-edit compact+reencode mismatches:', mism2);
