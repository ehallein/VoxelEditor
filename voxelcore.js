'use strict';
// Core sparse-voxel-octree (Laine-Karras layout) decode/encode logic
// for the PlayCanvas splat-transform .voxel.json / .voxel.bin format.
//
// Node word (uint32 LE):
//   topByte = word >>> 24
//   topByte === 0                    -> MIXED LEAF. low24 = index i into leafData pairs.
//                                        mask = leafData[2i] (lo,32b) | leafData[2i+1] (hi,32b) -> 64-bit
//                                        occupancy mask over the 4x4x4=64 voxels of this leaf block.
//                                        local bit index = lx + 4*ly + 16*lz  (lx,ly,lz in [0,3])
//   topByte === 0xFF && low24 === 0  -> SOLID LEAF (whole subtree solid). May occur at ANY depth
//                                        (collapsed solid subtree), not just at max depth.
//   otherwise                        -> INTERIOR NODE. topByte = 8-bit child mask (bit per octant,
//                                        oct = xBit | yBit<<1 | zBit<<2). low24 = firstChild: index of
//                                        the first present child in `nodes`; children are stored
//                                        contiguously in octant order:
//                                          childIdx = firstChild + popcount(childMask & ((1<<oct)-1))
//   A clear bit in an interior childMask means that octant is fully empty (no node stored).
//
// This encoding was verified empirically against a real terrain.voxel.{json,bin} pair:
//  - count(topByte===0) === numMixedLeaves (exact)
//  - count(topByte===0xFF && low24===0) === nodeCount - numInteriorNodes - numMixedLeaves (exact)
//  - count(otherwise) === numInteriorNodes (exact)
//  - BFS from node 0 visits exactly nodeCount nodes, max depth === treeDepth
//  - mixed leaves occur only at depth === treeDepth; solid leaves occur at depths 3..treeDepth
//  - occupancy histogram along Y (with this bit convention) is high at low Y and strictly zero
//    above ~3/16 of the grid height, consistent with a terrain scene (ground at gridBounds.min.y)

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

// ---- Node representation (plain JS objects) ----
// null                         -> empty
// {t:0}                        -> solid (t:0 = SOLID)
// {t:1, lo, hi}                -> mixed leaf (t:1 = LEAF), only at depth===treeDepth
// {t:2, c:[8 x node|null]}     -> interior (t:2 = INTERIOR)
const SOLID = 0, LEAF = 1, INTERIOR = 2;

function decodeTree(nodesU32, leafDataU32, treeDepth) {
  function decode(idx, depth) {
    const w = nodesU32[idx] >>> 0;
    const tb = w >>> 24;
    if (tb === 0) {
      const i = w & 0xFFFFFF;
      return { t: LEAF, lo: leafDataU32[2 * i] >>> 0, hi: leafDataU32[2 * i + 1] >>> 0 };
    }
    if (tb === 0xFF && (w & 0xFFFFFF) === 0) {
      return { t: SOLID };
    }
    const childMask = tb;
    const firstChild = w & 0xFFFFFF;
    const c = new Array(8).fill(null);
    let n = 0;
    for (let oct = 0; oct < 8; oct++) {
      if (childMask & (1 << oct)) {
        c[oct] = decode(firstChild + n, depth + 1);
        n++;
      }
    }
    return { t: INTERIOR, c };
  }
  if (nodesU32.length === 0) return null; // empty scene
  return decode(0, 0);
}

// Encode a tree back to {nodes: Uint32Array, leafData: Uint32Array, numInteriorNodes, numMixedLeaves}
// using a queue (BFS) build so each interior node's children land contiguously.
function encodeTree(root, treeDepth) {
  const nodes = [];
  const leafData = [];
  let numInteriorNodes = 0, numMixedLeaves = 0;

  if (root === null) {
    return { nodes: new Uint32Array(0), leafData: new Uint32Array(0), numInteriorNodes: 0, numMixedLeaves: 0 };
  }

  // queue of {idx, node, depth} — idx already reserved (placeholder pushed)
  nodes.push(0); // reserve slot 0 for root
  const queue = [{ idx: 0, node: root, depth: 0 }];
  let qi = 0;
  while (qi < queue.length) {
    const { idx, node, depth } = queue[qi++];
    if (node.t === SOLID) {
      nodes[idx] = 0xFF000000 >>> 0;
    } else if (node.t === LEAF) {
      const i = leafData.length / 2;
      leafData.push(node.lo >>> 0, node.hi >>> 0);
      nodes[idx] = i >>> 0; // top byte 0
      numMixedLeaves++;
    } else { // INTERIOR
      let childMask = 0;
      const present = [];
      for (let oct = 0; oct < 8; oct++) {
        if (node.c[oct] !== null) { childMask |= (1 << oct); present.push(node.c[oct]); }
      }
      const firstChild = nodes.length;
      for (let k = 0; k < present.length; k++) {
        const childIdx = nodes.length;
        nodes.push(0); // reserve
        queue.push({ idx: childIdx, node: present[k], depth: depth + 1 });
      }
      nodes[idx] = ((childMask << 24) >>> 0) | firstChild;
      numInteriorNodes++;
    }
  }
  return {
    nodes: Uint32Array.from(nodes),
    leafData: Uint32Array.from(leafData),
    numInteriorNodes, numMixedLeaves
  };
}

