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
  **One application per press**, on both the mouse and a VR controller:
  the brush used to fire on every pointermove (and every XR frame) while
  the button was held, which paints or carves far more than you meant and
  does it faster than you can let go. The press is still one stroke on the
  undo stack; press again to apply again. The other tools are unchanged —
  the flatten box and polygon handles still drag.
- **Flatten (`applyFlatten`)**: box or polygon (even-odd point-in-polygon
  test) area selection, drawn either on the minimap or directly in the 3D
  view; runs in batches (`await nextTick()`) so it doesn't freeze the tab
  on a big selection. The column height it writes comes from
  **`flattenHeightFn()`** — one function that reads the current controls
  (flat target Y, bilinear box corners, or IDW over polygon vertices) and
  returns `(px,pz) -> target column height in voxels`, or an error string
  saying which control is still missing. The 3D preview calls the same
  function, which is the whole point of extracting it: the preview cannot
  promise a surface the edit then doesn't write.
- **Flatten preview in 3D (`buildFlattenOverlay`)**: the selection is drawn
  into the scene as the surface Apply would leave — one quad per column,
  at the height `flattenHeightFn()` gives, tinted **green where it fills**
  and **red where it cuts** (`cutFillColor`, saturating over ~24 voxels of
  difference), plus the outline, a marker per control point and a stem from
  the current ground up/down to the target. The cell grid is coarsened by an
  integer step so a whole-grid selection is ~4k quads and ~1.5 ms to build,
  not 16k columns; cell centres are tested with the *same* `pointInPolygon`
  call `applyFlatten` uses, so the preview's edge is the real edge.
  - **The fill is drawn twice over the same geometry**: a depth-tested pass,
    and a much fainter `depthTest: false` ghost underneath it. A *cut*
    target is by definition buried inside the terrain, so a single
    depth-tested pass would hide the preview in exactly the case you most
    need it. The outline, stems and markers ignore depth outright — they're
    the handles of a selection, and a handle you can lose behind a ridge is
    worse than one that floats.
  - Rebuilt from scratch on any change, guarded by
    `flattenOverlaySignature()` — a string of everything the geometry
    depends on. Without it the rebuild would run on every hover, because
    `drawMinimap()` is what refreshes both views (it calls
    `updateFlattenOverlay()` at its tail, so the minimap and the 3D preview
    can't disagree about what's selected).
- **Drawing the area in the 3D view**: with the flatten tool active the left
  button draws instead of orbiting (right-drag still orbits) — drag a box,
  or click polygon points with a live rubber band, double-click to finish,
  exactly mirroring the minimap's bindings. Points land via
  `surfacePointAt()`, which raycasts the streamed chunks (or the overview
  mesh, so you can grab a large area from the whole-model view), steps
  `-normal * res/2` to get the column *under* the cursor rather than the
  empty voxel in front of the face, and clamps into the grid. A polygon
  point clicked in 3D takes the height you actually clicked, not a
  resampled one.
- **Editing a finished polygon**: every point is a handle in both views — drag
  to move it, drag the faint handle at an edge's midpoint to insert a point
  there (`insertPolygonPoint`, which starts the new point's height *on* that
  edge, so inserting alone never changes the surface), alt-click or the
  panel's ✕ to delete, Delete/Backspace for the selected point (or, while
  still tracing, the one you just put down). Dropping below three points
  reopens the shape for tracing rather than pretending it's still an area.
  The point list in the panel is no longer gradient-only: it's how you
  select, inspect and delete points in both modes, and the selected point is
  highlighted in the panel, on the minimap and in 3D at once.
  - **Handles are picked in screen space** (`polygonHandlesScreen` /
    `pickPolygonHandle`), not by raycasting the marker meshes. A marker is a
    fixed size in *world* units, so at any distance it shrinks to a few
    pixels and becomes an unhittable target; a pixel radius is the same
    forgiving click everywhere. Vertices are tested before edge midpoints, so
    a midpoint can never shadow a vertex sitting under it.
  - **Behaviour change**: a click on empty space no longer wipes a finished
    shape. That used to be how you started over, and it's a trap once the
    shape is worth editing — "New shape" (the old "Clear points") does it
    explicitly now.
- **Eyedropper (tool 5, `applyPickedHeight`)**: clicking the terrain — in 3D
  or on the minimap — sets the flatten height from the top of the voxel you
  hit. Which control it feeds depends on the mode: with gradient off it sets
  Target Y and hands the tool straight back to flatten (single-shot, that
  being the whole job); with gradient on it sets the *nearest* box corner or
  polygon point and stays active so you can walk round the shape. This is
  the answer to "what number do I put in Target Y" for the no-gradient case,
  where there is otherwise nothing to sample against but the minimap's
  colour ramp.
