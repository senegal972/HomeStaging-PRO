// Pipeline d'aménagement de plan 2D pièce par pièce.
//
// Pourquoi ce détour : un modèle image générique (Gemini Flash Image) qui voit le plan
// entier repeint l'image au lieu de respecter la géométrie — il invente des murs, remplit
// les zones hors-murs et laisse les vraies pièces vides. En ne lui montrant qu'UNE pièce
// à la fois, puis en recollant le résultat dans le plan d'origine, la structure ne peut
// plus dériver : les murs recollés sont ceux de la source.

const MIN_CROP_SIDE = 512;   // upscale des petites pièces avant envoi au modèle
const MAX_CROP_SIDE = 1024;
const CONTEXT_PAD_RATIO = 0.06; // marge de contexte autour de la pièce (murs voisins)
const FURNISH_CONCURRENCY = 3;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible."));
    img.src = src;
  });
}

// Gemini renvoie les boîtes en [ymin, xmin, ymax, xmax] normalisées 0-1000.
function boxToPixels(box, W, H) {
  const [ymin, xmin, ymax, xmax] = box;
  return {
    x0: Math.max(0, Math.round((xmin / 1000) * W)),
    y0: Math.max(0, Math.round((ymin / 1000) * H)),
    x1: Math.min(W, Math.round((xmax / 1000) * W)),
    y1: Math.min(H, Math.round((ymax / 1000) * H)),
  };
}

export function parseRooms(rawText) {
  if (!rawText) return [];
  let txt = rawText.trim();
  // Le modèle encadre souvent le JSON dans des fences markdown.
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf('[');
  const end = txt.lastIndexOf(']');
  if (start !== -1 && end !== -1) txt = txt.slice(start, end + 1);
  let arr;
  try {
    arr = JSON.parse(txt);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(r => r && Array.isArray(r.box_2d) && r.box_2d.length === 4 && r.label)
    .filter(r => !/^(outside|void|exterieur|extérieur)/i.test(String(r.label)))
    .map(r => {
      const lb = Array.isArray(r.label_box_2d) && r.label_box_2d.length === 4
        ? r.label_box_2d.map(Number)
        : null;
      return {
        label: String(r.label).trim(),
        furniture: String(r.furniture || '').trim(),
        box: r.box_2d.map(Number),
        labelBox: lb && lb.every(n => Number.isFinite(n)) ? lb : null,
      };
    })
    .filter(r => r.box.every(n => Number.isFinite(n)));
}

// Découpe une pièce avec marge de contexte. Retourne le crop (dataUrl) + la géométrie
// nécessaire pour recoller uniquement le coeur de la pièce (hors marge) plus tard.
export function cropRoom(img, box) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const core = boxToPixels(box, W, H);
  const coreW = core.x1 - core.x0;
  const coreH = core.y1 - core.y0;
  if (coreW < 8 || coreH < 8) return null;

  const pad = Math.round(Math.max(coreW, coreH) * CONTEXT_PAD_RATIO);
  const cx0 = Math.max(0, core.x0 - pad);
  const cy0 = Math.max(0, core.y0 - pad);
  const cx1 = Math.min(W, core.x1 + pad);
  const cy1 = Math.min(H, core.y1 + pad);
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;

  let scale = 1;
  const minSide = Math.min(cw, ch);
  const maxSide = Math.max(cw, ch);
  if (minSide < MIN_CROP_SIDE) scale = MIN_CROP_SIDE / minSide;
  if (maxSide * scale > MAX_CROP_SIDE) scale = MAX_CROP_SIDE / maxSide;

  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, cx0, cy0, cw, ch, 0, 0, outW, outH);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    crop: { x: cx0, y: cy0, w: cw, h: ch },
    core: { x: core.x0, y: core.y0, w: coreW, h: coreH },
  };
}

