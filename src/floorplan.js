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
    .map(r => ({
      label: String(r.label).trim(),
      furniture: String(r.furniture || '').trim(),
      box: r.box_2d.map(Number),
    }))
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

// Recolle chaque pièce meublée dans le plan ORIGINAL. Seul le coeur de la pièce est
// recollé : la marge de contexte est rejetée, donc les murs restent ceux de la source.
export async function recomposite(originalDataUrl, placements) {
  const base = await loadImage(originalDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const ctx = canvas.getContext('2d');
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
[{"label":"<exact printed label>","box_2d":[ymin,xmin,ymax,xmax],"furniture":"<top-view furniture that belongs in this room>"}]

Rules:
- box_2d uses integers normalized to 0-1000, in the order [ymin, xmin, ymax, xmax], covering ONLY the interior of that room (inside its own walls).
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

export function furnishRoomPrompt(label, furniture, styleClause, refClause) {
  return `SINGLE ROOM FURNISHING TASK on a 2D architectural floor plan crop, seen strictly from above (orthographic top-down).

This image is ONE room of a floor plan, labeled "${label}". Add realistic TOP-VIEW furniture inside this room: ${furniture || 'furniture appropriate to this room type'}.${styleClause}${refClause}

ABSOLUTE CONSTRAINTS:
- Keep the existing walls, doors, windows and their exact positions untouched.
- Keep the printed text label "${label}" and its surface area visible and unchanged.
- Do NOT add, remove, split or merge any wall or room.
- Do NOT change the image framing, zoom, dimensions or perspective.
- Do NOT place anything outside the room's walls.
- Furniture must be to scale and fit inside the room.
- Flat 2D top-down floor-plan rendering style, orthographic, crisp lines.

Output: ONLY the modified image, same framing and same dimensions as the input.`;
}
