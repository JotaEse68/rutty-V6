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
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const CLAUDE_KEY  = process.env.CLAUDE_KEY;
  const ELEVEN_KEY  = process.env.ELEVEN_KEY;
  const OPENAI_KEY  = process.env.OPENAI_KEY;

  // DEBUG: log which keys are present (never log the actual values)
  console.log('Keys present:', {
    claude: !!CLAUDE_KEY,
    eleven: !!ELEVEN_KEY,
    openai: !!OPENAI_KEY
  });

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const { provider, messages, system, text, voice } = body;
  console.log('Provider requested:', provider, '| text length:', text ? text.length : 0);

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const json = (status, data) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(data)
  });

  try {

    // ═══════════════════════════════════
    // DIAGNÓSTICO — comprueba variables
    // ═══════════════════════════════════
    if (provider === 'diagnostico') {
      return json(200, {
        claude_key: !!CLAUDE_KEY ? 'OK (' + CLAUDE_KEY.slice(0,8) + '...)' : 'MISSING',
        eleven_key: !!ELEVEN_KEY ? 'OK (' + ELEVEN_KEY.slice(0,8) + '...)' : 'MISSING',
        openai_key: !!OPENAI_KEY ? 'OK (' + OPENAI_KEY.slice(0,8) + '...)' : 'MISSING',
      });
    }

    // ═══════════════════════════════════
    // ElevenLabs TTS
    // ═══════════════════════════════════
    if (provider === 'tts-eleven') {
      if (!ELEVEN_KEY) {
        console.error('ELEVEN_KEY missing');
        return json(503, { error: 'ELEVEN_KEY not configured in Netlify env vars' });
      }

      const VOICE_ID = 'XB0fDUnXU5powFXDhCwa'; // Charlotte
      console.log('Calling ElevenLabs with voice:', VOICE_ID);

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

      console.log('ElevenLabs response status:', resp.status);

      if (!resp.ok) {
        const err = await resp.text();
        console.error('ElevenLabs error body:', err);
        return json(resp.status, { error: `ElevenLabs ${resp.status}: ${err.slice(0, 300)}` });
      }

      const buffer = await resp.arrayBuffer();
      console.log('ElevenLabs audio bytes:', buffer.byteLength);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ═══════════════════════════════════
    // OpenAI TTS fallback
    // ═══════════════════════════════════
    if (provider === 'tts') {
      if (!OPENAI_KEY) return json(503, { error: 'OPENAI_KEY not configured' });

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
        return json(resp.status, { error: `OpenAI TTS ${resp.status}: ${err.slice(0,200)}` });
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
    // Claude chat
    // ═══════════════════════════════════
    if (provider === 'claude') {
      if (!CLAUDE_KEY) {
        console.error('CLAUDE_KEY missing');
        return json(503, { error: 'CLAUDE_KEY not configured in Netlify env vars' });
      }
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return json(400, { error: 'messages array required' });
      }

      console.log('Calling Claude, messages count:', messages.length);

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

      console.log('Claude response status:', resp.status);

      if (!resp.ok) {
        const err = await resp.text();
        console.error('Claude error:', resp.status, err.slice(0, 300));
        return json(resp.status, { error: `Claude ${resp.status}: ${err.slice(0,200)}` });
      }

      const data = await resp.json();
      const reply = data.content?.[0]?.text || '';
      console.log('Claude reply length:', reply.length);
      return json(200, { text: reply });
    }

    return json(400, { error: 'Unknown provider: ' + provider });

  } catch(e) {
    console.error('Unhandled error:', e.message);
    return json(500, { error: e.message });
  }
};
