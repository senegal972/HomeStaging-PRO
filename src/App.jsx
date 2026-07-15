import React, { useState, useRef, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signOut
} from 'firebase/auth';
import {
  getFirestore, collection, onSnapshot,
  addDoc, serverTimestamp
} from 'firebase/firestore';
import {
  Upload, ImageIcon, Sparkles, AlertCircle, Loader2, Download,
  Home, Sofa, Brush, History, LogOut, Lock, TreePine,
  Eraser, Layout, Hammer, Boxes, PlusCircle, RefreshCcw,
  KeyRound, Eye, EyeOff, X, CheckCircle2, SplitSquareHorizontal, BarChart3,
  MapPin, Pencil, Undo2, Trash2, Check, Map, Maximize2
} from 'lucide-react';
import CompareSlider from './CompareSlider';
import ZoneDraw from './ZoneDraw';
import Lightbox from './Lightbox';
import {
  loadImage, parseRooms, cropRoom, recomposite, inBatches,
  ANALYZE_ROOMS_PROMPT, furnishRoomPrompt, render3dPrompt, roomMapText
} from './floorplan';

// === CONFIGURATION Firebase ===
const FIREBASE_CONFIGURED = !!(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID
);

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "placeholder",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "placeholder.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "placeholder",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "placeholder.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "000000000000",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:000000000000:web:placeholder"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'maison-ia-prive';

// === CONFIGURATION Gemini ===
const GEMINI_API_KEY_DEFAULT = import.meta.env.VITE_GEMINI_API_KEY || "";
const LS_KEY = 'homestaging_gemini_key';

// === Validation upload ===
const MAX_RAW_UPLOAD_MB = 15;
const MAX_REFERENCE_IMAGES = 3;

// === Variantes IA ===
// Hints NON-structurels : varient déco/palette/lumière SANS toucher murs, pièces, structure.
// (Les anciens hints "different layout / creative composition" provoquaient des dérives :
// pièces divisées, salon transformé en chambre, etc.)
const VARIANT_COUNT = 4;
const VARIANT_HINTS = [
  '',
  ' Variation: warmer color palette and softer lighting only — keep the exact same structure, walls and layout.',
  ' Variation: different furniture pieces and materials only — do not alter structure, walls or room boundaries.',
  ' Variation: different textures and decorative accents only — keep structure, walls and room count identical.',
];

// Verrou structurel : empêche l'IA d'ajouter/supprimer/diviser/fusionner des pièces ou murs.
const STRUCTURE_LOCK = " STRICT STRUCTURAL CONSTRAINTS: Preserve the existing architecture exactly — same walls, same number of rooms, same room boundaries, same doors and windows. Keep every existing text label unchanged and in place. NEVER split, merge, add, or remove rooms or walls. NEVER convert a room into a different type of room unless explicitly instructed in the details.";

// Noms de code publics des modèles image Google.
const MODEL_LABELS = {
  'gemini-3-pro-image-preview': 'Nano Banana Pro',
  'gemini-2.5-flash-image': 'Nano Banana',
  'gemini-2.0-flash-preview-image-generation': 'Gemini 2.0 Image',
};
const modelLabel = (id) => (id ? (MODEL_LABELS[id] || id) : null);

// === Compression image côté client ===
// Redimensionne à 1600px max + JPEG q=0.85 pour rester sous la limite payload Netlify (~6 MB)
async function compressImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture fichier impossible."));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image invalide."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error("Compression échouée."));
          const compressed = new File([blob], file.name.replace(/\.[^/.]+$/, ".jpg"), { type: 'image/jpeg' });
          resolve(compressed);
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// === Validation + conversion HEIC + compression, partagées pour tout upload ===
async function processUploadedFile(file, label) {
  const isHeic = file.name.toLowerCase().endsWith('.heic');
  if (!file.type.startsWith('image/') && !isHeic) {
    throw new Error(`Format ${label} non supporté. Utilisez JPG, PNG ou HEIC.`);
  }

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_RAW_UPLOAD_MB) {
    throw new Error(`${label} trop volumineux (${sizeMB.toFixed(1)} Mo). Limite : ${MAX_RAW_UPLOAD_MB} Mo.`);
  }

  let fileToProcess = file;
  if (isHeic) {
    if (!window.heic2any) throw new Error(`Impossible de convertir ce fichier HEIC (${label}).`);
    const convertedBlob = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
    const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
    fileToProcess = new File([resultBlob], file.name.replace(/\.[^/.]+$/, ".jpg"), { type: "image/jpeg" });
  }

  return compressImage(fileToProcess);
}

