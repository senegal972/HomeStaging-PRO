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

  const { prompt, mimeType, imageData, referenceImageData, referenceMimeType, userApiKey, analyze } = body;

  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Clé API Gemini manquante.' }) };
  }
  if (!imageData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image manquante.' }) };
  }

  // === PASSE 1 (analyse) : lecture du plan 2D, réponse TEXTE (carte des pièces) ===
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
    { text: prompt },
    { text: 'IMAGE 1 (à transformer) — voici la photo source à modifier :' },
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageData } }
  ];

  // Image de référence optionnelle : l'IA s'en inspire pour le style/ambiance
  if (referenceImageData) {
    parts.push({ text: 'IMAGE 2 (référence de style) — inspire-toi du style, de l\'ambiance, des matériaux et de la palette de couleurs de cette image de référence, mais applique-les à IMAGE 1 sans copier sa structure ni ses objets :' });
    parts.push({ inlineData: { mimeType: referenceMimeType || 'image/jpeg', data: referenceImageData } });
  }

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
