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
  Eraser, Layout, Hammer, Boxes, PlusCircle, RefreshCcw
} from 'lucide-react';

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
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('interior');
  const [objective, setObjective] = useState('declutter');
  const [selectedFile, setSelectedFile] = useState(null);
  const [originalPreview, setOriginalPreview] = useState(null);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState([]);

  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!FIREBASE_CONFIGURED) {
      setError("⚙️ Configuration manquante — Ajoutez vos variables d'environnement Firebase et Gemini dans Vercel (Settings → Environment Variables), puis redéployez.");
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
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setGeneratedImage(null);
    setError(null);

    const isHeic = file.name.toLowerCase().endsWith('.heic');
    if (!file.type.startsWith('image/') && !isHeic) {
      setError("Format d'image non supporté.");
      return;
    }

    setIsConverting(isHeic);
    let fileToProcess = file;

    if (isHeic) {
      try {
        if (!window.heic2any) throw new Error("Script heic2any non chargé.");
        const convertedBlob = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
        const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
        fileToProcess = new File([resultBlob], file.name.replace(/\.[^/.]+$/, ".jpg"), { type: "image/jpeg" });
      } catch (err) {
        console.error("Erreur conversion HEIC:", err);
        setError("Impossible de convertir ce fichier HEIC.");
        setIsConverting(false);
        return;
      }
      setIsConverting(false);
    }

    setSelectedFile(fileToProcess);
    const reader = new FileReader();
    reader.onloadend = () => setOriginalPreview(reader.result);
    reader.readAsDataURL(fileToProcess);
  };

  const generateTransformation = async () => {
    if (!selectedFile || !originalPreview || !user) {
      setError("Veuillez importer une image avant de générer.");
      return;
    }

    if (!GEMINI_API_KEY) {
      setError("Clé API Gemini manquante. Configurez VITE_GEMINI_API_KEY dans votre fichier .env.");
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}`;

      let defaultDetail = "";
      if (!prompt.trim()) {
        if (objective === 'declutter') defaultDetail = "Completely empty and clean room, no furniture, minimalistic white space.";
        else if (objective === 'furnish') defaultDetail = "Modern, elegant and cozy professional furniture staging.";
        else if (objective === 'renovate') defaultDetail = "Modern renovation with high-end materials.";
        else if (objective === 'build') defaultDetail = "Architectural building extension with modern glass and concrete.";
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
        default:
          objectiveInstruction = "RENOVATION TASK: Update materials and style while keeping the existing structure. Replace floors, paint walls, update light fixtures.";
      }

      const contextPrefix = mode === 'interior' ? "Interior room photo" : "Exterior landscape and architecture photo";
      const finalDetails = prompt.trim() || defaultDetail;

      const fullPrompt = `${objectiveInstruction}. Context: ${contextPrefix}. Design details: ${finalDetails}. Photography: Professional architectural style, 8k, sharp focus. Output: ONLY the transformed image, without text.`;

      const payload = {
        contents: [{
          parts: [
            { text: fullPrompt },
            { inlineData: { mimeType: selectedFile.type, data: originalPreview.split(',')[1] } }
          ]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorData = await res.json();
        console.error("Erreur API Gemini:", errorData);
        const detail = errorData?.error?.message || "Erreur inconnue";
        throw new Error(`Erreur API Gemini : ${detail}`);
      }

      const result = await res.json();
      const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

      if (imagePart?.inlineData?.data) {
        const newImg = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
        setGeneratedImage(newImg);

        if (user && !user.isAnonymous) {
          try {
            await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'designs'), {
              before: originalPreview,
              after: newImg,
              prompt: prompt || "Auto-généré",
              mode: mode,
              objective: objective,
              createdAt: serverTimestamp()
            });
          } catch (fireErr) {
            console.error("Erreur sauvegarde Firestore:", fireErr);
          }
        } else {
          setError("Image générée ! Connectez-vous via Google pour sauvegarder dans votre historique.");
        }
      } else {
        throw new Error("L'IA n'a pas retourné d'image valide.");
      }
    } catch (err) {
      console.error("Erreur génération:", err);
      setError("Erreur lors de la génération. Veuillez réessayer.");
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadFile = () => {
    if (!generatedImage) return;
    const fileName = `rendu-${objective}-${Date.now()}.jpg`;
    const link = document.createElement('a');
    link.href = generatedImage;
    link.download = fileName;
    link.click();
  };

  const objectiveOptions = [
    { id: 'declutter', label: 'Nettoyer / Vider', icon: <Eraser className="w-3 h-3" />, desc: 'Supprime les objets' },
    { id: 'furnish', label: 'Aménager', icon: <Layout className="w-3 h-3" />, desc: 'Ajoute des meubles' },
    { id: 'renovate', label: 'Rénover', icon: <Brush className="w-3 h-3" />, desc: 'Changer le style' },
    { id: 'build', label: 'Construire', icon: <Hammer className="w-3 h-3" />, desc: 'Nouveau bâtiment' },
  ];

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
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={resetAll}
              className="flex items-center gap-2 text-[10px] font-bold text-slate-500 hover:text-indigo-600 px-4 py-2 rounded-xl transition-colors"
            >
              <RefreshCcw className="w-4 h-4" /> Reset
            </button>
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
                  <button onClick={resetAll} className="text-[9px] font-bold text-red-400 hover:text-red-600 uppercase tracking-tighter transition-colors">
                    Supprimer
                  </button>
                )}
              </div>

              <div
                onClick={() => fileInputRef.current?.click()}
                className="relative aspect-video rounded-3xl border-2 border-dashed border-slate-200 overflow-hidden cursor-pointer hover:border-indigo-400 transition-all bg-slate-50 group"
              >
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*,.heic" />
                {isConverting ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-2" />
                    <p className="text-[10px] font-bold uppercase">Conversion HEIC...</p>
                  </div>
                ) : originalPreview ? (
                  <img src={originalPreview} className="w-full h-full object-cover" alt="Original" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 group-hover:text-indigo-500">
                    <Upload className="w-8 h-8 mb-2" />
                    <p className="text-xs font-bold">Importer un fichier</p>
                    <p className="text-[10px] text-slate-300 mt-1">JPG, PNG, HEIC supportés</p>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-3">2. Action souhaitée</h3>
                <div className="grid grid-cols-2 gap-2">
                  {objectiveOptions.map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setObjective(opt.id)}
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

              <div className="space-y-3">
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">3. Précisions (Optionnel)</h3>
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

            <section className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 flex flex-col min-h-[400px]">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Résultat IA</h3>
                {generatedImage && (
                  <button
                    onClick={downloadFile}
                    className="flex items-center gap-2 text-[10px] font-bold text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors"
                  >
                    <Download className="w-3 h-3" /> Télécharger
                  </button>
                )}
              </div>
              <div className="flex-1 rounded-3xl bg-slate-50 overflow-hidden border border-slate-100 flex items-center justify-center relative shadow-inner">
                {isGenerating ? (
                  <div className="text-center p-8">
                    <div className="relative inline-block mb-4">
                      <div className="w-16 h-16 border-4 border-indigo-50 border-t-indigo-600 rounded-full animate-spin"></div>
                      <Boxes className="absolute inset-0 m-auto w-6 h-6 text-indigo-600 animate-pulse" />
                    </div>
                    <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase">Analyse des pixels...</p>
                  </div>
                ) : generatedImage ? (
                  <img src={generatedImage} className="w-full h-full object-cover" alt="Rendu IA" />
                ) : (
                  <div className="text-center text-slate-300 p-10">
                    <ImageIcon className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-xs font-bold italic opacity-40">Votre projet s'affichera ici</p>
                  </div>
                )}
              </div>
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
                        setSelectedFile({ type: 'image/jpeg' });
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
    </div>
  );
}
