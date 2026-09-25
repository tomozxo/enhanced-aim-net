// Crosshairs for the drills: the site's own, plus the ones well-known pros
// run in Valorant and CS2, drawn at their real on-screen size.
//
// Every size here is in screen pixels on a 1080p screen, and scales with
// screen height like the games do:
//   length    - each arm, from its inner end to its outer end
//   thickness - how wide each arm is
//   hole      - the empty space across the middle, between opposite arms
//   dot       - centre dot size (0 = none)
//   outline   - black border around every part (0 = none)
//
// Where the numbers come from (checked September 2026):
// - Valorant pros: read straight from their import codes. "0l" is the inner
//   line length, "0t" its thickness (default 2), "0o" the offset from the
//   centre (so the hole is twice it), "h;0" turns outlines off, "c" is the
//   colour (1 green, 5 cyan, default white).
// - CS2 pros: their Classic Static settings from prosettings.net, in the
//   units CS2 used until the Rush Hour update (24 Sep 2026): length and
//   thickness in 1/480ths of screen height (x2.25 at 1080p, rounded like
//   the game rounds them), gap in pixels where the hole is 4 + gap.

// Shown as pictures only, all in one colour (white until you pick another),
// largest to smallest. The comments say whose each one is and the setting
// it comes from; the colours those players use aren't carried over.
export const DEFAULT_CROSSHAIR_COLOR = '#ffffff';

export const CROSSHAIRS = [
  // The site's original crosshair.
  { id: 'default', length: 7, thickness: 1, hole: 7, dot: 0, outline: 1, outlineAlpha: 0.6, alpha: 1 },
  // Valorant's own default inner lines (6 long, 2 thick, offset 3, outline
  // at 0.5) without the outer lines.
  { id: 'valorant', length: 6, thickness: 2, hole: 6, dot: 0, outline: 1, outlineAlpha: 0.5, alpha: 1 },
  // Demon1: 0;p;0;s;1;P;o;1;f;0;0t;1;0l;3;0o;2;0a;1;0f;0;1b;0 - 1px outline
  { id: 'demon1', length: 3, thickness: 1, hole: 4, dot: 0, outline: 1, outlineAlpha: 1, alpha: 1 },
  // TenZ: 0;s;1;P;c;5;h;0;m;1;0l;4;0o;2;0a;1;0f;0;1b;0
  { id: 'tenz', length: 4, thickness: 2, hole: 4, dot: 0, outline: 0, alpha: 1 },
  // Aspas: 0;s;1;P;c;1;h;0;0l;4;0o;1;0a;1;0f;0;1b;0
  { id: 'aspas', length: 4, thickness: 2, hole: 2, dot: 0, outline: 0, alpha: 1 },
  // ZywOo (CS2): length 2, thickness 0.5, gap -3
  { id: 'zywoo', length: 5, thickness: 1, hole: 1, dot: 0, outline: 0, alpha: 1 },
  // donk (CS2): length 1, thickness 1.5, gap -4
  { id: 'donk', length: 2, thickness: 3, hole: 0, dot: 0, outline: 0, alpha: 1 },
  // s1mple (CS2): length 1, thickness 1, gap -4, alpha 200 (m0NESY runs the
  // same shape fully opaque)
  { id: 's1mple', length: 2, thickness: 2, hole: 0, dot: 0, outline: 0, alpha: 200 / 255 },
  // NiKo (CS2): length 0 with the dot on, thickness 2 - just a dot
  { id: 'niko', length: 0, thickness: 4, hole: 0, dot: 4, outline: 0, alpha: 1 },
];

/** The colours both games offer, in the order Valorant lists them. */
export const CROSSHAIR_COLORS = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Green', hex: '#00ff00' },
  { name: 'Yellow', hex: '#ffff00' },
  { name: 'Cyan', hex: '#00ffff' },
  { name: 'Pink', hex: '#ff00ff' },
  { name: 'Red', hex: '#ff0000' },
];

export function getCrosshair(id) {
  return CROSSHAIRS.find((c) => c.id === id) || CROSSHAIRS[0];
}

/**
 * Draws a crosshair onto `canvas` at `scale` device pixels per 1080p pixel
 * and sizes the canvas to fit it. Everything is snapped to whole pixels so
 * it stays sharp, and each dimension is nudged by a pixel where needed so
 * the arms sit exactly centred on each other. Returns the canvas's size in
 * device pixels.
 */
export function drawCrosshair(canvas, preset, color, scale = 1) {
  const px = (v, min) => (v > 0 ? Math.max(min, Math.round(v * scale)) : 0);
  const L = px(preset.length, 1);
  const T = px(preset.thickness, 1);
  let hole = Math.max(0, Math.round(preset.hole * scale));
  let D = px(preset.dot, 1);
  const O = px(preset.outline, 1);

  let span = L > 0 ? 2 * L + hole : 0;
  if (L > 0 && (span - T) % 2 !== 0) {
    hole += 1;
    span += 1;
  }
  const size = Math.max(span, D, T) + 2 * O + 2;
  if (D > 0 && (size - D) % 2 !== 0) D += 1;

  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const rects = [];
  if (L > 0) {
    const a = (size - span) / 2; // outer end of the left/top arm
    const b = (size + span) / 2; // outer end of the right/bottom arm
    const t = (size - T) / 2;
    rects.push([a, t, L, T], [b - L, t, L, T], [t, a, T, L], [t, b - L, T, L]);
  }
  if (D > 0) rects.push([(size - D) / 2, (size - D) / 2, D, D]);

  if (O > 0) {
    ctx.globalAlpha = preset.outlineAlpha ?? 1;
    ctx.fillStyle = '#000000';
    for (const [x, y, w, h] of rects) ctx.fillRect(x - O, y - O, w + 2 * O, h + 2 * O);
  }
  // Clear the arms' own area first so a see-through outline doesn't darken
  // the colour where the two overlap.
  for (const [x, y, w, h] of rects) ctx.clearRect(x, y, w, h);
  ctx.globalAlpha = preset.alpha ?? 1;
  ctx.fillStyle = color || DEFAULT_CROSSHAIR_COLOR;
  for (const [x, y, w, h] of rects) ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  return size;
}