// === Styles prédéfinis par objectif ===
const STYLES_BY_OBJECTIVE = {
  declutter: [
    { id: 'empty-bright', label: 'Vide & lumineux', desc: 'Pièce vidée, murs blancs, lumière naturelle' },
    { id: 'showroom', label: 'Showroom', desc: 'Sol neutre, ambiance neuve, prêt à visiter' },
    { id: 'staging-ready', label: 'Prêt à meubler', desc: 'Espace nettoyé, fond neutre, mise en valeur volume' },
  ],
  furnish: [
    { id: 'scandinave', label: 'Scandinave', desc: 'Bois clair, blanc, lin, plantes vertes' },
    { id: 'tropical', label: 'Tropical chic', desc: 'Rotin, bois exotique, plantes luxuriantes, tons sable' },
    { id: 'contemporain', label: 'Contemporain luxe', desc: 'Lignes pures, marbre, laiton, velours, éclairage design' },
    { id: 'industriel', label: 'Industriel', desc: 'Métal noir, bois brut, briques, ampoules Edison' },
    { id: 'boheme', label: 'Bohème', desc: 'Textiles ethniques, macramé, bois flotté, terracotta' },
    { id: 'mediterraneen', label: 'Méditerranéen', desc: 'Blanc cassé, bleu, terre cuite, lin, céramique' },
  ],
  renovate: [
    { id: 'moderne', label: 'Moderne épuré', desc: 'Cuisine ouverte, sols grand format, peinture mate' },
    { id: 'tropical-chic', label: 'Tropical chic', desc: 'Bois exotique, ventilateurs, persiennes, tons clairs' },
    { id: 'haussmannien', label: 'Haussmannien', desc: 'Moulures, parquet point Hongrie, cheminée marbre' },
    { id: 'loft', label: 'Loft new-yorkais', desc: 'Béton ciré, verrière atelier, métal noir' },
    { id: 'japonais', label: 'Japandi', desc: 'Bois clair, ligne basse, papier de riz, zen' },
    { id: 'colonial', label: 'Colonial créole', desc: 'Bois sombre, persiennes, ventilateurs, charme antillais' },
  ],
  render3d: [
    { id: 'creole-moderne-3d', label: 'Créole moderne', desc: 'Toit pentu, varangue, persiennes, palette tropicale' },
    { id: 'contemporain-3d', label: 'Contemporain', desc: 'Volumes blancs, baies vitrées, toit plat' },
    { id: 'tropical-3d', label: 'Tropical', desc: 'Bois exotique, débords de toit, végétation luxuriante' },
    { id: 'mediterraneen-3d', label: 'Méditerranéen', desc: 'Façade ocre, tuiles, arcades, volets bois' },
  ],
  build: [
    { id: 'villa-contemporaine', label: 'Villa contemporaine', desc: 'Volumes blancs, baies vitrées, toit plat, piscine' },
    { id: 'bois-verre', label: 'Bois & verre', desc: 'Bardage bois, grandes ouvertures, toiture en pente' },
    { id: 'beton-brut', label: 'Béton brut', desc: 'Architecture brutaliste, lignes droites, terrasse plate' },
    { id: 'creole-moderne', label: 'Créole moderne', desc: 'Toit pentu, varangue, persiennes, palette tropicale' },
    { id: 'mediterraneen-build', label: 'Méditerranéen', desc: 'Façade ocre, tuiles, arcades, volets bois' },
  ],
  implant: [
    { id: 'terrain-plat', label: 'Terrain plat', desc: 'Implantation de plain-pied, accès direct, jardin autour' },
    { id: 'terrain-pente', label: 'Terrain en pente', desc: 'Soubassement ou pilotis adaptés au dénivelé du terrain' },
    { id: 'creole-implant', label: 'Créole tropicale', desc: 'Varangue, toit pentu, intégration climat tropical' },
  ],
};

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('interior');
  const [objective, setObjective] = useState('declutter');
  const [styleId, setStyleId] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [originalPreview, setOriginalPreview] = useState(null);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState([]);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [userApiKey, setUserApiKey] = useState(() => localStorage.getItem(LS_KEY) || "");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [variants, setVariants] = useState(null);
  const [selectedVariantIdx, setSelectedVariantIdx] = useState(0);
  const [referenceImages, setReferenceImages] = useState([]);
  const [isConvertingRef, setIsConvertingRef] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawTool, setDrawTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(3);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [planProgress, setPlanProgress] = useState(null);
  const [usedModel, setUsedModel] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  const fileInputRef = useRef(null);
  const refInputRef = useRef(null);
  const zoneDrawRef = useRef(null);

  const effectiveApiKey = userApiKey || GEMINI_API_KEY_DEFAULT;

  const openKeyModal = () => {
    setKeyInput(userApiKey);
    setKeySaved(false);
    setShowKey(false);
    setShowKeyModal(true);
  };

  const saveKey = () => {
    const trimmed = keyInput.trim();
    setUserApiKey(trimmed);
    if (trimmed) localStorage.setItem(LS_KEY, trimmed);
    else localStorage.removeItem(LS_KEY);
    setKeySaved(true);
    setTimeout(() => setShowKeyModal(false), 1200);
  };

  const clearKey = () => {
    setUserApiKey("");
    setKeyInput("");
    localStorage.removeItem(LS_KEY);
    setKeySaved(false);
  };

  useEffect(() => {
    if (!FIREBASE_CONFIGURED) {
      setError("⚙️ Configuration manquante — Ajoutez vos variables d'environnement Firebase dans Netlify (Site settings → Environment variables), puis redéployez.");
      return;
    }
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        signInAnonymously(auth).catch(err => {
          console.error("Erreur connexion anonyme:", err);
          setError("Problème d'initialisation Firebase. Vérifiez vos variables d'environnement.");
        });
      }
    });
    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!user || user.isAnonymous) {
      setHistory([]);
      return;
    }

    const userDesignsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'designs');
    const unsubscribeSnapshot = onSnapshot(userDesignsRef, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const sortedDocs = docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setHistory(sortedDocs);
    }, (err) => {
      console.error("Erreur Firestore (historique):", err);
    });

    return () => unsubscribeSnapshot();
  }, [user]);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      if (document.body && script.parentNode) {
        document.body.removeChild(script);
      }
    };
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Erreur login:", err);
      setError("Erreur de connexion Google. Vérifiez la configuration Firebase.");
    }
  };

  const handleLogout = () => signOut(auth);

  const resetAll = () => {
    setSelectedFile(null);
    setOriginalPreview(null);
    setGeneratedImage(null);
    setPrompt("");
    setStyleId(null);
    setCompareMode(false);
    setVariants(null);
    setSelectedVariantIdx(0);
    setReferenceImages([]);
    setDrawMode(false);
    setHasDrawing(false);
    setUsedModel(null);
    setLightbox(null);
    setPlanProgress(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (refInputRef.current) refInputRef.current.value = "";
  };

  const handleObjectiveChange = (newObj) => {
    setObjective(newObj);
    setStyleId(null);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setGeneratedImage(null);
    setVariants(null);
    setDrawMode(false);
    setHasDrawing(false);
    setError(null);
    setIsConverting(true);

    try {
      const processed = await processUploadedFile(file, "de l'image");
      setSelectedFile(processed);
      const reader = new FileReader();
      reader.onloadend = () => setOriginalPreview(reader.result);
      reader.readAsDataURL(processed);
    } catch (err) {
      console.error("Erreur import image:", err);
      setError(err.message);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setIsConverting(false);
    }
  };

  const handleReferenceChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      if (refInputRef.current) refInputRef.current.value = "";
      return;
    }

    setError(null);
    setIsConvertingRef(true);

    try {
      const label = objective === 'implant' ? 'de la photo du bâtiment' : 'du modèle';
      const processed = await processUploadedFile(file, label);
      const reader = new FileReader();
      reader.onloadend = () => {
        setReferenceImages(prev => [
          ...prev,
          { id: `${Date.now()}-${Math.random()}`, file: processed, preview: reader.result }
        ]);
      };
      reader.readAsDataURL(processed);
    } catch (err) {
      console.error("Erreur import référence:", err);
      setError(err.message);
    } finally {
      setIsConvertingRef(false);
      if (refInputRef.current) refInputRef.current.value = "";
    }
  };

  const removeReferenceImage = (id) => {
    setReferenceImages(prev => prev.filter(r => r.id !== id));
  };

  // === Pipeline plan 2D : analyse -> crop par pièce -> aménagement isolé -> recomposition ===
  // Le modèle ne voit jamais le plan entier : impossible pour lui d'inventer des murs,
  // de vider le salon ou de meubler l'extérieur. Les murs finaux sont ceux du plan source.
  const runFloorplanPipeline = async () => {
    const imageData = originalPreview.split(',')[1];
    const mimeType = selectedFile.type;
    const referenceImagesPayload = referenceImages.map(r => ({
      data: r.preview.split(',')[1],
      mimeType: r.file.type
    }));
    const selectedStyle = (STYLES_BY_OBJECTIVE[objective] || []).find(s => s.id === styleId);
    const styleClause = selectedStyle ? ` Style: ${selectedStyle.label} — ${selectedStyle.desc}.` : "";
    const refClause = referenceImagesPayload.length > 0
      ? " Reference photo(s) are provided: draw inspiration from their materials and color palette only."
      : "";
    const extraDetails = prompt.trim() ? ` Additional details: ${prompt.trim()}.` : "";

    // --- Passe 1 : lecture du plan, boîtes + meubles par pièce ---
    setPlanProgress({ phase: 'analyse', done: 0, total: 0 });
    const ares = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analyze: true, prompt: ANALYZE_ROOMS_PROMPT, mimeType, imageData, userApiKey: userApiKey || undefined })
    });
    const adata = await ares.json();
    if (!ares.ok) throw new Error(adata.error || "Analyse du plan impossible.");

    const allRooms = parseRooms(adata.text);
    // Seules les pièces à meubler passent dans la génération...
    const rooms = allRooms.filter(r => r.furniture);
    if (rooms.length === 0) {
      throw new Error("Aucune pièce détectée sur ce plan. Vérifiez que les pièces sont fermées et étiquetées.");
    }
    // ...mais TOUS les labels sont ré-estampés : le crop d'une pièce déborde sur ses
    // voisines (marge de contexte), donc même le label d'un couloir non meublé peut
    // être abîmé au passage.
    const labelBoxes = allRooms.map(r => r.labelBox).filter(Boolean);

    // --- Découpe des pièces sur le plan source ---
    const baseImg = await loadImage(originalPreview);
    const jobs = [];
    for (const room of rooms) {
      const cropped = cropRoom(baseImg, room.box);
      if (cropped) jobs.push({ room, cropped });
    }
    if (jobs.length === 0) throw new Error("Découpe des pièces impossible (boîtes invalides).");

    setPlanProgress({ phase: 'amenagement', done: 0, total: jobs.length });
    let done = 0;

    // --- Passe 2 : aménagement, une pièce à la fois ---
    const placements = await inBatches(jobs, 3, async ({ room, cropped }) => {
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: furnishRoomPrompt(room.label, room.furniture + extraDetails, styleClause, refClause),
            mimeType: 'image/jpeg',
            imageData: cropped.dataUrl.split(',')[1],
            referenceImages: referenceImagesPayload,
            userApiKey: userApiKey || undefined
          })
        });
        const data = await res.json();
        if (!res.ok || !data.imageData) throw new Error(data.error || "pas d'image");
        if (data.model) setUsedModel(data.model);
        return {
          imageDataUrl: `data:${data.mimeType || 'image/png'};base64,${data.imageData}`,
          crop: cropped.crop,
          core: cropped.core,
        };
      } catch (err) {
        console.error(`Pièce "${room.label}" échouée:`, err);
        return null; // pièce laissée telle quelle dans le plan final
      } finally {
        done += 1;
        setPlanProgress({ phase: 'amenagement', done, total: jobs.length });
      }
    });

    const ok = placements.filter(Boolean);
    if (ok.length === 0) throw new Error("Aucune pièce n'a pu être aménagée.");

    // --- Recomposition sur le plan original (murs intacts, labels ré-estampés) ---
    setPlanProgress({ phase: 'recomposition', done: jobs.length, total: jobs.length });
    const finalImage = await recomposite(originalPreview, ok, labelBoxes);
    setGeneratedImage(finalImage);

    if (ok.length < jobs.length) {
      setError(`${jobs.length - ok.length} pièce(s) sur ${jobs.length} n'ont pas pu être aménagées et sont restées vides.`);
    }

    if (user && !user.isAnonymous) {
      try {
        await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'designs'), {
          before: originalPreview,
          after: finalImage,
          prompt: prompt || "Plan 2D aménagé",
          mode: 'floorplan',
          objective,
          styleId: styleId || null,
          createdAt: serverTimestamp()
        });
      } catch (fireErr) {
        console.error("Erreur sauvegarde Firestore:", fireErr);
      }
    }
  };

  // === Plan 2D -> rendu 3D axonométrique ===
  // La géométrie est d'abord LUE sur le plan (passe 1) puis imposée par écrit au modèle.
  // Sans cette carte il reconstruit une maison plausible mais pas la tienne.
  const runRender3d = async () => {
    const imageData = originalPreview.split(',')[1];
    const mimeType = selectedFile.type;
    const referenceImagesPayload = referenceImages.map(r => ({
      data: r.preview.split(',')[1],
      mimeType: r.file.type
    }));
    const selectedStyle = (STYLES_BY_OBJECTIVE[objective] || []).find(s => s.id === styleId);
    const styleClause = selectedStyle ? ` Architectural style: ${selectedStyle.label} — ${selectedStyle.desc}.` : "";
    const refClause = referenceImagesPayload.length > 0
      ? " Reference photo(s) are provided: draw inspiration from their architectural style, materials and colour palette."
      : "";
    const details = prompt.trim() ? `\n\nAdditional requirements: ${prompt.trim()}` : "";

    // Passe 1 : lecture de la géométrie.
    setPlanProgress({ phase: 'analyse', done: 0, total: 0 });
    let roomsClause = "";
    try {
      const ares = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyze: true, prompt: ANALYZE_ROOMS_PROMPT, mimeType, imageData, userApiKey: userApiKey || undefined })
      });
      const adata = await ares.json();
      if (ares.ok && adata.text) roomsClause = roomMapText(parseRooms(adata.text));
    } catch (err) {
      // Sans la carte le rendu reste possible, simplement moins fidèle : on continue.
      console.error('Lecture du plan échouée, rendu 3D non ancré:', err);
    }

    setPlanProgress(null);
    setVariants(Array.from({ length: VARIANT_COUNT }, () => ({ status: 'pending' })));

    const fullPrompt = render3dPrompt(roomsClause, styleClause, refClause, details);

    const runOne = async (idx) => {
      // Variantes 3D : on fait varier le rendu, jamais la géométrie.
      const angles = [
        '',
        ' Camera: axonometric view from a slightly higher angle, warm afternoon sunlight.',
        ' Camera: axonometric view rotated slightly, bright midday light with soft shadows.',
        ' Camera: axonometric view, golden-hour lighting with long soft shadows.',
      ];
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: fullPrompt + (angles[idx] || ''),
            mimeType, imageData,
            referenceImages: referenceImagesPayload,
            guardrails: 'plan3d',
            userApiKey: userApiKey || undefined
          })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Erreur inconnue');
        if (!result.imageData) throw new Error("L'IA n'a pas retourné d'image.");
        if (result.model) setUsedModel(result.model);
        const img = `data:${result.mimeType || 'image/png'};base64,${result.imageData}`;
        setVariants(v => { if (!v) return v; const n = [...v]; n[idx] = { status: 'done', image: img }; return n; });
        return { idx, image: img };
      } catch (err) {
        console.error(`Erreur variante 3D ${idx}:`, err);
        setVariants(v => { if (!v) return v; const n = [...v]; n[idx] = { status: 'error', error: err.message }; return n; });
        return null;
      }
    };

    const results = await Promise.all(Array.from({ length: VARIANT_COUNT }, (_, i) => runOne(i)));
    const okOnes = results.filter(Boolean);
    if (okOnes.length === 0) throw new Error("Aucun rendu 3D n'a pu être généré.");

    setGeneratedImage(okOnes[0].image);
    setSelectedVariantIdx(okOnes[0].idx);

    if (user && !user.isAnonymous) {
      try {
        await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'designs'), {
          before: originalPreview,
          after: okOnes[0].image,
          prompt: prompt || "Plan 2D → rendu 3D",
          mode: 'floorplan',
          objective: 'render3d',
          styleId: styleId || null,
          createdAt: serverTimestamp()
        });
      } catch (fireErr) {
        console.error("Erreur sauvegarde Firestore:", fireErr);
      }
    }
  };

  const generateTransformation = async () => {
    if (!selectedFile || !originalPreview || !user) {
      setError("Veuillez importer une image avant de générer.");
      return;
    }

    if (!effectiveApiKey) {
      setError("Clé API Gemini manquante. Cliquez sur l'icône clé 🔑 pour saisir votre clé Google AI Studio.");
      return;
    }

    if (objective === 'implant' && referenceImages.length === 0) {
      setError("Veuillez importer au moins une photo du bâtiment à implanter (étape 2) avant de générer.");
      return;
    }

    // Plan 2D + aménager/rénover : pipeline pièce par pièce (pas de variantes — 1 appel
    // par pièce, x4 variantes exploserait le quota).
    // Plan 2D + vue 3D : chemin dédié, sans les garde-fous photo (qui interdiraient
    // justement le changement de point de vue).
    if (mode === 'floorplan' && (objective === 'furnish' || objective === 'renovate' || objective === 'render3d')) {
      setIsGenerating(true);
      setError(null);
      setGeneratedImage(null);
      setVariants(null);
      setSelectedVariantIdx(0);
      try {
        if (objective === 'render3d') await runRender3d();
        else await runFloorplanPipeline();
      } catch (err) {
        console.error("Erreur plan 2D:", err);
        setError(`Erreur : ${err.message}`);
      } finally {
        setPlanProgress(null);
        setIsGenerating(false);
      }
      return;
    }

    setIsGenerating(true);
    setError(null);
    setGeneratedImage(null);
    setVariants(Array.from({ length: VARIANT_COUNT }, () => ({ status: 'pending' })));
    setSelectedVariantIdx(0);

    let defaultDetail = "";
    if (!prompt.trim()) {
      if (objective === 'declutter') defaultDetail = "Completely empty and clean room, no furniture, minimalistic white space.";
      else if (objective === 'furnish') defaultDetail = "Modern, elegant and cozy professional furniture staging.";
      else if (objective === 'renovate') defaultDetail = "Modern renovation with high-end materials.";
      else if (objective === 'build') defaultDetail = "Architectural building extension with modern glass and concrete.";
      else if (objective === 'implant') defaultDetail = "Natural, realistic on-site integration of the building onto the plot, matching perspective, scale and lighting.";
    }

    let objectiveInstruction = "";
    switch(objective) {
      case 'declutter':
        objectiveInstruction = "CLEANING AND DECLUTTERING TASK: Remove all existing furniture, boxes, trash, and non-essential objects. Make the space look perfectly clean and empty.";
        break;
      case 'furnish':
        objectiveInstruction = "VIRTUAL STAGING TASK: Add stylish, modern furniture to the empty areas. Create a professional and welcoming layout, without modifying the existing room structure.";
        break;
      case 'build':
        objectiveInstruction = "CONSTRUCTION TASK: Modify or replace the structure of the existing buildings. Add new architectural elements based on the original structure.";
        break;
      case 'implant':
        objectiveInstruction = "SITE PLACEMENT TASK: Insert the exact building(s)/structure(s) shown in the reference photo(s) onto the land or terrain shown in IMAGE 1. Preserve their architecture, proportions and materials exactly as shown in the reference photos — do not redesign them. Adjust only perspective, scale, lighting and shadows so each structure blends naturally and realistically onto the terrain, as if photographed on site.";
        break;
      default:
        objectiveInstruction = "RENOVATION TASK: Update materials and style while keeping the existing structure. Replace floors, paint walls, update light fixtures.";
    }

    // Plan 2D : un plan n'est pas une photo — le dire évite que le modèle le réinterprète.
    // (Mode Plan 2D + Vider passe ici ; Aménager/Rénover partent dans le pipeline dédié.)
    if (mode === 'floorplan') {
      objectiveInstruction = "2D FLOOR PLAN TASK: This is a top-down 2D architectural floor plan. Remove any furniture symbols and leave each room empty. Keep the top-down orthographic view.";
    }

    // Verrou structurel pour aménager/rénover (pas pour vider ni construire/implanter).
    const lockClause = (objective === 'furnish' || objective === 'renovate') ? STRUCTURE_LOCK : "";

    const contextPrefix = mode === 'floorplan'
      ? "Top-down 2D architectural floor plan (blueprint) with labeled rooms, viewed strictly from above"
      : mode === 'interior' ? "Interior room photo" : "Exterior landscape and architecture photo";
    const finalDetails = prompt.trim() || defaultDetail;
    const selectedStyle = (STYLES_BY_OBJECTIVE[objective] || []).find(s => s.id === styleId);
    const styleClause = selectedStyle ? ` Style: ${selectedStyle.label} — ${selectedStyle.desc}.` : "";

    const imageData = originalPreview.split(',')[1];
    const mimeType = selectedFile.type;
    const referenceImagesPayload = referenceImages.map(r => ({
      data: r.preview.split(',')[1],
      mimeType: r.file.type
    }));
    const refClause = referenceImagesPayload.length > 0
      ? (objective === 'implant'
          ? " Additional reference photo(s) show the exact building(s)/structure(s) to insert onto the terrain in IMAGE 1: reproduce their architecture, proportions and materials precisely without redesigning them, only adapting perspective, scale, lighting and shadows so they blend naturally and realistically onto the terrain, as if photographed on site."
          : " Additional reference photo(s) are provided: draw inspiration from their mood, materials, furniture style and color palette, applying them to IMAGE 1 without copying their structure or objects.")
      : "";

    // Zone cible dessinée à la main : on envoie une copie annotée de la photo
    // et on restreint la transformation à l'intérieur du tracé rouge.
    let zoneImagePayload = null;
    if (hasDrawing && zoneDrawRef.current && !zoneDrawRef.current.isEmpty()) {
      try {
        const annotated = await zoneDrawRef.current.exportComposite();
        if (annotated) zoneImagePayload = { data: annotated.split(',')[1], mimeType: 'image/jpeg' };
      } catch (zoneErr) {
        console.error("Erreur export zone dessinée:", zoneErr);
      }
    }
    const zoneClause = zoneImagePayload
      ? " A TARGET ZONE has been hand-drawn in red on the annotated copy of the source photo: apply the requested modification ONLY inside that red zone. Everything outside the zone must remain strictly identical to IMAGE 1. Never reproduce the red strokes or markings in the output."
      : "";

    const isFloorplan = mode === 'floorplan';

    const runVariant = async (idx) => {
      // Plan 2D : pas de hints déco (varier = risque de dériver la structure du plan).
      const hint = isFloorplan ? '' : (VARIANT_HINTS[idx] || '');
      const preservation = " STRICT PRESERVATION: Keep the exact same framing, angle, zoom and aspect ratio as IMAGE 1 and show the FULL original scene — never crop, zoom in or make the terrain and its surroundings (neighbouring houses, vegetation, roads, sky) disappear. Change ONLY what is requested; do not invent or add anything that was not asked for (no extra garage, floor, extension, pool or building).";
      const renderClause = isFloorplan
        ? " Rendering: clean flat 2D top-down floor-plan style, orthographic, crisp lines."
        : " Photography: Professional architectural style, 8k, sharp focus.";
      const fullPrompt = `${objectiveInstruction}. Context: ${contextPrefix}.${styleClause}${refClause}${zoneClause} Design details: ${finalDetails}.${hint}${lockClause}${preservation}${renderClause} Output: ONLY the transformed image, without text.`;
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: fullPrompt, mimeType, imageData, referenceImages: referenceImagesPayload, zoneImage: zoneImagePayload || undefined, userApiKey: userApiKey || undefined })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Erreur inconnue');
        if (!result.imageData) throw new Error("L'IA n'a pas retourné d'image.");
        if (result.model) setUsedModel(result.model);
        const img = `data:${result.mimeType || 'image/png'};base64,${result.imageData}`;
        setVariants(v => {
          if (!v) return v;
          const next = [...v];
          next[idx] = { status: 'done', image: img };
          return next;
        });
        return { idx, image: img };
      } catch (err) {
        console.error(`Erreur variante ${idx}:`, err);
        setVariants(v => {
          if (!v) return v;
          const next = [...v];
          next[idx] = { status: 'error', error: err.message };
          return next;
        });
        return null;
      }
    };

    try {
      const results = await Promise.all(
        Array.from({ length: VARIANT_COUNT }, (_, i) => runVariant(i))
      );
      const successes = results.filter(Boolean);

      if (successes.length === 0) {
        setError("Aucune variante n'a pu être générée. Vérifiez votre clé API ou réessayez.");
        return;
      }

      const first = successes[0];
      setGeneratedImage(first.image);
      setSelectedVariantIdx(first.idx);

      if (user && !user.isAnonymous) {
        try {
          await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'designs'), {
            before: originalPreview,
            after: first.image,
            prompt: prompt || "Auto-généré",
            mode,
            objective,
            styleId: styleId || null,
            createdAt: serverTimestamp()
          });
        } catch (fireErr) {
          console.error("Erreur sauvegarde Firestore:", fireErr);
        }
      } else {
        setError("Variantes générées ! Connectez-vous via Google pour sauvegarder dans votre historique.");
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const selectVariant = (idx) => {
    if (!variants || !variants[idx] || variants[idx].status !== 'done') return;
    setSelectedVariantIdx(idx);
    setGeneratedImage(variants[idx].image);
  };

  const downloadFile = () => {
    if (!generatedImage) return;
    const fileName = `rendu-${objective}-${Date.now()}.jpg`;
    const link = document.createElement('a');
    link.href = generatedImage;
    link.download = fileName;
    link.click();
  };

  // `modes` restreint une action aux modes où elle a un sens : proposer "Implanter" sur
  // un plan 2D ou "Vue 3D" sur une photo n'aboutit qu'à des consignes contradictoires.
  const ALL_OBJECTIVES = [
    { id: 'declutter', label: 'Nettoyer / Vider', icon: <Eraser className="w-3 h-3" />, desc: 'Supprime les objets' },
    { id: 'furnish', label: 'Aménager', icon: <Layout className="w-3 h-3" />, desc: 'Ajoute des meubles' },
    { id: 'renovate', label: 'Rénover', icon: <Brush className="w-3 h-3" />, desc: 'Changer le style' },
    { id: 'build', label: 'Construire', icon: <Hammer className="w-3 h-3" />, desc: 'Nouveau bâtiment', modes: ['interior', 'exterior'] },
    { id: 'implant', label: 'Implanter', icon: <MapPin className="w-3 h-3" />, desc: 'Poser un bâtiment sur un terrain', modes: ['interior', 'exterior'] },
    { id: 'render3d', label: 'Vue 3D', icon: <Boxes className="w-3 h-3" />, desc: 'Plan 2D → maison en volume', modes: ['floorplan'] },
  ];
  const objectiveOptions = ALL_OBJECTIVES.filter(o => !o.modes || o.modes.includes(mode));

  // Si l'action courante n'existe pas dans le nouveau mode, on retombe sur une action valide.
  useEffect(() => {
    if (!objectiveOptions.some(o => o.id === objective)) {
      setObjective(mode === 'floorplan' ? 'furnish' : 'declutter');
      setStyleId(null);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 font-sans pb-20">
      <div className="max-w-7xl mx-auto px-4 md:px-8 pt-6 space-y-6">

        <header className="flex flex-col md:flex-row items-center justify-between gap-6 bg-white p-5 rounded-[2.5rem] shadow-sm border border-slate-100">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg shadow-indigo-200">
              <Home className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 leading-tight tracking-tight">
                HomeStaging <span className="text-indigo-600 italic">PRO</span>
              </h1>
              <div className="flex flex-col gap-0.5">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  <Lock className="w-3 h-3 text-green-500" /> Session Privée Gemini
                  <span className="text-[8px] font-semibold text-slate-300 normal-case tracking-normal whitespace-nowrap">
                    v{__APP_VERSION__} — MAJ {__APP_UPDATED__}
                  </span>
                </p>
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-tighter">
                  OPTIMMO DOM — 483 Av. Victor Coridun, 97200 Fort-de-France — 0696 93 80 99
                </p>
              </div>
            </div>
          </div>

          <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200">
            <button
              onClick={() => setMode('interior')}
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-black transition-all ${mode === 'interior' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}
            >
              <Sofa className="w-4 h-4" /> Intérieur
            </button>
            <button
              onClick={() => setMode('exterior')}
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-black transition-all ${mode === 'exterior' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}
            >
              <TreePine className="w-4 h-4" /> Extérieur
            </button>
            <button
              onClick={() => setMode('floorplan')}
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-black transition-all ${mode === 'floorplan' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}
            >
              <Map className="w-4 h-4" /> Plan 2D
            </button>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={resetAll}
              className="flex items-center gap-2 text-[10px] font-bold text-slate-500 hover:text-indigo-600 px-4 py-2 rounded-xl transition-colors"
            >
              <RefreshCcw className="w-4 h-4" /> Reset
            </button>
            <button
              onClick={openKeyModal}
              title="Configurer la clé API Gemini"
              className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-2 rounded-xl transition-colors border ${
                userApiKey
                  ? 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100'
                  : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              {userApiKey ? 'Clé active' : 'Clé API'}
            </button>
            <a
              href="https://aistudio.google.com/usage"
              target="_blank"
              rel="noopener noreferrer"
              title="Voir mon coût réel sur Google AI Studio"
              className="flex items-center gap-1.5 text-[10px] font-bold px-3 py-2 rounded-xl transition-colors border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Coût AI Studio
            </a>
            {user && !user.isAnonymous ? (
              <div className="flex items-center gap-3 bg-slate-50 p-1.5 pr-4 rounded-2xl border border-slate-100">
                {user.photoURL ? (
                  <img src={user.photoURL} className="w-9 h-9 rounded-xl border-2 border-white shadow-sm" alt="Profil" />
                ) : (
                  <div className="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600 font-bold text-xs">
                    {user.displayName?.charAt(0) || 'U'}
                  </div>
                )}
                <p className="text-[10px] font-black text-slate-700 hidden sm:block">{user.displayName}</p>
                <button onClick={handleLogout} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                className="flex items-center gap-2 bg-slate-900 text-white px-5 py-2.5 rounded-2xl text-xs font-bold hover:bg-black transition-all shadow-lg"
              >
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/pwaa2/google.svg" className="w-4 h-4" alt="Google" />
                Se connecter
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-2xl flex items-center gap-3 text-xs font-bold">
            <AlertCircle className="w-5 h-5 flex-shrink-0" /> {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">

            <section className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">1. Photo à traiter</h3>
                {originalPreview && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => { setDrawMode(v => !v); setDrawTool('brush'); }}
                      className={`flex items-center gap-1 text-[9px] font-bold uppercase tracking-tighter transition-colors ${
                        drawMode ? 'text-indigo-600' : hasDrawing ? 'text-red-500 hover:text-red-600' : 'text-slate-400 hover:text-indigo-600'
                      }`}
                    >
                      <Pencil className="w-3 h-3" />
                      {drawMode ? 'Terminer' : hasDrawing ? 'Modifier la zone' : 'Dessiner la zone'}
                    </button>
                    <button onClick={resetAll} className="text-[9px] font-bold text-red-400 hover:text-red-600 uppercase tracking-tighter transition-colors">
                      Supprimer
                    </button>
                  </div>
                )}
              </div>

              <div>
                {drawMode && originalPreview && (
                  <div className="flex items-center justify-center gap-1 mb-2 bg-slate-100 border border-slate-200 rounded-xl p-1.5">
                    <button
                      onClick={() => setDrawTool('brush')}
                      title="Stylet"
                      className={`p-1.5 rounded-lg transition-colors ${drawTool === 'brush' ? 'bg-red-500 text-white' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDrawTool('eraser')}
                      title="Gomme"
                      className={`p-1.5 rounded-lg transition-colors ${drawTool === 'eraser' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                      <Eraser className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-4 bg-slate-300 mx-1" />
                    {[
                      { px: 3, dot: 'w-[4px] h-[4px]', label: 'Trait fin' },
                      { px: 8, dot: 'w-[7px] h-[7px]', label: 'Trait moyen' },
                      { px: 16, dot: 'w-[11px] h-[11px]', label: 'Trait épais' },
                    ].map(s => (
                      <button
                        key={s.px}
                        onClick={() => setBrushSize(s.px)}
                        title={s.label}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                          brushSize === s.px ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        <span className={`${s.dot} rounded-full bg-current`} />
                      </button>
                    ))}
                    <div className="w-px h-4 bg-slate-300 mx-1" />
                    <button
                      onClick={() => zoneDrawRef.current?.undo()}
                      title="Annuler le dernier trait"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 transition-colors"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => zoneDrawRef.current?.clear()}
                      title="Tout effacer"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-4 bg-slate-300 mx-1" />
                    <button
                      onClick={() => setDrawMode(false)}
                      title="Terminer le dessin"
                      className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 transition-colors"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <div
                  onClick={() => { if (!drawMode) fileInputRef.current?.click(); }}
                  className={`relative aspect-video rounded-3xl border-2 overflow-hidden transition-all bg-slate-50 group ${
                    drawMode
                      ? 'border-indigo-400'
                      : 'border-dashed border-slate-200 cursor-pointer hover:border-indigo-400'
                  }`}
                >
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*,.heic" />
                  {isConverting ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-2" />
                      <p className="text-[10px] font-bold uppercase">Traitement...</p>
                    </div>
                  ) : originalPreview ? (
                    <>
                      <img
                        src={originalPreview}
                        className={`w-full h-full ${drawMode || hasDrawing ? 'object-contain' : 'object-cover'}`}
                        alt="Original"
                      />
                      <ZoneDraw
                        ref={zoneDrawRef}
                        src={originalPreview}
                        active={drawMode}
                        tool={drawTool}
                        brushSize={brushSize}
                        onChange={setHasDrawing}
                      />
                    </>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 group-hover:text-indigo-500">
                      <Upload className="w-8 h-8 mb-2" />
                      <p className="text-xs font-bold">Importer un fichier</p>
                      <p className="text-[10px] text-slate-300 mt-1">JPG, PNG, HEIC supportés</p>
                    </div>
                  )}
                </div>
                {drawMode && (
                  <p className="text-[9px] text-indigo-500 font-bold mt-2">
                    ✏️ Entourez ou surlignez la zone à modifier — au stylet, au doigt ou à la souris.
                  </p>
                )}
                {!drawMode && hasDrawing && (
                  <p className="text-[9px] text-red-500 font-bold mt-2">
                    🎯 Zone cible définie — l'IA appliquera la transformation uniquement dans la zone rouge.
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">
                    {objective === 'implant' ? '2. Bâtiment(s) à implanter' : "2. Modèle(s) d'inspiration (Optionnel)"}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-bold text-slate-300">{referenceImages.length}/{MAX_REFERENCE_IMAGES}</span>
                    {referenceImages.length > 0 && (
                      <button onClick={() => setReferenceImages([])} className="text-[9px] font-bold text-red-400 hover:text-red-600 uppercase tracking-tighter transition-colors">
                        Tout retirer
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {referenceImages.map(ref => (
                    <div key={ref.id} className="relative h-20 rounded-2xl overflow-hidden border border-slate-100 group">
                      <img src={ref.preview} className="w-full h-full object-cover" alt="Référence" />
                      <button
                        onClick={() => removeReferenceImage(ref.id)}
                        className="absolute top-1 right-1 p-1 bg-black/60 rounded-lg text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {referenceImages.length < MAX_REFERENCE_IMAGES && (
                    <div
                      onClick={() => refInputRef.current?.click()}
                      className="relative h-20 rounded-2xl border-2 border-dashed border-slate-200 overflow-hidden cursor-pointer hover:border-indigo-400 transition-all bg-slate-50 group flex items-center justify-center"
                    >
                      <input type="file" ref={refInputRef} onChange={handleReferenceChange} className="hidden" accept="image/*,.heic" />
                      {isConvertingRef ? (
                        <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                      ) : (
                        <div className="flex flex-col items-center text-slate-400 group-hover:text-indigo-500">
                          <ImageIcon className="w-4 h-4 mb-1" />
                          <p className="text-[8px] font-bold uppercase">Ajouter</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <p className="text-[9px] text-slate-300 mt-2">
                  {objective === 'implant'
                    ? "Importez la ou les photos du bâtiment (façade, plan) à positionner naturellement sur le terrain de la photo 1."
                    : "L'IA s'inspire de leur style, ambiance et couleurs, sans copier leur structure."}
                </p>
              </div>

              <div>
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-3">3. Action souhaitée</h3>
                <div className="grid grid-cols-2 gap-2">
                  {objectiveOptions.map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => handleObjectiveChange(opt.id)}
                      className={`flex flex-col items-start p-3 rounded-2xl border transition-all text-left ${
                        objective === opt.id
                          ? 'bg-indigo-50 border-indigo-200 ring-1 ring-indigo-200'
                          : 'bg-slate-50 border-slate-100 hover:border-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={objective === opt.id ? 'text-indigo-600' : 'text-slate-400'}>{opt.icon}</span>
                        <span className={`text-[10px] font-bold uppercase ${objective === opt.id ? 'text-indigo-700' : 'text-slate-500'}`}>
                          {opt.label}
                        </span>
                      </div>
                      <span className="text-[9px] text-slate-400 leading-tight">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">4. Style (Optionnel)</h3>
                  {styleId && (
                    <button
                      onClick={() => setStyleId(null)}
                      className="text-[9px] font-bold text-slate-400 hover:text-red-500 uppercase tracking-tighter transition-colors"
                    >
                      Effacer
                    </button>
                  )}
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 custom-scrollbar">
                  {(STYLES_BY_OBJECTIVE[objective] || []).map(s => (
                    <button
                      key={s.id}
                      onClick={() => setStyleId(s.id === styleId ? null : s.id)}
                      title={s.desc}
                      className={`flex-shrink-0 px-3 py-2 rounded-2xl border transition-all text-[10px] font-bold uppercase tracking-tight whitespace-nowrap ${
                        styleId === s.id
                          ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                          : 'bg-slate-50 border-slate-100 text-slate-500 hover:border-indigo-200 hover:text-indigo-600'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">5. Précisions (Optionnel)</h3>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  className="w-full h-20 p-4 bg-slate-50 border border-slate-100 rounded-2xl text-xs outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none transition-shadow"
                  placeholder={
                    objective === 'declutter'
                      ? "Laisser vide pour vider entièrement la pièce..."
                      : "Ex: Parquet en chêne, style industriel, tons chauds..."
                  }
                />
                <button
                  onClick={generateTransformation}
                  disabled={isGenerating || !originalPreview || !user}
                  className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg shadow-indigo-100 flex items-center justify-center gap-3 hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                >
                  {isGenerating
                    ? <><Loader2 className="animate-spin w-5 h-5" /> Génération en cours...</>
                    : <><Sparkles className="w-5 h-5" /> Générer le rendu ✨</>
                  }
                </button>
              </div>
            </section>

            <section className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 flex flex-col self-start w-full">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Résultat IA</h3>
                  {usedModel && (
                    <span
                      title={usedModel}
                      className="px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-[8px] font-black uppercase tracking-tighter text-amber-700"
                    >
                      🍌 {modelLabel(usedModel)}
                    </span>
                  )}
                </div>
                {generatedImage && (
                  <div className="flex items-center gap-2">
                    {originalPreview && (
                      <button
                        onClick={() => setCompareMode(v => !v)}
                        title={compareMode ? "Vue normale" : "Comparer avant/après"}
                        className={`flex items-center gap-2 text-[10px] font-bold px-3 py-1.5 rounded-lg transition-colors border ${
                          compareMode
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-slate-50 text-slate-500 border-slate-100 hover:bg-slate-100'
                        }`}
                      >
                        <SplitSquareHorizontal className="w-3 h-3" /> Comparer
                      </button>
                    )}
                    <button
                      onClick={downloadFile}
                      className="flex items-center gap-2 text-[10px] font-bold text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors"
                    >
                      <Download className="w-3 h-3" /> Télécharger
                    </button>
                  </div>
                )}
              </div>
              <div className="w-full aspect-video rounded-3xl bg-slate-50 overflow-hidden border border-slate-100 flex items-center justify-center relative shadow-inner">
                {isGenerating ? (
                  <div className="text-center p-8">
                    <div className="relative inline-block mb-4">
                      <div className="w-16 h-16 border-4 border-indigo-50 border-t-indigo-600 rounded-full animate-spin"></div>
                      <Boxes className="absolute inset-0 m-auto w-6 h-6 text-indigo-600 animate-pulse" />
                    </div>
                    <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase">
                      {planProgress
                        ? planProgress.phase === 'analyse'
                          ? 'Lecture du plan...'
                          : planProgress.phase === 'recomposition'
                            ? 'Recomposition du plan...'
                            : `Aménagement ${planProgress.done}/${planProgress.total} pièces...`
                        : 'Analyse des pixels...'}
                    </p>
                  </div>
                ) : generatedImage ? (
                  compareMode && originalPreview ? (
                    <>
                      <CompareSlider before={originalPreview} after={generatedImage} />
                      <button
                        onClick={() => setLightbox(generatedImage)}
                        title="Plein écran"
                        className="absolute bottom-3 right-3 z-10 p-2 rounded-xl bg-black/60 backdrop-blur-md text-white hover:bg-black/80 transition-colors"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setLightbox(generatedImage)}
                      title="Cliquer pour agrandir"
                      className="w-full h-full flex items-center justify-center group/zoom cursor-zoom-in"
                    >
                      <img src={generatedImage} className="max-w-full max-h-full w-auto h-auto object-contain" alt="Rendu IA" />
                      <span className="absolute bottom-3 right-3 p-2 rounded-xl bg-black/60 backdrop-blur-md text-white opacity-0 group-hover/zoom:opacity-100 transition-opacity">
                        <Maximize2 className="w-4 h-4" />
                      </span>
                    </button>
                  )
                ) : (
                  <div className="text-center text-slate-300 p-10">
                    <ImageIcon className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-xs font-bold italic opacity-40">Votre projet s'affichera ici</p>
                  </div>
                )}
              </div>
              {variants && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">
                      Variantes ({variants.filter(v => v?.status === 'done').length}/{VARIANT_COUNT})
                    </p>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {variants.map((v, idx) => {
                      const isSelected = idx === selectedVariantIdx && v?.status === 'done';
                      return (
                        <button
                          key={idx}
                          onClick={() => selectVariant(idx)}
                          disabled={v?.status !== 'done'}
                          title={v?.status === 'error' ? v.error : `Variante ${idx + 1}`}
                          className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all ${
                            isSelected
                              ? 'border-indigo-600 ring-2 ring-indigo-200'
                              : 'border-slate-100 hover:border-indigo-300'
                          } ${v?.status !== 'done' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          {v?.status === 'done' && (
                            <img src={v.image} className="w-full h-full object-cover" alt={`Variante ${idx + 1}`} />
                          )}
                          {v?.status === 'pending' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
                              <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                            </div>
                          )}
                          {v?.status === 'error' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-red-50">
                              <AlertCircle className="w-4 h-4 text-red-400" />
                            </div>
                          )}
                          <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded text-[7px] font-black uppercase text-white tracking-tighter">
                            {idx + 1}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {generatedImage && (
                <button
                  onClick={resetAll}
                  className="mt-4 w-full py-3 border-2 border-dashed border-slate-100 rounded-2xl text-[10px] font-black uppercase text-slate-400 hover:bg-slate-50 hover:text-indigo-500 hover:border-indigo-100 transition-all flex items-center justify-center gap-2"
                >
                  <PlusCircle className="w-4 h-4" /> Nouveau Projet
                </button>
              )}
            </section>
          </div>

          <div className="lg:col-span-4">
            <section className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 flex flex-col h-full max-h-[750px]">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-[10px] font-black uppercase text-slate-400 flex items-center gap-2 tracking-widest">
                  <History className="w-4 h-4 text-indigo-500" /> Bibliothèque Privée
                </h3>
                <span className="text-[10px] font-bold text-slate-300 bg-slate-50 px-2 py-0.5 rounded-md">{history.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-6 pr-2 custom-scrollbar">
                {!user || user.isAnonymous ? (
                  <div className="py-20 text-center px-4">
                    <Lock className="w-10 h-10 text-slate-100 mx-auto mb-4 opacity-30" />
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
                      Historique réservé<br/>aux membres connectés (Google)
                    </p>
                  </div>
                ) : history.length === 0 ? (
                  <div className="py-20 text-center text-slate-300 text-[10px] italic">
                    Aucun rendu enregistré dans votre historique cloud.
                  </div>
                ) : history.map(item => (
                  <div key={item.id} className="space-y-2">
                    <div
                      onClick={() => {
                        setGeneratedImage(item.after);
                        setOriginalPreview(item.before);
                        setPrompt(item.prompt === "Auto-généré" ? "" : item.prompt);
                        setMode(item.mode || 'interior');
                        setObjective(item.objective || 'declutter');
                        setStyleId(item.styleId || null);
                        setVariants(null);
                        setSelectedVariantIdx(0);
                        setSelectedFile({ type: 'image/jpeg' });
                        setReferenceImages([]);
                        setError(null);
                      }}
                      className="relative rounded-2xl overflow-hidden border border-slate-100 cursor-pointer shadow-sm hover:shadow-lg hover:border-indigo-200 transition-all active:scale-[0.98]"
                    >
                      <img src={item.after} className="w-full aspect-video object-cover" alt="Rendu sauvegardé" />
                      <div className="absolute bottom-2 right-2 flex gap-1">
                        <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md rounded text-[7px] font-black uppercase text-white tracking-tighter">
                          {item.mode === 'interior' ? 'INT' : 'EXT'}
                        </span>
                        <span className="px-2 py-0.5 bg-indigo-600/80 backdrop-blur-md rounded text-[7px] font-black uppercase text-white tracking-tighter">
                          {objectiveOptions.find(o => o.id === item.objective)?.label || item.objective}
                        </span>
                      </div>
                    </div>
                    <p className="text-[9px] text-slate-400 italic line-clamp-2">"{item.prompt}"</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #E2E8F0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #CBD5E1; }
      `}</style>

      {lightbox && (
        <Lightbox
          src={lightbox}
          alt="Aperçu plein écran"
          onClose={() => setLightbox(null)}
          onDownload={lightbox === generatedImage ? downloadFile : undefined}
        />
      )}

      {showKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={() => setShowKeyModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8 space-y-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-indigo-50 rounded-2xl">
                  <KeyRound className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Clé API Gemini</h2>
                  <p className="text-[10px] text-slate-400">Google AI Studio — par compte</p>
                </div>
              </div>
              <button onClick={() => setShowKeyModal(false)} className="p-2 text-slate-300 hover:text-slate-500 rounded-xl transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 space-y-1">
              <p className="text-[10px] font-black text-amber-700 uppercase tracking-wider">Comment obtenir une clé ?</p>
              <p className="text-[10px] text-amber-600 leading-relaxed">
                1. Allez sur <span className="font-bold">aistudio.google.com</span><br/>
                2. Connectez-vous avec le compte Google souhaité<br/>
                3. Cliquez sur <span className="font-bold">Get API key</span> → <span className="font-bold">Create API key</span><br/>
                4. Copiez et collez la clé ci-dessous
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Votre clé API</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? "text" : "password"}
                    value={keyInput}
                    onChange={e => { setKeyInput(e.target.value); setKeySaved(false); }}
                    placeholder="AIzaSy..."
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-mono outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-300 transition-all pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              {userApiKey && (
                <p className="text-[10px] text-slate-400">
                  Clé active : <span className="font-mono font-bold">...{userApiKey.slice(-6)}</span>
                  <button onClick={clearKey} className="ml-2 text-red-400 hover:text-red-600 font-bold underline">Supprimer</button>
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowKeyModal(false)}
                className="flex-1 py-3 border border-slate-200 rounded-2xl text-xs font-bold text-slate-500 hover:bg-slate-50 transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={saveKey}
                disabled={!keyInput.trim()}
                className="flex-1 py-3 bg-indigo-600 text-white rounded-2xl text-xs font-bold hover:bg-indigo-700 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {keySaved ? <><CheckCircle2 className="w-4 h-4" /> Enregistré !</> : 'Enregistrer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
