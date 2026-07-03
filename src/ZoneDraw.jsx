import React, {
  useRef, useState, useEffect, useCallback,
  useImperativeHandle, forwardRef
} from 'react';

// Couleur du tracé de zone (rouge vif semi-transparent, bien visible pour l'IA)
const STROKE_COLOR = 'rgba(239, 68, 68, 0.85)';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image invalide.'));
    img.src = src;
  });
}

// Dessine une liste de traits dans un contexte, à l'échelle du rectangle donné.
// Les points sont stockés en coordonnées normalisées (0..1) de l'IMAGE,
// donc le rendu est identique à l'écran (rect = zone object-contain) et
// à l'export (rect = image pleine résolution).
function paintStrokes(ctx, rect, strokes) {
  strokes.forEach(s => {
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = Math.max(1, s.size * rect.w);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = rect.x + p.x * rect.w;
      const y = rect.y + p.y * rect.h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.lineTo(rect.x + p.x * rect.w + 0.01, rect.y + p.y * rect.h);
    }
    ctx.stroke();
  });
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Calque de dessin transparent posé par-dessus la photo (object-contain).
 * Compatible souris, doigt et stylet via les Pointer Events.
 *
 * API imperative (via ref) : undo(), clear(), isEmpty(), exportComposite()
 * — exportComposite() retourne un dataURL JPEG de la photo originale en
 * pleine résolution avec la zone dessinée par-dessus.
 */
const ZoneDraw = forwardRef(function ZoneDraw({ src, active, tool = 'brush', brushSize = 14, onChange }, ref) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const currentRef = useRef(null);
  const [imgDims, setImgDims] = useState(null);

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const notify = useCallback(() => {
    onChangeRef.current?.(strokesRef.current.length > 0);
  }, []);

  // Zone réellement occupée par l'image object-contain dans le conteneur
  const getContainRect = useCallback(() => {
    const el = containerRef.current;
    if (!el || !imgDims) return null;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return null;
    const scale = Math.min(cw / imgDims.w, ch / imgDims.h);
    const w = imgDims.w * scale;
    const h = imgDims.h * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }, [imgDims]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const el = containerRef.current;
    if (!canvas || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const rect = getContainRect();
    if (!rect) return;
    const all = currentRef.current
      ? [...strokesRef.current, currentRef.current]
      : strokesRef.current;
    paintStrokes(ctx, rect, all);
  }, [getContainRect]);

  // Nouvelle photo => on repart de zéro et on mémorise ses dimensions réelles
  useEffect(() => {
    strokesRef.current = [];
    currentRef.current = null;
    setImgDims(null);
    notify();
    if (!src) return;
    let cancelled = false;
    loadImage(src)
      .then(img => {
        if (!cancelled) setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [src, notify]);

  useEffect(() => { redraw(); }, [imgDims, redraw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => redraw());
    obs.observe(el);
    return () => obs.disconnect();
  }, [redraw]);

  const toImagePoint = useCallback((clientX, clientY) => {
    const el = containerRef.current;
    const rect = getContainRect();
    if (!el || !rect) return null;
    const bounds = el.getBoundingClientRect();
    const x = (clientX - bounds.left - rect.x) / rect.w;
    const y = (clientY - bounds.top - rect.y) / rect.h;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y))
    };
  }, [getContainRect]);

  const onPointerDown = (e) => {
    if (!active || !imgDims) return;
    e.preventDefault();
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = getContainRect();
    currentRef.current = {
      tool,
      size: rect ? brushSize / rect.w : 0.02,
      points: [p]
    };
    redraw();
  };

  const onPointerMove = (e) => {
    if (!currentRef.current) return;
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p) return;
    currentRef.current.points.push(p);
    redraw();
  };

  const onPointerUp = (e) => {
    if (!currentRef.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    strokesRef.current.push(currentRef.current);
    currentRef.current = null;
    redraw();
    notify();
  };

  useImperativeHandle(ref, () => ({
    undo() {
      strokesRef.current.pop();
      redraw();
      notify();
    },
    clear() {
      strokesRef.current = [];
      currentRef.current = null;
      redraw();
      notify();
    },
    isEmpty() {
      return strokesRef.current.length === 0;
    },
    // Photo originale pleine résolution + zone dessinée par-dessus (JPEG)
    async exportComposite() {
      if (!src || !imgDims || strokesRef.current.length === 0) return null;
      const img = await loadImage(src);
      const full = { x: 0, y: 0, w: imgDims.w, h: imgDims.h };
      // Les traits sont peints sur un calque séparé pour que la gomme
      // (destination-out) n'efface que le tracé, jamais la photo.
      const layer = document.createElement('canvas');
      layer.width = imgDims.w;
      layer.height = imgDims.h;
      paintStrokes(layer.getContext('2d'), full, strokesRef.current);
      const canvas = document.createElement('canvas');
      canvas.width = imgDims.w;
      canvas.height = imgDims.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.drawImage(layer, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.9);
    }
  }), [src, imgDims, redraw, notify]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className={`w-full h-full ${active ? 'cursor-crosshair touch-none' : 'pointer-events-none'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
});

export default ZoneDraw;
