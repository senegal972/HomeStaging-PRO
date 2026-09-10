import { useEffect, useRef, useState, useCallback } from 'react';

// Protège l'utilisateur contre la perte de son travail en cours.
//
// Cible trois voies de sortie qui, en pratique, cassaient l'app :
//   - Fermeture d'onglet, refresh, navigation URL, Alt+F4 : `beforeunload` → dialog
//     natif du navigateur ("Voulez-vous quitter ?"). Le texte n'est plus
//     personnalisable depuis Chrome 51, mais la protection est active.
//   - Retour arrière du téléphone Android (matériel ou navigateur mobile) : capturé
//     via `popstate` + entrée de piège poussée dans l'historique au montage.
//   - Touche `Escape` du clavier : capturée via `keydown` en phase capture.
//
// Le hook retourne { pendingExit, cancelExit, confirmExit } — l'UI branche un modal
// dessus. `hasWork` est un booléen recalculé à chaque rendu.
export function useUnsavedGuard(hasWork) {
  const [pendingExit, setPendingExit] = useState(null); // 'back' | 'escape' | null
  const hasWorkRef = useRef(hasWork);
  const bypassRef = useRef(false); // true quand l'utilisateur confirme la sortie
  hasWorkRef.current = hasWork;

  // 1) beforeunload — dialog natif navigateur, seul mécanisme autorisé pour la
  //    fermeture. On l'active/désactive dynamiquement selon hasWork.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!hasWorkRef.current || bypassRef.current) return;
      e.preventDefault();
      e.returnValue = ''; // requis par Chrome pour déclencher le dialog
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 2) Bouton retour Android / navigateur — on pousse une entrée « piège » dans
  //    l'historique au montage, puis on la re-pousse à chaque tentative de retour
  //    tant que l'utilisateur n'a pas confirmé.
  useEffect(() => {
    try {
      window.history.pushState({ guard: true }, '');
    } catch { /* environnements sandbox */ }

    const onPopState = () => {
      if (!hasWorkRef.current || bypassRef.current) return;
      // On repose immédiatement une entrée pour rester dans l'app.
      try { window.history.pushState({ guard: true }, ''); } catch { /* */ }
      setPendingExit('back');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 3) Touche Escape — capturée en phase capture pour ne pas dépendre d'un
  //    modal ou d'un focus intermédiaire qui l'aurait mangée.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (!hasWorkRef.current || bypassRef.current) return;
      setPendingExit((prev) => prev || 'escape');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const cancelExit = useCallback(() => setPendingExit(null), []);

  // « Oui, abandonner » — on désarme les gardes puis on rejoue l'action que
  // l'utilisateur voulait faire à l'origine (retour arrière = history.back()).
  const confirmExit = useCallback(() => {
    bypassRef.current = true;
    const reason = pendingExit;
    setPendingExit(null);
    if (reason === 'back') {
      // On a déjà repoussé une entrée dans popstate ; deux back() suffisent pour
      // sortir vraiment de l'app.
      try { window.history.go(-2); } catch { /* */ }
    }
    // Escape ne provoquait aucune sortie par lui-même — refermer le modal suffit.
  }, [pendingExit]);

  return { pendingExit, cancelExit, confirmExit };
}
