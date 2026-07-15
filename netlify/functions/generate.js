const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

// Les modèles Gemini sont dépréciés régulièrement, et la disponibilité dépend de la clé
// (un modèle peut rester actif pour un ancien projet et être refusé aux nouveaux comptes :
// "no longer available to new users"). On interroge donc ListModels pour savoir ce qui est
// réellement accessible à CETTE clé, puis on essaie les candidats dans l'ordre.

// Cache par clé, valable le temps du warm start du lambda.
const modelCache = new Map();

// Préférences ordonnées. Un nom absent de la liste ListModels est simplement ignoré.
const TEXT_PREFERENCES = [
  'gemini-flash-latest',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Nano Banana Pro d'abord, puis Nano Banana.
const IMAGE_PREFERENCES = [
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-preview-image-generation',
];

async function listModels(apiKey) {
  if (modelCache.has(apiKey)) return modelCache.get(apiKey);
  const res = await fetch(`${API_ROOT}/models?pageSize=200&key=${apiKey}`);
  if (!res.ok) {
    modelCache.set(apiKey, []);
    return [];
  }
  const data = await res.json();
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''));
  modelCache.set(apiKey, names);
  return names;
}

// Construit la liste ordonnée des modèles à tenter.
// wantImage: modèles capables de RENVOYER une image (nom contenant "image").
async function candidateModels(apiKey, wantImage) {
  const available = await listModels(apiKey);
  const prefs = wantImage ? IMAGE_PREFERENCES : TEXT_PREFERENCES;
  const ordered = prefs.filter(p => available.includes(p));

  // Complète avec ce que la clé expose réellement, au cas où les préférences soient
  // toutes obsolètes (évite de re-casser à la prochaine dépréciation).
  const discovered = available.filter(n => {
    const isImage = /image/i.test(n);
    if (wantImage !== isImage) return false;
    if (/embedding|aqa|tts|native-audio|live/i.test(n)) return false;
    return !ordered.includes(n);
  });

  const fallback = ordered.concat(discovered);
  // Si ListModels a échoué, on tente quand même les préférences en aveugle.
  return fallback.length ? fallback : prefs;
}

// Essaie chaque modèle jusqu'à une réponse exploitable.
async function generateWithFallback(apiKey, wantImage, payload) {
  const models = await candidateModels(apiKey, wantImage);
  let lastError = 'Aucun modèle Gemini disponible pour cette clé.';

  for (const model of models) {
    let res, data;
    try {
      res = await fetch(`${API_ROOT}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await res.json();
    } catch (err) {
      lastError = err.message;
      continue;
    }

    if (res.ok) return { ok: true, data, model };

    lastError = data?.error?.message || `HTTP ${res.status}`;

    // Modèle indisponible/déprécié/inconnu -> on tente le suivant.
    // Quota, clé invalide, contenu refusé -> inutile d'insister.
    const retryable = res.status === 404 || /no longer available|not found|not supported|does not exist/i.test(lastError);
    if (!retryable) return { ok: false, status: res.status, error: lastError };
  }

  return { ok: false, status: 502, error: lastError };
}

// Garde-fous globaux appliqués à CHAQUE génération d'image (anti-hallucination).
// Empêche le modèle d'inventer des éléments non demandés (garage, étage,
// extension…) et de recadrer / faire disparaître le décor d'origine.
const GUARDRAILS = [
  'You are a professional real-estate home-staging image editor.',
  'ABSOLUTE RULES — follow them strictly and never break them:',
  '1. Modify ONLY what the instruction explicitly requests. Never invent, add or remove anything that was not asked for (no extra garage, no extra floor/storey, no extension, no pool, no fence, no additional building, room or furniture unless explicitly requested).',
  '2. Faithfully preserve everything else from the source photo (IMAGE 1): the exact same camera framing, angle, zoom level, proportions and aspect ratio, and the whole surrounding scene (background, neighbouring houses, vegetation, roads, sky and terrain).',
  '3. Never crop, never zoom in, never re-frame or change the composition of IMAGE 1. The output must show the FULL original scene at the same dimensions — the terrain and its surroundings must remain fully visible.',
  '4. Keep every change realistic and physically plausible (correct perspective, scale, lighting and shadows).',
  '5. Output ONLY the edited image — no added text, watermark or border.'
].join('\n');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Corps de requête invalide.' }) };
  }

  const {
    prompt, mimeType, imageData, referenceImages, zoneImage, userApiKey, analyze,
    referenceImageData, referenceMimeType // format hérité, encore accepté
  } = body;

  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Clé API Gemini manquante.' }) };
  }
  if (!imageData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image manquante.' }) };
  }

  // === PASSE 1 (analyse) : lecture d'un plan 2D, réponse TEXTE (carte des pièces) ===
  // Pas de garde-fous ici : on ne génère aucune image, on lit le plan.
  if (analyze) {
    const analyzePayload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageData } }
        ]
      }],
      generationConfig: { temperature: 0.2 }
    };

    try {
      const r = await generateWithFallback(apiKey, false, analyzePayload);
      if (!r.ok) {
        return { statusCode: r.status, headers, body: JSON.stringify({ error: `Erreur analyse Gemini : ${r.error}` }) };
      }
      const text = r.data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
      return { statusCode: 200, headers, body: JSON.stringify({ text, model: r.model }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Erreur serveur analyse : ${err.message}` }) };
    }
  }

  // === PASSE 2 (génération image) ===
  const parts = [
    { text: GUARDRAILS },
    { text: prompt },
    { text: 'IMAGE 1 (à transformer) — voici la photo source à modifier :' },
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageData } }
  ];

  let nextImageIndex = 2;

  // Zone cible optionnelle : copie de la photo source avec la zone à modifier
  // dessinée à la main en rouge. La transformation doit rester dans ce tracé.
  if (zoneImage?.data) {
    parts.push({
      text: `IMAGE ${nextImageIndex} (target zone) — same photo as IMAGE 1 with the ZONE TO MODIFY hand-drawn in red. Apply the requested transformation ONLY inside that red zone; everything outside it must remain strictly identical to IMAGE 1. Never reproduce the red strokes or markings in the output:`
    });
    parts.push({ inlineData: { mimeType: zoneImage.mimeType || 'image/jpeg', data: zoneImage.data } });
    nextImageIndex++;
  }

  // Image(s) de référence optionnelles (style d'inspiration ou bâtiment à implanter).
  // Accepte le tableau `referenceImages` et l'ancien couple referenceImageData/MimeType.
  const refs = Array.isArray(referenceImages)
    ? referenceImages
    : (referenceImageData ? [{ data: referenceImageData, mimeType: referenceMimeType }] : []);

  refs.forEach((ref) => {
    if (!ref?.data) return;
    parts.push({ text: `IMAGE ${nextImageIndex} (référence) :` });
    parts.push({ inlineData: { mimeType: ref.mimeType || 'image/jpeg', data: ref.data } });
    nextImageIndex++;
  });

  const payload = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };

  try {
    const r = await generateWithFallback(apiKey, true, payload);

    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({ error: `Erreur API Gemini : ${r.error}` }) };
    }

    const imagePart = r.data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData?.data) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "L'IA n'a pas retourné d'image valide." })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        imageData: imagePart.inlineData.data,
        mimeType: imagePart.inlineData.mimeType || 'image/png',
        model: r.model
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Erreur serveur : ${err.message}` })
    };
  }
};