// Ré-estampe le texte d'un label depuis le plan SOURCE par-dessus le rendu.
//
// Le modèle repeint la pièce et abîme le texte au passage ("Chambre 1" disparaît,
// "SDB 2" devient "DB"). Aucun prompt ne fiabilise ça. Plutôt que de le demander, on
// l'impose : on recopie les pixels d'origine. Seuls les pixels SOMBRES (les lettres)
// sont repris, avec leur anti-aliasing — le sol meublé généré reste visible autour,
// donc pas de rectangle blanc collé sur les meubles.
function restampLabel(ctx, base, box, W, H) {
  const r = boxToPixels(box, W, H);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w < 2 || h < 2) return;

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(base, r.x0, r.y0, w, h, 0, 0, w, h);

  const src = tctx.getImageData(0, 0, w, h);
  const dst = ctx.getImageData(r.x0, r.y0, w, h);
  const s = src.data;
  const d = dst.data;

  for (let i = 0; i < s.length; i += 4) {
    const lum = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    // 1 = noir franc (coeur de la lettre), 0 = fond clair. Le dégradé entre les deux
    // conserve l'anti-aliasing des glyphes.
    const a = Math.max(0, Math.min(1, 1 - lum / 150));
    if (a <= 0.02) continue;
    d[i] = s[i] * a + d[i] * (1 - a);
    d[i + 1] = s[i + 1] * a + d[i + 1] * (1 - a);
    d[i + 2] = s[i + 2] * a + d[i + 2] * (1 - a);
    d[i + 3] = 255;
  }
  ctx.putImageData(dst, r.x0, r.y0);
}

// Recolle chaque pièce meublée dans le plan ORIGINAL. Seul le coeur de la pièce est
// recollé : la marge de contexte est rejetée, donc les murs restent ceux de la source.
// Les labels sont ensuite ré-estampés depuis la source, par-dessus le rendu.
export async function recomposite(originalDataUrl, placements, labelBoxes = []) {
  const base = await loadImage(originalDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0);

  for (const p of placements) {
    if (!p?.imageDataUrl) continue;
    let gen;
    try {
      gen = await loadImage(p.imageDataUrl);
    } catch {
      continue;
    }
    // Mappe le coeur de la pièce depuis l'image générée (dimensions possiblement différentes).
    const sx = gen.naturalWidth / p.crop.w;
    const sy = gen.naturalHeight / p.crop.h;
    const srcX = (p.core.x - p.crop.x) * sx;
    const srcY = (p.core.y - p.crop.y) * sy;
    const srcW = p.core.w * sx;
    const srcH = p.core.h * sy;
    if (srcW < 1 || srcH < 1) continue;
    ctx.drawImage(gen, srcX, srcY, srcW, srcH, p.core.x, p.core.y, p.core.w, p.core.h);
  }

  // Après coup : les labels d'origine reprennent le dessus sur tout ce que le modèle
  // a pu écrire, effacer ou déformer.
  for (const box of labelBoxes) {
    if (Array.isArray(box) && box.length === 4) {
      try {
        restampLabel(ctx, base, box, canvas.width, canvas.height);
      } catch (err) {
        console.error('Ré-estampage du label échoué:', err);
      }
    }
  }

  return canvas.toDataURL('image/jpeg', 0.92);
}

// Exécute des tâches async par lots pour ne pas saturer le quota Gemini.
export async function inBatches(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const res = await Promise.all(batch.map((it, j) => worker(it, i + j)));
    out.push(...res);
  }
  return out;
}

export const ANALYZE_ROOMS_PROMPT = `You are analyzing a 2D architectural floor plan (top-down blueprint) with rooms labeled in French.

Return ONLY a JSON array, no prose, no markdown fences. One object per ENCLOSED, LABELED room:
[{"label":"<exact printed label>","box_2d":[ymin,xmin,ymax,xmax],"label_box_2d":[ymin,xmin,ymax,xmax],"furniture":"<top-view furniture that belongs in this room>"}]

Rules:
- box_2d uses integers normalized to 0-1000, in the order [ymin, xmin, ymax, xmax], covering ONLY the interior of that room (inside its own walls).
- label_box_2d is a TIGHT box (same 0-1000 format) around the printed text of that room ONLY — both the room name and its surface area line (e.g. "Chambre 1" + "10.5 m²"). Keep it snug around the text, with a couple of units of margin; never let it cover the whole room.
- Use the printed label to choose furniture:
  Chambre / Suite parentale -> double bed, nightstands, wardrobe
  Salon cuisine -> sofa, coffee table, rug, TV unit, dining table with chairs, kitchen counter with sink and hob
  SDB / SDB 2 -> bathtub or shower, sink, mirror
  WC -> toilet, small sink
  Dressing -> closets and shelving
  Buanderie -> washing machine, shelving
  Piece 07 / unlabeled circulation -> "" (leave empty, it is a hallway)
- Include ONLY rooms that are fully enclosed by walls AND have a printed label.
- NEVER include the blank area outside the exterior walls, courtyards, terraces, or page margins.
- Do not invent rooms. Do not merge or split rooms. Copy each label exactly as printed.`;

