import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, Download, Maximize2 } from 'lucide-react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

export default function Lightbox({ src, alt = 'Aperçu', onClose, onDownload }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const pointers = useRef(new Map());
  const pinchStart = useRef(null);
  const panStart = useRef(null);

  const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Le pan n'a de sens qu'une fois zoomé : à l'échelle 1 l'image tient dans l'écran.
  useEffect(() => {
    if (scale === 1) setOffset({ x: 0, y: 0 });
  }, [scale]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') setScale(s => clampScale(s + 0.5));
      else if (e.key === '-') setScale(s => clampScale(s - 0.5));
      else if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    // Empêche le scroll de la page derrière l'overlay.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, reset]);

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      pinchStart.current = { dist: distance(p1, p2), scale };
      panStart.current = null;
    } else if (pointers.current.size === 1 && scale > 1) {
      panStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      const [p1, p2] = [...pointers.current.values()];
      const d = distance(p1, p2);
      if (pinchStart.current.dist > 0) {
        setScale(clampScale(pinchStart.current.scale * (d / pinchStart.current.dist)));
      }
      return;
    }

    if (panStart.current && scale > 1) {
      setOffset({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) panStart.current = null;
  };

  const onWheel = (e) => {
    e.preventDefault();
    setScale(s => clampScale(s - e.deltaY * 0.002));
  };

  const onDoubleClick = () => {
    setScale(s => (s > 1 ? 1 : 2.5));
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/95 flex flex-col select-none"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex items-center justify-between p-4 gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-white/50">
          {Math.round(scale * 100)}%
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale(s => clampScale(s - 0.5))}
            title="Dézoomer (-)"
            className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setScale(s => clampScale(s + 0.5))}
            title="Zoomer (+)"
            className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={reset}
            title="Réinitialiser (0)"
            className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          {onDownload && (
            <button
              onClick={onDownload}
              title="Télécharger"
              className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            title="Fermer (Échap)"
            className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        style={{ cursor: scale > 1 ? 'grab' : 'zoom-in' }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-w-full max-h-full object-contain"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transition: pointers.current.size ? 'none' : 'transform 0.15s ease-out',
          }}
        />
      </div>

      <p className="text-center text-[9px] text-white/30 pb-4 uppercase tracking-widest">
        Double-tap ou pincer pour zoomer · Échap pour fermer
      </p>
    </div>
  );
}