- **Minimap**: `state.mmView` is the current zoom/pan window in voxel
  coordinates (wheel zooms toward the cursor); `state.flattenBox` /
  `state.polygon` are drawn in that same transformed space via
  `toScreen()`. Polygon point-adding is on the `click` event using
  `event.detail` to tell a single click from the first half of a
  double-click apart (this is what a `pointerdown`-based version got wrong
  — a double-click fires two `pointerdown`s before the browser's
  `dblclick`, so it was adding two extra points every time you tried to
  close a shape). Handle drags are the other way round — they start on
  `pointerdown`, and set `suppressPolygonClick` so the `click` that follows
  the drag does not also drop a new point where you let go.
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
  run still blends every layer. So while the surface is see-through, each
  voxel mesh draws its geometry twice, as two groups over the same
  vertices — a depth-only prepass (`voxelDepthMaterial`,
  `colorWrite: false`), then the shaded pass with `depthWrite: false`,
  which only survives where it equals the frontmost depth. One translucent
  skin per pixel, any alpha, any view direction.
  - **The prepass is only ordered correctly when the two groups land in
    different passes.** three sorts the opaque list by *program* before
    position, so two groups of one mesh get split up and every shaded draw
    can end up before every prepass — i.e. the whole surface drawn with no
    depth writes into an empty depth buffer, which looks exactly like
    depth testing being off. The prepass therefore runs only while the
    shaded material is `transparent` (opaque pass, then transparent pass,
    an ordering three does guarantee). At α = 1 it is switched off
    entirely via `voxelDepthMaterial.visible = false` — three skips a group
    whose material is invisible — and the surface writes its own depth like
    any ordinary opaque mesh. If you ever want to check this, wrap
    `renderer.renderBufferDirect` and log the material per draw; guessing
    from screenshots does not work, the artefacts are view-dependent and
    can be subtle.
  - Consequence to keep in mind: the see-through surface still writes
    depth, so the splats switch to `depthTest: false` whenever voxel α < 1,
    or they would be culled by a surface you are looking through. That is
    also why loading a `.ply` re-applies the current slider value — a
    material created later would otherwise keep the default.

### WebXR preview (`PART 7`)

"Enter VR" (top-right of the 3D view) shows the *same* scene — voxels,
splats, flatten overlay — on a headset, and edits it with the same tools.
The desktop view keeps running on the mirrored canvas.

- **The camera belongs to the headset in a session**, so the viewpoint is
  placed by a rig (`xrRig`) that `camera` is parented to. Outside a
  session the rig is identity and orbit/WASD behave exactly as before; on
  exit the last head pose is handed back to `camState`/`state.focus`, so
  taking the headset off doesn't teleport the desktop view.
- **The rig also carries the world scale**, `xrRig.scale` being "world
  units per real metre". **It defaults to 1**: the source `.ply` is metric
  and the grid is built in the same space, so VR is 1:1 and anything
  fitted to the model's extent is just a worse guess at a scale the file
  already knows. (A fitted default was tried first and reads as the world
  being about half the size it should be.) The right controller's A/B
  rescale from there for a tabletop view — the scale moves head
  translation *and* the IPD together, so it is a real change of viewpoint,
  not a zoom. Rescaling and turning happen about the head; about the rig
  origin they swing the world out from under you.
- **Locomotion**: left stick moves along the head's heading, right stick
  is up/down plus smooth yaw (≈108°/s at full stick, eased quadratically
  so small deflections turn slowly), grip sprints ×4. Note the sign: a +Y
  rotation of the rig swings your facing *left*, so the stick's X is
  negated. `state.focus` follows the head each frame so chunk streaming
  keeps up with where you fly.
- **The trigger is the mouse button**, and the controller's ray is the
  cursor: `setRaycasterFromController` fills the same `raycaster` that
  `setRaycasterFromScreen` does, so brush, flatten box, polygon and height
  pick all run their existing code — `paintAtRay` / `surfacePointAtRay`
  are just the mouse handlers' bodies with the ray taken as given. The VR
  handlers mirror pointerdown/move/up one for one, minus what a hand does
  not have: no right-drag orbit (you fly). The brush fires once per
  trigger press, as it does per mouse press. Grip + trigger on a vertex is
  the alt-click that deletes it; X and Y on the left controller
  are undo and redo, because a mis-aimed stroke in a headset has no
  keyboard to take it back with.
- **The controls ride on the left hand** (`xrPanel`): a dial floating
  above the left controller with the five tools and the flatten **Apply**
  spaced evenly around its ring, the active one lit in its own colour and
  named in the hub. You work it with the *right* controller's ray and
  trigger —
  the same ray and trigger the tools use, so a press that lands on a
  button is swallowed there (`xrPtr.panel`) instead of reaching the
  terrain behind it, and while the ray rests on the dial the world cursor
  goes away and the ray stops at the button. It is built in
  controller-local metres, so the A/B rescale cannot grow or shrink it,
  and drawn with `depthTest` off, because a menu buried in the hillside
  you are standing in is no menu. Icons are canvas textures drawn as white
  strokes on nothing, so one material colour tints each one: grey at rest,
  the tool's colour when active. **Apply** does in the hub what the
  sidebar does in dialogs — `applyFlatten`'s failure modes are `alert()`s,
  which nobody can see in a headset, so the dial pre-checks
  `flattenAreaBounds`/`flattenHeightFn` and answers on the hub instead
  ("Draw a shape first"); an unfinished polygon is closed first, since
  that is what Apply means while you are still tracing one.
