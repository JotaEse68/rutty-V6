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

  const OPENAI_KEY  = process.env.OPENAI_KEY  || process.env.CHatgpt || process.env.chatgpt;
  const CLAUDE_KEY  = process.env.CLAUDE_KEY  || process.env.claude;
  const ELEVEN_KEY  = process.env.ELEVEN_KEY;

  console.log('ENV check — openai:', !!OPENAI_KEY, '| claude:', !!CLAUDE_KEY, '| eleven:', !!ELEVEN_KEY);

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const { provider, messages, system, text, voice } = body;
  console.log('provider:', provider);

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (status, data) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(data)
  });

  try {

    // ── DIAGNÓSTICO ──
    if (provider === 'diagnostico') {
      return json(200, {
        openai_key: OPENAI_KEY  ? 'OK (' + OPENAI_KEY.slice(0,8)  + '...)' : 'MISSING',
        claude_key: CLAUDE_KEY  ? 'OK (' + CLAUDE_KEY.slice(0,8)  + '...)' : 'MISSING',
        eleven_key: ELEVEN_KEY  ? 'OK (' + ELEVEN_KEY.slice(0,8)  + '...)' : 'MISSING',
      });
    }

    // ── ElevenLabs TTS ──
    if (provider === 'tts-eleven') {
      if (!ELEVEN_KEY) return json(503, { error: 'ELEVEN_KEY not set' });
      const VOICE_ID = 'XB0fDUnXU5powFXDhCwa';
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_KEY, 'Accept': 'audio/mpeg' },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.45, similarity_boost: 0.82, style: 0.25, use_speaker_boost: true },
            language_code: 'es'
          })
        }
      );
      console.log('ElevenLabs status:', resp.status);
      if (!resp.ok) { const e = await resp.text(); return json(resp.status, { error: 'ElevenLabs: ' + e.slice(0,200) }); }
      const buffer = await resp.arrayBuffer();
      return { statusCode: 200, headers: { 'Content-Type': 'audio/mpeg', ...CORS }, body: Buffer.from(buffer).toString('base64'), isBase64Encoded: true };
    }

    // ── OpenAI TTS ──
    if (provider === 'tts') {
      if (!OPENAI_KEY) return json(503, { error: 'OPENAI_KEY not set' });
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: 'tts-1-hd', voice: voice || 'shimmer', input: text, speed: 0.92, response_format: 'mp3' })
      });
      if (!resp.ok) { const e = await resp.text(); return json(resp.status, { error: 'OpenAI TTS: ' + e.slice(0,200) }); }
      const buffer = await resp.arrayBuffer();
      return { statusCode: 200, headers: { 'Content-Type': 'audio/mpeg', ...CORS }, body: Buffer.from(buffer).toString('base64'), isBase64Encoded: true };
    }

    // ── OpenAI Chat (principal) ──
    if (provider === 'openai') {
      if (!OPENAI_KEY) return json(503, { error: 'OPENAI_KEY not set — add CHatgpt or OPENAI_KEY in Netlify env vars' });
      if (!messages || !messages.length) return json(400, { error: 'messages required' });

      console.log('Calling OpenAI, messages:', messages.length);
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 300, messages })
      });
      console.log('OpenAI chat status:', resp.status);
      if (!resp.ok) { const e = await resp.text(); console.error('OpenAI error:', e.slice(0,300)); return json(resp.status, { error: 'OpenAI: ' + e.slice(0,200) }); }
      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content || '';
      return json(200, { text: reply });
    }

    // ── Claude Chat (fallback) ──
    if (provider === 'claude') {
      if (!CLAUDE_KEY) return json(503, { error: 'CLAUDE_KEY not set' });
      if (!messages || !messages.length) return json(400, { error: 'messages required' });

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: system || '', messages })
      });
      console.log('Claude status:', resp.status);
      if (!resp.ok) { const e = await resp.text(); return json(resp.status, { error: 'Claude: ' + e.slice(0,200) }); }
      const data = await resp.json();
      return json(200, { text: data.content?.[0]?.text || '' });
    }

    return json(400, { error: 'Unknown provider: ' + provider });

  } catch(e) {
    console.error('Unhandled error:', e.message);
    return json(500, { error: e.message });
  }
};
