// Facturation d'un home staging via le service central de l'Étude de marché (OPTIMMO) :
// même numérotation par société, mêmes sociétés émettrices, même charte. Rien n'est facturé ici.
const CENTRALE = 'https://fidi-etude-marche-app.netlify.app';
let chargement = null;

export function chargerPont() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.FidiFacturation) return Promise.resolve();
  if (chargement) return chargement;
  chargement = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = CENTRALE + '/facturation-pont.js';
    s.onload = ok;
    s.onerror = () => { chargement = null; ko(new Error('Service de facturation injoignable.')); };
    document.head.appendChild(s);
  });
  return chargement;
}

const MODES = { interior: 'intérieur', exterior: 'extérieur', floorplan: 'plan 2D aménagé', render3d: 'rendu 3D' };

// designs : visuels de l'historique (Firestore). On propose ceux du jour, regroupés par type.
export function lignesDuJour(designs, maintenant = new Date()) {
  const jour = maintenant.toDateString();
  const duJour = (designs || []).filter((d) => d?.createdAt?.seconds && new Date(d.createdAt.seconds * 1000).toDateString() === jour);
  const parMode = {};
  duJour.forEach((d) => { const m = MODES[d.mode] || 'intérieur'; parMode[m] = (parMode[m] || 0) + 1; });
  const lignes = Object.entries(parMode).map(([m, n]) => ({
    designation: 'Home staging virtuel — visuel ' + m, description: '', quantite: n, prixUnitaire: 0,
  }));
  return lignes.length ? lignes : [{ designation: 'Home staging virtuel', description: '', quantite: 1, prixUnitaire: 0 }];
}

export async function facturerHomeStaging({ designs, uid, onCreee }) {
  await chargerPont();
  const r = window.FidiFacturation.ouvrir({
    source: 'HomeStaging PRO', type_libelle: 'Home staging',
    ref: 'HSP-' + String(uid || 'anon').slice(0, 8) + '-' + Date.now().toString(36),
    lignes: lignesDuJour(designs), mode: 'quantite', prixSaisis: 'TTC',
    onCreee,
  });
  if (!r.ok) throw new Error(r.erreur);
}
