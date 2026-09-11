import React, { useEffect, useRef, useState } from 'react';
import { Camera, X, RefreshCcw, AlertCircle, Loader2, RotateCcw } from 'lucide-react';

// Capture caméra plein écran via getUserMedia — bypass complet du dialog natif.
//
// Motivation : sur Android récent, `<input type="file" capture="environment">` peut
// ouvrir le sélecteur de fichiers au lieu de la caméra (comportement changé côté
// Chrome mobile). Sur iOS Safari, ça affiche un menu à 3 options au lieu de la
// caméra direct. Avec getUserMedia, on maîtrise le comportement partout où l'API
// est disponible et le contexte HTTPS.
//
// Props: onCapture(file) — File JPEG prêt à passer dans le pipeline standard
//        onClose()
export default function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState('starting'); // starting|ready|error
  const [errMsg, setErrMsg] = useState('');
  const [facing, setFacing] = useState('environment'); // arrière par défaut
  const [snap, setSnap] = useState(null); // dataUrl de l'aperçu figé
  const [snapFile, setSnapFile] = useState(null);

  // (Re)démarre le stream à chaque changement de caméra.
  useEffect(() => {
    let cancelled = false;
    async function start() {
      setStatus('starting');
      setErrMsg('');
      // Nettoie l'ancien stream avant d'en ouvrir un nouveau (bascule avant/arrière).
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setErrMsg("Ce navigateur ne permet pas d'ouvrir la caméra. Utilisez « Importer un fichier ».");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // playsInline requis pour iOS Safari : sinon la vidéo passe en plein écran natif.
          videoRef.current.setAttribute('playsinline', 'true');
          try { await videoRef.current.play(); } catch { /* autoplay bloqué, on affiche quand même */ }
        }
        setStatus('ready');
      } catch (err) {
        setStatus('error');
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setErrMsg("Accès à la caméra refusé. Autorisez la caméra dans les paramètres du site puis réessayez.");
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setErrMsg("Aucune caméra correspondante trouvée sur cet appareil.");
        } else if (name === 'NotReadableError') {
          setErrMsg("La caméra est déjà utilisée par une autre application.");
        } else if (name === 'SecurityError') {
          setErrMsg("Le navigateur bloque la caméra (HTTPS requis).");
        } else {
          setErrMsg(`Erreur caméra : ${err?.message || name || 'inconnue'}`);
        }
      }
    }
    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);

  // Piège Échap sur ce composant uniquement, pour ne pas conflicter avec la garde globale.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    canvas.toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setSnap(dataUrl);
      setSnapFile(file);
    }, 'image/jpeg', 0.92);
  };

  const retake = () => { setSnap(null); setSnapFile(null); };
  const validate = () => { if (snapFile) onCapture(snapFile); };
  const flip = () => setFacing(f => (f === 'environment' ? 'user' : 'environment'));

  return (
    <div
      className="fixed inset-0 z-[80] bg-black flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Prendre une photo"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 text-white">
        <button
          onClick={onClose}
          title="Fermer"
          className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <span className="text-[10px] font-black uppercase tracking-widest text-white/70">
          {snap ? 'Aperçu' : 'Caméra'}
        </span>
        {!snap && status === 'ready' ? (
          <button
            onClick={flip}
            title="Basculer avant / arrière"
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
          >
            <RefreshCcw className="w-5 h-5" />
          </button>
        ) : <span className="w-9" />}
      </div>

      {/* Preview */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center">
        {status === 'starting' && !snap && (
          <div className="text-white/70 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-xs font-bold uppercase tracking-widest">Ouverture de la caméra…</p>
          </div>
        )}
        {status === 'error' && !snap && (
          <div className="text-center px-8 max-w-sm">
            <div className="p-3 bg-red-500/20 rounded-2xl inline-block mb-3">
              <AlertCircle className="w-6 h-6 text-red-300" />
            </div>
            <p className="text-xs text-white/90 leading-relaxed">{errMsg}</p>
            <button
              onClick={() => setFacing(f => f)} // force re-run de l'effet (mémoire), en cas de retry
              className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-white transition-colors"
            >
              Réessayer
            </button>
          </div>
        )}
        {/* Vidéo toujours montée pendant que 'ready' pour laisser le stream vivant */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`max-w-full max-h-full object-contain ${status === 'ready' && !snap ? 'block' : 'hidden'}`}
        />
        {snap && (
          <img src={snap} alt="Aperçu capturé" className="max-w-full max-h-full object-contain" />
        )}
      </div>

      {/* Controls */}
      <div className="p-6 flex items-center justify-center gap-8">
        {!snap ? (
          <button
            onClick={shoot}
            disabled={status !== 'ready'}
            title="Prendre la photo"
            aria-label="Prendre la photo"
            className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-2xl active:scale-95 transition-transform disabled:opacity-40"
          >
            <div className="w-16 h-16 rounded-full bg-white border-4 border-slate-900 flex items-center justify-center">
              <Camera className="w-7 h-7 text-slate-900" />
            </div>
          </button>
        ) : (
          <>
            <button
              onClick={retake}
              className="flex-1 max-w-[160px] flex items-center justify-center gap-2 py-3 rounded-2xl bg-white/10 text-white text-xs font-black uppercase tracking-tighter hover:bg-white/20 transition-colors"
            >
              <RotateCcw className="w-4 h-4" /> Reprendre
            </button>
            <button
              onClick={validate}
              className="flex-1 max-w-[200px] py-3 rounded-2xl bg-indigo-600 text-white text-xs font-black uppercase tracking-tighter hover:bg-indigo-700 transition-colors shadow-lg"
            >
              Utiliser cette photo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
