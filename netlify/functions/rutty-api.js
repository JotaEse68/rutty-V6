exports.handler = async function(event) {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const OPENAI_KEY = process.env.OPENAI_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;
  const ELEVEN_KEY = process.env.ELEVEN_KEY;

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad Request' }) }; }

  const { provider, messages, system, text, voice } = body;
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // ── Helper ──
  const jsonResp = (status, data) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(data)
  });

  try {

    // ═══════════════════════════════════
    // ElevenLabs TTS — voz Charlotte
    // ═══════════════════════════════════
    if (provider === 'tts-eleven') {
      if (!ELEVEN_KEY) return jsonResp(503, { error: 'ELEVEN_KEY not set' });

      const VOICE_ID = 'XB0fDUnXU5powFXDhCwa'; // Charlotte — natural, femenina, multilingüe

      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVEN_KEY,
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.82,
              style: 0.25,
              use_speaker_boost: true
            },
            language_code: 'es'
          })
        }
      );

      if (!resp.ok) {
        const err = await resp.text();
        console.error('ElevenLabs error:', resp.status, err);
        return jsonResp(resp.status, { error: `ElevenLabs ${resp.status}` });
      }

      const buffer = await resp.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ═══════════════════════════════════
    // OpenAI TTS — fallback shimmer
    // ═══════════════════════════════════
    if (provider === 'tts') {
      if (!OPENAI_KEY) return jsonResp(503, { error: 'OPENAI_KEY not set' });

      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: 'tts-1-hd',
          voice: voice || 'shimmer',
          input: text,
          speed: 0.92,
          response_format: 'mp3'
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        return jsonResp(resp.status, { error: `OpenAI TTS ${resp.status}` });
      }

      const buffer = await resp.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ═══════════════════════════════════
    // Claude — chat principal de Rutty
    // ═══════════════════════════════════
    if (provider === 'claude') {
      if (!CLAUDE_KEY) {
        console.error('CLAUDE_KEY not set in environment variables');
        return jsonResp(503, { error: 'CLAUDE_KEY not configured' });
      }

      // Validar messages
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return jsonResp(400, { error: 'messages required' });
      }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: system || 'Eres Rutty, asistente de UCALSA. Responde en español, máximo 3 frases.',
          messages: messages
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('Claude API error:', resp.status, err);
        return jsonResp(resp.status, { error: `Claude ${resp.status}: ${err.slice(0,200)}` });
      }

      const data = await resp.json();
      const text_out = data.content?.[0]?.text || '';

      if (!text_out) {
        return jsonResp(500, { error: 'Empty response from Claude' });
      }

      return jsonResp(200, { text: text_out });
    }

    return jsonResp(400, { error: 'Provider desconocido: ' + provider });

  } catch(e) {
    console.error('rutty-api unhandled error:', e.message, e.stack);
    return jsonResp(500, { error: e.message });
  }
};