- **What the dial carries beyond the ring follows the active tool**, since
  there is no room for everything at once and no use for it either. With
  **flatten** up, the hub's second line *is* the box/polygon switch — a
  pill with swap arrows around the mode, pressed like any other button —
  because the mode belongs under the tool's name and there is no seventh
  seat on the ring for it. With **add/erase** up, a drawer under the ring
  carries a ± pair per brush diameter; holding the trigger repeats and
  accelerates (1 → up to 6 per step), because 1 to 48 voxels is a long way
  at one press a time, and sliding the ray off the button stops the run
  without letting go. Both diameters go through one `setBrushSize`, which
  the sidebar sliders now call too — two writers, one place, so the dial
  and the sliders cannot drift apart. Raycasting ignores `visible`, so the
  hit list (`xrPanel.targets`) is rebuilt per frame from what is actually
  on the dial rather than filtered afterwards. The flatten drawer carries
  the **Gradient** switch, which goes through `setFlattenGradient` — the
  same one the sidebar checkbox now calls, and it still seeds the corner
  and vertex heights off the terrain when it turns on, so gradient in a
  headset is one press rather than a row of blanks to type into.
- **Exit VR is on the dial too**, in a pill above the ring and on every
  tool, because a headset whose only way back to the desk is the system
  menu is a trap: it ends the session (`session.end()`), which runs the
  same `endXRSession` hand-back as the button on the page.
- **Closing a polygon is its own gesture in VR**: aim at the first or the
  last marker and pull. A double-click is the one thing a hand cannot do —
  the aim wanders between the two pulls, and worse, the second pull lands
  on the point just placed, where the handle grab swallowed it before it
  could ever count as a double (which is exactly how the first attempt at
  this, a timed double-pull, failed). So the close is an explicit target
  and it takes priority over grabbing that same handle. It applies only
  while tracing with three or more points; on a finished shape every
  handle, ends included, is back to being an edit handle. The mouse still
  closes on a double-click, which is unchanged.
- **Handle picking is the one thing that could not be reused.** On screen
  a polygon handle is a pixel radius (`POLY_HANDLE_PX`), which is what
  keeps a distant marker hittable; a controller has no pixels, so
  `pickPolygonHandleRay` uses an *angle* off the ray instead
  (`XR_HANDLE_ANGLE`) — the same forgiving target at any distance, and
  scale-free, since the rig's scale cancels out of the ratio.
  `polygonHandlesWorld()` is the shared source both pickers read.
- **Aim feedback**: the hand that last pulled a trigger gets its ray
  trimmed to whatever it hit and a cursor dot dropped there, tinted by
  tool. That is one extra raycast per frame, and it is skipped whenever no
  tool could use it (no grid, or the orbit tool).
- **Frames come from `renderer.setAnimationLoop`**, not `requestAnimation-
  Frame`: in a session they have to come from the headset's clock. Outside
  one three falls back to rAF itself, so the single `loop()` serves both.
- **The splat shader needs per-eye `focal`/`viewport`** (its quads are
  sized in pixels) — they're refilled each frame from the XR camera's own
  projection matrix and eye viewport, since the window's size means
  nothing in a session. `resize()` bails out entirely while presenting.
- Needs https (or localhost): opened as `file://` the button says so
  instead of silently doing nothing. Frame budget is the real limit — a
  multi-million-splat `.ply` that is comfortable on a desktop GPU will not
  hold 72 Hz on a standalone headset; drop the render radius and the splat
  budget before blaming the code.

## Known limitations / good next things to check

- **Overview mode has no inter-node face culling.** Every leaf/solid node
  draws all 6 faces unconditionally, so a very high-node-count scene could
  be slow to build or heavy to render in that mode. If that turns out to
  matter, the fix is either a minimum-node-size cutoff or actually checking
  neighbor occupancy across node boundaries.
- **Flatten on a very large area is still just a per-voxel loop** (batched
  to avoid freezing the tab, but not accelerated). Fine for the areas it
  was tried against; a big flatten across the whole grid could take a
  while. The 3D *preview* of that same area is cheap (it's capped at
  `FLATTEN_PREVIEW_MAX_CELLS` per axis), so the preview being instant says
  nothing about how long Apply will take.
- **The flatten preview's cut/fill tint is only leaf-block accurate.** It
  compares against `state.heightMap`, which is one height per 4x4x4 block
  column, so the colour can be a voxel or two off right at a boundary —
  visible as a thin mis-tinted fringe along the edge of a finished flatten.
  The *height* of the previewed surface is exact; only the tint is coarse.
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