// bottom-up: collapse any interior node whose 8 children are all present and all 'solid'
// into a single solid node; null-out interior nodes with zero children (shouldn't normally
// occur, but keeps things safe after edits).
function compact(node) {
  if (node === null || node.t !== INTERIOR) return node;
  let allSolid = true, anyPresent = false;
  for (let oct = 0; oct < 8; oct++) {
    node.c[oct] = compact(node.c[oct]);
    if (node.c[oct] !== null) anyPresent = true;
    if (node.c[oct] === null || node.c[oct].t !== SOLID) allSolid = false;
  }
  if (!anyPresent) return null;
  if (allSolid) return { t: SOLID };
  return node;
}

// get/set a single voxel by BLOCK-space integer coordinates is awkward; instead operate
// directly in voxel coordinates (vx,vy,vz), each within [0, leafSize * 2^treeDepth).
function getVoxel(root, treeDepth, vx, vy, vz) {
  let node = root;
  let depth = 0;
  // walk down using bits of the BLOCK coordinate (vx>>2 etc.), MSB first
  let bx = vx >> 2, by = vy >> 2, bz = vz >> 2; // block coords (leafSize=4 assumed => >>2)
  while (depth < treeDepth) {
    if (node === null) return false;
    if (node.t === SOLID) return true;
    // node.t === INTERIOR
    const bit = treeDepth - 1 - depth;
    const oct = ((bx >> bit) & 1) | (((by >> bit) & 1) << 1) | (((bz >> bit) & 1) << 2);
    node = node.c[oct];
    depth++;
  }
  if (node === null) return false;
  if (node.t === SOLID) return true;
  // LEAF
  const lx = vx & 3, ly = vy & 3, lz = vz & 3;
  const bitIdx = lx + 4 * ly + 16 * lz;
  const word = bitIdx < 32 ? node.lo : node.hi;
  return ((word >>> (bitIdx & 31)) & 1) !== 0;
}

// Returns a mutation API bound to a mutable root holder so callers can do
//   const holder = {root};
//   setVoxel(holder, treeDepth, ...)
function setVoxel(holder, treeDepth, vx, vy, vz, solid) {
  const bx = vx >> 2, by = vy >> 2, bz = vz >> 2;
  const lx = vx & 3, ly = vy & 3, lz = vz & 3;
  const bitIdx = lx + 4 * ly + 16 * lz;

  function go(node, depth) {
    if (depth === treeDepth) {
      // must become / already is a LEAF (or SOLID/empty collapsing to LEAF for editing)
      let lo, hi;
      if (node === null) { lo = 0; hi = 0; }
      else if (node.t === SOLID) { lo = 0xFFFFFFFF >>> 0; hi = 0xFFFFFFFF >>> 0; }
      else { lo = node.lo; hi = node.hi; }
      if (bitIdx < 32) {
        if (solid) lo = (lo | (1 << bitIdx)) >>> 0; else lo = (lo & ~(1 << bitIdx)) >>> 0;
      } else {
        const b = bitIdx - 32;
        if (solid) hi = (hi | (1 << b)) >>> 0; else hi = (hi & ~(1 << b)) >>> 0;
      }
      if (lo === 0 && hi === 0) return null;
      if (lo === 0xFFFFFFFF && hi === 0xFFFFFFFF) return { t: SOLID };
      return { t: LEAF, lo, hi };
    }
    const bit = treeDepth - 1 - depth;
    const oct = ((bx >> bit) & 1) | (((by >> bit) & 1) << 1) | (((bz >> bit) & 1) << 2);
    let children;
    if (node === null) {
      children = new Array(8).fill(null);
    } else if (node.t === SOLID) {
      children = new Array(8);
      for (let i = 0; i < 8; i++) children[i] = { t: SOLID };
    } else {
      children = node.c.slice();
    }
    children[oct] = go(children[oct], depth + 1);
    let anyPresent = false, allSolid = true;
    for (let i = 0; i < 8; i++) {
      if (children[i] !== null) anyPresent = true;
      if (children[i] === null || children[i].t !== SOLID) allSolid = false;
    }
    if (!anyPresent) return null;
    if (allSolid) return { t: SOLID };
    return { t: INTERIOR, c: children };
  }
  holder.root = go(holder.root, 0);
}

module.exports = { decodeTree, encodeTree, compact, getVoxel, setVoxel, popcount, SOLID, LEAF, INTERIOR };
