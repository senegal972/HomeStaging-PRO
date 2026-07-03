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

  const { prompt, mimeType, imageData, referenceImages, userApiKey } = body;

  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Clé API Gemini manquante.' }) };
  }
  if (!imageData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image manquante.' }) };
  }

  // Modèle le plus récent supportant image en entrée + sortie
  const model = 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Garde-fous globaux appliqués à CHAQUE génération (anti-hallucination).
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

  const parts = [
    { text: GUARDRAILS },
    { text: prompt },
    { text: 'IMAGE 1 (à transformer) — voici la photo source à modifier :' },
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageData } }
  ];

  // Image(s) de référence optionnelles (style d'inspiration ou bâtiment à implanter)
  if (Array.isArray(referenceImages)) {
    referenceImages.forEach((ref, idx) => {
      if (!ref?.data) return;
      parts.push({ text: `IMAGE ${idx + 2} (référence) :` });
      parts.push({ inlineData: { mimeType: ref.mimeType || 'image/jpeg', data: ref.data } });
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await upstream.json();

    if (!upstream.ok) {
      const detail = result?.error?.message || 'Erreur inconnue';
      return {
        statusCode: upstream.status,
        headers,
        body: JSON.stringify({ error: `Erreur API Gemini : ${detail}` })
      };
    }

    const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
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
        mimeType: imagePart.inlineData.mimeType || 'image/png'
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
