import React, { useRef, useState, useCallback, useEffect } from 'react';

export default function CompareSlider({ before, after, beforeLabel = 'Avant', afterLabel = 'Après' }) {
  const containerRef = useRef(null);
  const [position, setPosition] = useState(50);
  const draggingRef = useRef(false);

  const updateFromClientX = useCallback((clientX) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.max(0, Math.min(100, pct)));
  }, []);

  const onPointerDown = (e) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateFromClientX(e.clientX);
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    updateFromClientX(e.clientX);
  };
  const onPointerUp = (e) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') setPosition(p => Math.max(0, p - 2));
    else if (e.key === 'ArrowRight') setPosition(p => Math.min(100, p + 2));
    else if (e.key === 'Home') setPosition(0);
    else if (e.key === 'End') setPosition(100);
  };

  useEffect(() => {
    setPosition(50);
  }, [before, after]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full select-none overflow-hidden touch-none cursor-ew-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Image après (fond) */}
      <img
        src={after}
        alt={afterLabel}
        draggable={false}
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
      {/* Image avant (top, clippée par position) */}
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        <img
          src={before}
          alt={beforeLabel}
          draggable={false}
          className="absolute inset-0 w-full h-full object-contain"
        />
      </div>

      {/* Labels */}
      <span className="absolute top-3 left-3 px-2 py-0.5 bg-black/60 backdrop-blur-md rounded text-[9px] font-black uppercase text-white tracking-tighter pointer-events-none">
        {beforeLabel}
      </span>
      <span className="absolute top-3 right-3 px-2 py-0.5 bg-indigo-600/80 backdrop-blur-md rounded text-[9px] font-black uppercase text-white tracking-tighter pointer-events-none">
        {afterLabel}
      </span>

      {/* Ligne + poignée */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.5)] pointer-events-none"
        style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
      />
      <button
        type="button"
        role="slider"
        aria-label="Comparer avant et après"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="absolute top-1/2 w-10 h-10 rounded-full bg-white shadow-lg border-2 border-indigo-600 flex items-center justify-center cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-indigo-400"
        style={{ left: `${position}%`, transform: 'translate(-50%, -50%)' }}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-indigo-600" fill="currentColor">
          <path d="M9 5l-7 7 7 7V5zm6 0v14l7-7-7-7z" />
        </svg>
      </button>
    </div>
  );
}
