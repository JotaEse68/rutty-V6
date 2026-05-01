exports.handler = async function(event) {

  // Handle CORS preflight
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

  if (!OPENAI_KEY && !CLAUDE_KEY) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'API keys no configuradas en Netlify Environment Variables' })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: 'Bad Request' }; }

  const { provider, messages, system, text, voice } = body;
  const CORS = { 'Access-Control-Allow-Origin': '*' };

  try {
    // ── TTS (OpenAI) ──
    if (provider === 'tts') {
      if (!OPENAI_KEY) throw new Error('OPENAI_KEY no configurada');
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: 'tts-1', voice: voice || 'nova', input: text, speed: 1.05 })
      });
      if (!resp.ok) { const err = await resp.text(); throw new Error(`TTS ${resp.status}: ${err}`); }
      const buffer = await resp.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'audio/mpeg', ...CORS },
        body: Buffer.from(buffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    // ── OpenAI Chat ──
    if (provider === 'openai') {
      if (!OPENAI_KEY) throw new Error('OPENAI_KEY no configurada');
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
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

    // ── Claude ──
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
