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

  const parts = [
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
