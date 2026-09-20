# Voxel Terrain Editor

A browser-based 3D editor for PlayCanvas `splat-transform` `.voxel.json` /
`.voxel.bin` files (sparse voxel octrees, Laine–Karras node layout). Built
because the format has no public read/write tooling — the codec here was
reverse-engineered and empirically verified against a real terrain file
(see "Format notes" below).

## Files in this folder

| File | What it is |
|---|---|
| `voxel_editor.html` | The whole app — single self-contained file (three.js via CDN, no build step). Open it in a browser, or keep it as a Claude.ai artifact. Also renders the source Gaussian-splat `.ply` on top of the voxels (`PART 6`). |
| `voxelcore.js` | The codec only (decode/encode/get/set/compact), as a standalone Node/CommonJS module. **This is a copy** of the same functions that are inlined in `voxel_editor.html` (`PART 1` in the file's own comments) — they need to be kept in sync by hand if you edit one. See "If you continue this in Claude Code" below for the obvious first fix. |
| `test_voxelcore.js` | Round-trip + edit correctness tests for the codec, run against a real `.voxel.json`/`.voxel.bin` pair. |
| `test_heightmap.js` | Correctness test for the minimap/overview height-scanning logic (brute-force per-voxel check vs. the tree-pruning traversal), clipped and unclipped. |

To run the tests, put a `terrain_voxel.json` + `terrain_voxel.bin` (or edit
the filenames in the scripts) next to them and run `node test_voxelcore.js`
/ `node test_heightmap.js`. Both were last run clean: 500,000 random-voxel
round-trip samples with 0 mismatches, edit/undo/compact round-trips
bit-identical, and 3,000-sample height-map checks (clipped and unclipped)
with 0 mismatches, on a real ~171k-node terrain file.

## Format notes (`.voxel.json` / `.voxel.bin` v1.1)

Official spec: https://developer.playcanvas.com/user-manual/splat-transform/voxel-format/
(the page documents the JSON header and the two-array binary layout, but is
light on the actual node bit-packing, which is what's reconstructed here).

`.voxel.bin` = two concatenated little-endian `uint32` arrays, `nodes` then
`leafData` (sizes from the JSON header: `nodeCount`, `leafDataCount`).

**Node word** (`nodes[i]`, uint32):
- `topByte = word >>> 24`
- `topByte === 0` → **mixed leaf**. `low24 = word & 0xFFFFFF` is an index `i`
  into `leafData` pairs: the node's 64-voxel occupancy mask is
  `leafData[2i]` (low 32 bits) | `leafData[2i+1]` (high 32 bits). Local bit
  index within the mask is `lx + 4*ly + 16*lz` (`lx,ly,lz` in `[0,3]`, x
  fastest). Mixed leaves only ever occur at `depth === treeDepth`.
- `topByte === 0xFF && low24 === 0` → **solid leaf** (the whole subtree is
  solid). Can occur at *any* depth — this is how a large uniform region
  collapses to one node instead of expanding all the way to individual
  4×4×4 leaf blocks. Confirmed by walking a real file: solid leaves showed
  up at depths 3 through 8 (`treeDepth`).
- anything else → **interior node**. `topByte` = 8-bit child mask, one bit
  per octant; `low24` = `firstChild`, the index of the *first present*
  child in `nodes`. Children are stored contiguously in ascending octant
  order: `childIdx = firstChild + popcount(childMask & ((1<<oct)-1))`. A
  clear bit means that octant is fully empty — no node is stored for it.
- **Octant bit convention**: `oct = xBit | (yBit<<1) | (zBit<<2)`, i.e. bit0
  = X half, bit1 = Y half, bit2 = Z half, tested from the root down (MSB of
  the block coordinate first). This matches the typical Laine–Karras/SVO
  convention and was sanity-checked (not just assumed) against the real
  data: decoding with this convention gives a Y-occupancy histogram that's
  concentrated near `gridBounds.min.y` and strictly zero above the
  populated region — consistent with a terrain/level scene, not scrambled.
  **This one is the part I'd re-verify first** if voxel positions ever look
  mirrored/rotated relative to the source scene in-engine — everything else
  here was checked against exact node-count/occupancy equality, this one
  was checked by plausibility of the resulting shape.

**How the codec round-trips it**: decode builds a plain JS tree
(`{t:SOLID}` / `{t:LEAF,lo,hi}` / `{t:INTERIOR,c:[8]}`, `null` = empty).
Encode is a **BFS over a queue**: pop a node, if it's interior reserve a
contiguous run of array slots for its present children *right then*
(pushing placeholders) and enqueue them — this is what guarantees a given
node's children land contiguously, which the format requires. `compact()`
walks bottom-up and collapses an interior node whose 8 children are all
present and all solid into one solid node (this is the "large uniform
region → one node" optimization; it doesn't have to run for the file to be
valid, only to keep it small). `setVoxel` is a persistent/immutable
edit — it rebuilds only the nodes on the path to the touched voxel and
reuses everything else by reference, which is what makes undo trivial (see
below).

## Editor architecture (`voxel_editor.html`)

Search for these comment headers in the file:

- **PART 1 — voxel octree codec.** Decode/encode/get/set/compact, as above.
- **PART 2 — ZIP writer.** Minimal store-only ZIP so both output files can
  go through the `downloads` capability's extension allowlist (which
  doesn't include `.bin`, but does include `.zip`).
- **PART 3 — app state + file loading.** `state` is the one global mutable
  object. `state.holder = {root}` is the live tree; `state.undoStack` /
  `redoStack` hold previous `root` references (cheap, thanks to the
  persistent edit above).
- **PART 4 — three.js scene, chunked mesher, camera.** The scene is too big
  to render at full voxel resolution everywhere, so it streams 16³-voxel
  chunks around a movable `state.focus` point (`streamChunks`, render
  radius adjustable). Each chunk builds a padded local occupancy array via
  `getV()` and emits only the faces that border empty space
  (`buildChunk`). `heightColor()` does the height→color gradient, shared by
  the chunk mesher, the minimap, and the overview mesh, and is normalized
  to `[gridBounds.min.y, heightClip]` so it renormalizes automatically when
  you clip.
- **`buildOverviewMesh()`/"Show entire model"** walks the whole tree once
  and draws one *unculled* box per leaf/solid node at its true size
  (reusing whatever compression the octree already has — a big solid
  region is already one node, so it's one box). It's a coarse stand-in for
  navigation, not for editing: clicking it jumps focus there and drops back
  into the detailed streamed view rather than trying to edit against a
  block that might represent thousands of real voxels.
- **`computeHeightMap()`** (minimap) and the overview mesher both do the
  same "prune subtrees whose Y-range starts above the clip, otherwise
  recurse/clamp" traversal — this is where the height-clip slider and the
  minimap's own clipping/color-renormalization are implemented. This is
  also the function that had the actual scan-order bug that
  `test_heightmap.js` was written to catch (it was checking bit `63..0` in
  the leaf mask directly as a proxy for "highest Y first", which is wrong
  because the bit index is z-major, not y-major — fixed by scanning
  `ly = 3..0` explicitly).
- **Brush (`applyBrush`)**: width/height are **diameters**, not radii —
  `Math.floor((D-1)/2)` / `Math.ceil((D-1)/2)` on each side of the clicked
  voxel, so `D=1` is exactly one voxel. Sphere shape uses an ellipsoid test
  with the width/height as separate semi-axes when they differ.
- **Flatten (`applyFlatten`)**: box or polygon (even-odd point-in-polygon
  test) area selection on the minimap; runs in batches (`await
  nextTick()`) so it doesn't freeze the tab on a big selection.
- **Minimap**: `state.mmView` is the current zoom/pan window in voxel
  coordinates (wheel zooms toward the cursor); `state.flattenBox` /
  `state.polygon` are drawn in that same transformed space via
  `toScreen()`. Polygon point-adding is on the `click` event using
  `event.detail` to tell a single click from the first half of a
  double-click apart (this is what a `pointerdown`-based version got wrong
  — a double-click fires two `pointerdown`s before the browser's
  `dblclick`, so it was adding two extra points every time you tried to
  close a shape).
- **Export**: `compact()` → `encodeTree()` → rebuild the JSON header
  (bounds/resolution/version copied through, counts recomputed) → ZIP both
  files → `downloads.save()`.

### Gaussian splats (`PART 6`)

**Why**: the voxels are trained *from* a splat scene, so the question you
usually want answered is "do these voxels still match the scene?". Loading
the source `.ply` puts both in the same world space at once.

- **Loading**: "Load splats (.ply)" in the header. Binary-little-endian PLY
  only; properties are looked up **by name**, not by position, so the usual
  INRIA order and `splat-transform`'s reordered output both work.
  `scale_*` / `opacity` are activated (`exp` / sigmoid) or taken as-is
  depending on a 2,000-vertex probe — a file with no negative scales and
  opacity already in [0,1] is treated as pre-activated. Colour comes from
  `f_dc_*` (SH DC, `0.5 + 0.282*f`) or from `red`/`green`/`blue`. A
  PlayCanvas *compressed* `.ply` (the one with a `chunk` element) is
  rejected with a message rather than parsed into nonsense.
- **Renderer**: standard EWA splatting. Per splat the CPU builds the 3D
  covariance `S = (R*D)(R*D)ᵀ` once; the vertex shader projects it with the
  perspective Jacobian, takes the 2x2 result's eigenvectors as the axes of a
  screen-space quad, and the fragment shader falls off as `exp(-r²)` inside
  it. Alpha is premultiplied and blended back-to-front, **depth-tested but
  not depth-written** — so the voxel surface occludes splats behind it,
  which is what makes the overlay readable.
  - Splat records live in a float `DataTexture` (4 RGBA texels each) and the
    only instanced attribute is a float index into it, so a re-sort
    re-uploads 4 bytes per splat instead of 64.
  - **The quad's axes are (major axis, its perpendicular), which reverses
    the winding**, so the material must be `DoubleSide`. With three.js's
    default `FrontSide` every splat is back-face culled and you get a
    perfectly black screen, no warning, shaders compiling fine. Do not
    re-introduce it.
- **Sorting**: a 16-bit counting sort on view-space Z, in a Blob worker,
  with the same function running inline if `new Worker` throws (strict CSP
  in an artifact sandbox). It re-runs when the view matrix's depth row
  moves more than a small epsilon, so a still camera costs nothing.
- **Alignment** (`splat.perm` / `sign` / `offset` / `scale`) lives on the
  group's matrix, so covariances get transformed for free through
  `modelViewMatrix`. The default is **(-x, -y, z)**: `splat-transform`
  rotates the scene 180° about Z before voxelizing. That was not assumed —
  all 48 signed axis permutations were scored against the octree's own
  occupancy and that one won, 99.7% against 68% for the runner-up.
- **"Auto-align"** re-runs exactly that search for any other pair (48
  permutations, then coordinate descent on the translation at 2 m / 0.5 m /
  0.1 m; ~45 ms on a 445k-splat file). **The match percentage** — the share
  of sampled splat centres that land inside a solid voxel — is the number
  to watch. The real `terrain.voxel` + `mesh.ply` pair scores **99.5%**; a
  deliberately mismatched pair scored 42.7%, so the two cases are nowhere
  near each other.
- **Comparing**: "Voxel α" fades the voxel surface (one shared material for
  every chunk now, hence one assignment) so the splats show through it;
  "Splat α" does the same the other way; the height-clip slider can cut
  both at the same plane; `V` toggles the splats; "Budget" draws 1-in-N
  splats if a huge file needs it.
- **The voxel surface is a solid, so fading it needs a depth prepass.** Its
  interior and far-side faces sit behind whatever you are looking at, and
  blending them all turns the terrain into a see-through scribble — the
  silhouette survives but you read ridges from the far side through the
  near surface. Turning depth writes back on does not fix it: triangles
  inside one chunk are in scan order, not depth order, so a back-to-front
  run still blends every layer. Each voxel mesh therefore draws its
  geometry twice, as two groups over the same vertices — a depth-only
  prepass (`voxelDepthMaterial`, `colorWrite: false`), then the shaded
  pass with `depthWrite: false`, which only survives where it equals the
  frontmost depth. One translucent skin per pixel, any alpha, any view
  direction. Consequence to keep in mind: the see-through surface still
  writes depth, so the splats switch to `depthTest: false` whenever voxel
  α < 1, or they would be culled by a surface you are looking through.

## Known limitations / good next things to check

- **Overview mode has no inter-node face culling.** Every leaf/solid node
  draws all 6 faces unconditionally, so a very high-node-count scene could
  be slow to build or heavy to render in that mode. If that turns out to
  matter, the fix is either a minimum-node-size cutoff or actually checking
  neighbor occupancy across node boundaries.
- **Flatten on a very large area is still just a per-voxel loop** (batched
  to avoid freezing the tab, but not accelerated). Fine for the areas it
  was tried against; a big flatten across the whole grid could take a
  while.
- **The brush's "add" never respects the height clip** — you can paint
  above the clip plane and it'll just be invisible until you raise the
  clip again. This is intentional (view-only clip) but worth knowing.
- **Octant convention** — see the callout above under Format notes.
- **Splats ignore spherical harmonics beyond DC.** `f_rest_*` is skipped, so
  the overlay is view-independent — flatter than the same file in a real
  splat viewer, but that has no bearing on judging alignment.
- **Auto-align only searches axis permutations, flips and a translation.**
  An arbitrary rotation between the two spaces would need real registration
  (ICP of the splat centres against the voxel surface). The match
  percentage would make it obvious that something like that is going on,
  but the button would not fix it.

## If you continue this in Claude Code

The most obvious cleanup: the codec exists **twice** (inlined in
`voxel_editor.html`'s `PART 1`, and again in `voxelcore.js`), because the
HTML file has to be a single self-contained artifact with no build step,
while `voxelcore.js` exists purely so the logic could be unit-tested in
Node against real `.bin` files before being trusted in a UI I can't
actually run from here. If you set up any kind of build step (even a
trivial `cat`/bundling script) in Claude Code, unifying these into one
source of truth and generating the inline `<script>` block from it would
remove the main risk of the two silently drifting apart. Until then, if you
change the codec, change both, and re-run `test_voxelcore.js` against a
real file before trusting it.
