// rutty-blobs.js — Rutty V6.9
// Persistencia real con Netlify Blobs. Usa @netlify/blobs cuando está disponible
// y mantiene fallback REST si se configuran NETLIFY_AUTH_TOKEN + SITE_ID.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (s, d) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(d) });

const STORE = 'rutty';
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN = process.env.NETLIFY_AUTH_TOKEN;

let cachedStore = null;
function getBlobStore() {
  if (cachedStore) return cachedStore;
  try {
    const { getStore } = require('@netlify/blobs');
    cachedStore = getStore(STORE);
    return cachedStore;
  } catch (e) {
    return null;
  }
}

async function blobGet(key) {
  const store = getBlobStore();
  if (store) {
    try {
      const data = await store.get(key, { type: 'json' });
      if (data !== null && data !== undefined) return data;
    } catch (e) {
      // pasa al fallback REST
    }
  }
  if (!SITE_ID || !TOKEN) return null;
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function blobSet(key, data) {
  const store = getBlobStore();
  if (store) {
    try {
      if (typeof store.setJSON === 'function') await store.setJSON(key, data);
      else await store.set(key, JSON.stringify(data), { metadata: { contentType: 'application/json' } });
      return true;
    } catch (e) {
      // pasa al fallback REST
    }
  }
  if (!SITE_ID || !TOKEN) return false;
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.ok;
  } catch (e) { return false; }
}

function normalizarEntrega(e, i) {
  return {
    id: e.id || ('e' + Date.now() + i),
    orden: parseInt(e.orden) || i + 1,
    nombre: e.nombre || '',
    direccion: e.direccion || '',
    alergenos: e.alergenos || '',
    riesgo: e.riesgo || 'normal',
    notas: e.notas || '',
    cajas: Math.max(1, parseInt(e.cajas) || 1),
    estado: e.estado || 'pendiente',
    confirmadoEn: e.confirmadoEn || null,
    ptsGanados: parseInt(e.ptsGanados) || 0
  };
}
function puntosEntrega(entrega) {
  return entrega.riesgo === 'critico' ? 25 : entrega.riesgo === 'alto' ? 15 : 10;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return json(400, { error: 'Bad JSON' }); }
  const { op, fecha, repNombre, entregas, entregaId, pts } = body;

  try {
    if (op === 'health') {
      const key = 'health-check';
      const ok = await blobSet(key, { ok: true, at: new Date().toISOString() });
      const got = ok ? await blobGet(key) : null;
      return json(200, { ok: !!(ok && got), mode: getBlobStore() ? '@netlify/blobs' : (SITE_ID && TOKEN ? 'rest' : 'none') });
    }

    if (op === 'get-rutas') {
      const hoy = fecha || new Date().toISOString().slice(0, 10);
      const data = await blobGet('rutas-' + hoy);
      return json(200, { rutas: data || {}, mode: getBlobStore() ? '@netlify/blobs' : (SITE_ID && TOKEN ? 'rest' : 'none') });
    }

    if (op === 'set-rutas') {
      if (!fecha || !repNombre || !Array.isArray(entregas)) return json(400, { error: 'faltan datos' });
      let data = await blobGet('rutas-' + fecha) || {};
      data[repNombre] = {
        actualizado: new Date().toISOString(),
        entregas: entregas.map(normalizarEntrega)
      };
      const ok = await blobSet('rutas-' + fecha, data);
      if (!ok) return json(503, { error: 'Persistencia no disponible. Netlify Blobs no respondió. La app usará modo demo local en este navegador.' });
      return json(200, { ok: true, total: data[repNombre].entregas.length });
    }

    if (op === 'confirmar-entrega') {
      if (!fecha || !repNombre || !entregaId) return json(400, { error: 'faltan datos' });
      let data = await blobGet('rutas-' + fecha);
      if (!data || !data[repNombre]) return json(404, { error: 'Sin ruta' });
      const entrega = data[repNombre].entregas.find(e => e.id === entregaId);
      if (!entrega) return json(404, { error: 'No encontrada' });
      if (entrega.estado !== 'entregado') {
        entrega.estado = 'entregado';
        entrega.confirmadoEn = new Date().toISOString();
        entrega.ptsGanados = parseInt(pts) || puntosEntrega(entrega);
      }
      data[repNombre].actualizado = new Date().toISOString();
      await blobSet('rutas-' + fecha, data);

      const mes = fecha.slice(0, 7);
      let puntosMes = await blobGet('puntos-' + mes) || {};
      puntosMes[repNombre] = data[repNombre].entregas
        .filter(e => e.estado === 'entregado')
        .reduce((sum, e) => sum + (parseInt(e.ptsGanados) || puntosEntrega(e)), 0);
      await blobSet('puntos-' + mes, puntosMes);

      const totalEntregadas = data[repNombre].entregas.filter(e => e.estado === 'entregado').length;
      const siguiente = data[repNombre].entregas.find(e => e.estado === 'pendiente');
      return json(200, { ok: true, ptsGanados: entrega.ptsGanados, puntosDelMes: puntosMes[repNombre], totalEntregadas, totalRuta: data[repNombre].entregas.length, siguiente: siguiente || null });
    }

    if (op === 'incidencia') {
      let data = await blobGet('rutas-' + fecha) || {};
      const e = data?.[repNombre]?.entregas?.find(x => x.id === entregaId);
      if (e) {
        e.estado = 'incidencia';
        e.confirmadoEn = new Date().toISOString();
        e.ptsGanados = 0;
        data[repNombre].actualizado = new Date().toISOString();
        await blobSet('rutas-' + fecha, data);
      }
      return json(200, { ok: true });
    }

    if (op === 'get-puntos-mes') {
      const mes = fecha || new Date().toISOString().slice(0, 7);
      const data = await blobGet('puntos-' + mes) || {};
      return json(200, { puntos: data, mes });
    }

    return json(400, { error: 'Op desconocida: ' + op });
  } catch(e) {
    console.error('Rutty blobs error:', e);
    return json(500, { error: e.message });
  }
};
