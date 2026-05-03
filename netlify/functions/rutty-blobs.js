// rutty-blobs.js — Persistencia con Netlify Blobs API REST directa
// Usa NETLIFY_AUTH_TOKEN + SITE_ID que Netlify inyecta automáticamente
// en todas las funciones desplegadas. Cero configuración manual.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (s, d) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(d) });

// Netlify Blobs REST API — disponible automáticamente en funciones desplegadas
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_AUTH_TOKEN;
const STORE   = 'rutty';

async function blobGet(key) {
  if (!SITE_ID || !TOKEN) return null;
  try {
    const r = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

async function blobSet(key, data) {
  if (!SITE_ID || !TOKEN) return false;
  try {
    const r = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }
    );
    return r.ok;
  } catch(e) { return false; }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return json(400, { error: 'Bad JSON' }); }

  // Verificar que tenemos acceso a Blobs
  if (!SITE_ID || !TOKEN) {
    return json(503, {
      error: 'Persistencia no disponible. Añade NETLIFY_AUTH_TOKEN y SITE_ID en Netlify → Environment variables.',
      hint: 'Ve a app.netlify.com → tu site → Site configuration → Environment variables'
    });
  }

  const { op, fecha, repNombre, entregas, entregaId, pts } = body;

  try {
    if (op === 'get-rutas') {
      const hoy = fecha || new Date().toISOString().slice(0, 10);
      const data = await blobGet('rutas-' + hoy);
      return json(200, { rutas: data || {} });
    }

    if (op === 'set-rutas') {
      if (!fecha || !repNombre || !entregas) return json(400, { error: 'faltan datos' });
      let data = await blobGet('rutas-' + fecha) || {};
      data[repNombre] = {
        actualizado: new Date().toISOString(),
        entregas: entregas.map((e, i) => ({
          id: e.id || ('e' + Date.now() + i),
          orden: i + 1,
          nombre: e.nombre || '',
          direccion: e.direccion || '',
          alergenos: e.alergenos || '',
          riesgo: e.riesgo || 'normal',
          notas: e.notas || '',
          estado: e.estado || 'pendiente',
          confirmadoEn: e.confirmadoEn || null,
          ptsGanados: e.ptsGanados || 0
        }))
      };
      await blobSet('rutas-' + fecha, data);
      return json(200, { ok: true, total: entregas.length });
    }

    if (op === 'confirmar-entrega') {
      if (!fecha || !repNombre || !entregaId) return json(400, { error: 'faltan datos' });
      let data = await blobGet('rutas-' + fecha);
      if (!data || !data[repNombre]) return json(404, { error: 'Sin ruta' });
      const entrega = data[repNombre].entregas.find(e => e.id === entregaId);
      if (!entrega) return json(404, { error: 'No encontrada' });
      const ptsEntrega = pts || (entrega.riesgo === 'critico' ? 25 : entrega.riesgo === 'alto' ? 15 : 10);
      entrega.estado = 'entregado';
      entrega.confirmadoEn = new Date().toISOString();
      entrega.ptsGanados = ptsEntrega;

      // Acumular puntos del mes
      const mes = fecha.slice(0, 7);
      let puntosMes = await blobGet('puntos-' + mes) || {};
      puntosMes[repNombre] = (puntosMes[repNombre] || 0) + ptsEntrega;
      await Promise.all([blobSet('rutas-' + fecha, data), blobSet('puntos-' + mes, puntosMes)]);

      const totalEntregadas = data[repNombre].entregas.filter(e => e.estado === 'entregado').length;
      const siguiente = data[repNombre].entregas.find(e => e.estado === 'pendiente');
      return json(200, { ok: true, ptsGanados: ptsEntrega, puntosDelMes: puntosMes[repNombre], totalEntregadas, totalRuta: data[repNombre].entregas.length, siguiente: siguiente || null });
    }

    if (op === 'incidencia') {
      let data = await blobGet('rutas-' + fecha);
      const e = data?.[repNombre]?.entregas?.find(e => e.id === entregaId);
      if (e) { e.estado = 'incidencia'; e.confirmadoEn = new Date().toISOString(); e.ptsGanados = 0; await blobSet('rutas-' + fecha, data); }
      return json(200, { ok: true });
    }

    if (op === 'get-puntos-mes') {
      const mes = fecha || new Date().toISOString().slice(0, 7);
      const data = await blobGet('puntos-' + mes) || {};
      return json(200, { puntos: data, mes });
    }

    return json(400, { error: 'Op desconocida: ' + op });

  } catch(e) {
    console.error('Error:', e.message);
    return json(500, { error: e.message });
  }
};