// Décrit la géométrie lue sur le plan, pour ancrer le rendu 3D.
// Sans cette carte, le modèle « invente » une maison plausible au lieu de reconstruire
// CELLE du plan : c'est la cause des rendus 3D qui ne ressemblent pas à la source.
export function roomMapText(rooms) {
  if (!rooms?.length) return '';
  const line = (r) => {
    const [ymin, xmin, ymax, xmax] = r.box;
    const vert = ymin < 380 ? 'top' : ymin > 620 ? 'bottom' : 'middle';
    const horiz = xmin < 380 ? 'left' : xmin > 620 ? 'right' : 'centre';
    const area = Math.round(((ymax - ymin) * (xmax - xmin)) / 1000);
    return `- "${r.label}" — ${vert}-${horiz} of the plan (relative footprint ${area}/1000)`;
  };
  return `\n\nROOM LAYOUT read from the plan — reproduce EXACTLY this set of rooms, in these relative positions and relative sizes, and nothing else:\n${rooms.map(line).join('\n')}\n`;
}

export function render3dPrompt(roomsClause, styleClause, refClause, details) {
  return `ARCHITECTURAL 3D VISUALISATION TASK — convert a 2D floor plan into a 3D render.

IMAGE 1 is a 2D architectural floor plan seen from above. Rebuild the dwelling it describes in three dimensions and render it as a realistic AXONOMETRIC (isometric) doll-house view seen from above at roughly a 45° angle, with the ROOF REMOVED so the whole interior is visible — a cutaway 3D view.
${roomsClause}
GEOMETRY IS THE PRIORITY: the result must be recognisable as THIS plan and no other. Same outer footprint and proportions, same wall positions, same room count, same relative room sizes, same adjacency, same door and window openings. Do not redesign the dwelling, do not add or remove rooms, walls or levels.

Furnish and inhabit each room according to its function on the plan: welcoming living area, contemporary open kitchen, made-up bedrooms, coherent bathrooms. Realistic materials: light walls, parquet or tiling depending on the space, simple elegant contemporary furniture.${styleClause}${refClause}

Extend the dwelling naturally outdoors: terraces where the plan shows them, a credible garden, natural lawn, and a few Caribbean trees — notably palm trees with sculptural trunks and vivid foliage — arranged around the house and the terrace for a warm, sunny atmosphere.${details}

Final rendering: high-end architectural visualisation, detailed and photorealistic, warm and luminous, like a contemporary architecture image made to present a real-estate project. Output ONLY the image, with no text or labels.`;
}

export function furnishRoomPrompt(label, furniture, styleClause, refClause) {
  return `SINGLE ROOM FURNISHING TASK on a 2D architectural floor plan crop, seen strictly from above (orthographic top-down).

This image is ONE room of a floor plan, labeled "${label}". Add realistic TOP-VIEW furniture inside this room: ${furniture || 'furniture appropriate to this room type'}.${styleClause}${refClause}

ABSOLUTE CONSTRAINTS:
- Keep the existing walls, doors, windows and their exact positions untouched.
- Keep the printed text label "${label}" and its surface area visible and unchanged.
- Do NOT add, remove, split or merge any wall or room.
- Do NOT change the image framing, zoom, dimensions or perspective.
- Every object you add — furniture, rugs, plants, decoration, shadows — must stay STRICTLY INSIDE this room's walls. Never draw on top of a wall, and never let anything spill into the corridor, the neighbouring rooms or the blank area outside the walls.
- Do not scatter decorative plants around: at most one or two, placed inside the room.
- Furniture must be to scale and fit inside the room.
- Flat 2D top-down floor-plan rendering style, orthographic, crisp lines.

Output: ONLY the modified image, same framing and same dimensions as the input.`;
}
