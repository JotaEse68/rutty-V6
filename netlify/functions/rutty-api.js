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

  const OPENAI_KEY  = process.env.OPENAI_KEY;
  const CLAUDE_KEY  = process.env.CLAUDE_KEY;
  const ELEVEN_KEY  = process.env.ELEVEN_KEY;

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: 'Bad Request' }; }

  const { provider, messages, system, text, voice } = body;
  const CORS = { 'Access-Control-Allow-Origin': '*' };

  try {

    // ══════════════════════════════════════
    // ElevenLabs TTS — LA MÁS NATURAL
    // Voz: Charlotte (es-ES femenina, cálida)
    // Modelo: eleven_multilingual_v2
    // ══════════════════════════════════════
    if (provider === 'tts-eleven') {
      if (!ELEVEN_KEY) {
        return {
          statusCode: 503,
          headers: { 'Content-Type': 'application/json', ...CORS },
          body: JSON.stringify({ error: 'ELEVEN_KEY no configurada' })
        };
      }

      // Charlotte: voz femenina española cálida y muy natural
      // Alternativas: 'XB0fDUnXU5powFXDhCwa' (Charlotte) | 'EXAVITQu4vr4xnSDxMaL' (Bella) | 'pNInz6obpgDQGcFmaJgB' (Adam)
      const ELEVEN_VOICE_ID = 'XB0fDUnXU5powFXDhCwa'; // Charlotte — femenina, cálida, multilingüe

      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
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
              stability: 0.45,          // más variación = más natural
              similarity_boost: 0.82,   // fidelidad a la voz original
              style: 0.25,              // algo de expresividad
              use_speaker_boost: true   // mejora la claridad
            },
            language_code: 'es'        // forzar español
          })
        }
      );

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`ElevenLabs ${resp.status}: ${err}`);
      }

      const buffer = await resp.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ══════════════════════════════════════
    // OpenAI TTS — FALLBACK (shimmer)
    // ══════════════════════════════════════
    if (provider === 'tts') {
      if (!OPENAI_KEY) throw new Error('OPENAI_KEY no configurada');

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
        throw new Error(`OpenAI TTS ${resp.status}: ${err}`);
      }

      const buffer = await resp.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ══════════════════════════════════════
    // OpenAI Chat
    // ══════════════════════════════════════
    if (provider === 'openai') {
      if (!OPENAI_KEY) throw new Error('OPENAI_KEY no configurada');
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 300, messages })
      });
      if (!resp.ok) { const err = await resp.text(); throw new Error(`OpenAI ${resp.status}: ${err}`); }
      const data = await resp.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
        body: JSON.stringify({ text: data.choices?.[0]?.message?.content || '' })
      };
    }

    // ══════════════════════════════════════
    // Claude (chat principal de Rutty)
    // ══════════════════════════════════════
    if (provider === 'claude') {
      if (!CLAUDE_KEY) throw new Error('CLAUDE_KEY no configurada');
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
          system,
          messages
        })
      });
      if (!resp.ok) { const err = await resp.text(); throw new Error(`Claude ${resp.status}: ${err}`); }
      const data = await resp.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
        body: JSON.stringify({ text: data.content?.[0]?.text || '' })
      };
    }

    return { statusCode: 400, body: 'Provider desconocido' };

  } catch(e) {
    console.error('rutty-api error:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ error: e.message })
    };
  }
};
