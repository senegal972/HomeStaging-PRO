export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, mimeType, imageData, userApiKey } = req.body;

  const apiKey = userApiKey || process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Clé API Gemini manquante.' });
  if (!imageData) return res.status(400).json({ error: 'Image manquante.' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageData } }
      ]
    }],
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
      return res.status(upstream.status).json({ error: `Erreur API Gemini : ${detail}` });
    }

    const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData?.data) {
      return res.status(500).json({ error: "L'IA n'a pas retourné d'image valide." });
    }

    return res.status(200).json({
      imageData: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || 'image/png'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
