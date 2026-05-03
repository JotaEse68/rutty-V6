// ─────────────────────────────────────────────────────
// rutty-blobs.js — Gestión de rutas diarias con Netlify Blobs
// Operaciones: get-rutas | set-rutas | confirmar-entrega
// ─────────────────────────────────────────────────────
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (status, data) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data)
});

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return json(400, { error: 'Bad JSON' }); }

  const { op, fecha, repNombre, entregas, entregaId, pts } = body;

  try {
    const store = getStore({ name: 'rutty-rutas', consistency: 'strong' });

    // ── GET: leer rutas del día ──
    if (op === 'get-rutas') {
      const hoy = fecha || new Date().toISOString().slice(0,10);
      let data = null;
      try { data = await store.get(hoy, { type: 'json' }); } catch(e) {}
      return json(200, { rutas: data || {} });
    }

    // ── SET: supervisor sube/actualiza lista de entregas ──
    if (op === 'set-rutas') {
      if (!fecha || !repNombre || !entregas) return json(400, { error: 'fecha, repNombre y entregas requeridos' });
      const hoy = fecha;
      let data = null;
      try { data = await store.get(hoy, { type: 'json' }); } catch(e) {}
      if (!data) data = {};
      data[repNombre] = {
        actualizado: new Date().toISOString(),
        entregas: entregas.map((e, i) => ({
          id: e.id || ('e' + Date.now() + i),
          orden: i + 1,
          nombre: e.nombre || '',
          direccion: e.direccion || '',
          alergenos: e.alergenos || '',
          riesgo: e.riesgo || 'normal', // normal | alto | critico
          notas: e.notas || '',
          estado: e.estado || 'pendiente', // pendiente | entregado | incidencia
          confirmadoEn: e.confirmadoEn || null,
          ptsGanados: e.ptsGanados || 0
        }))
      };
      await store.set(hoy, JSON.stringify(data));
      return json(200, { ok: true, total: entregas.length });
    }

    // ── CONFIRMAR: repartidor confirma una entrega ──
    if (op === 'confirmar-entrega') {
      if (!fecha || !repNombre || !entregaId) return json(400, { error: 'fecha, repNombre y entregaId requeridos' });
      const hoy = fecha;
      let data = null;
      try { data = await store.get(hoy, { type: 'json' }); } catch(e) {}
      if (!data || !data[repNombre]) return json(404, { error: 'No hay ruta para este repartidor hoy' });

      const entrega = data[repNombre].entregas.find(e => e.id === entregaId);
      if (!entrega) return json(404, { error: 'Entrega no encontrada' });

      const ptsEntrega = pts || (entrega.riesgo === 'critico' ? 25 : entrega.riesgo === 'alto' ? 15 : 10);
      entrega.estado = 'entregado';
      entrega.confirmadoEn = new Date().toISOString();
      entrega.ptsGanados = ptsEntrega;

      await store.set(hoy, JSON.stringify(data));

      const totalEntregadas = data[repNombre].entregas.filter(e => e.estado === 'entregado').length;
      const totalRuta = data[repNombre].entregas.length;
      const siguiente = data[repNombre].entregas.find(e => e.estado === 'pendiente');

      return json(200, {
        ok: true,
        ptsGanados: ptsEntrega,
        totalEntregadas,
        totalRuta,
        siguiente: siguiente || null
      });
    }

    // ── INCIDENCIA: marcar problema en entrega ──
    if (op === 'incidencia') {
      if (!fecha || !repNombre || !entregaId) return json(400, { error: 'datos incompletos' });
      let data = null;
      try { data = await store.get(fecha, { type: 'json' }); } catch(e) {}
      if (!data || !data[repNombre]) return json(404, { error: 'Sin ruta' });
      const entrega = data[repNombre].entregas.find(e => e.id === entregaId);
      if (entrega) {
        entrega.estado = 'incidencia';
        entrega.confirmadoEn = new Date().toISOString();
        entrega.ptsGanados = 0;
        await store.set(fecha, JSON.stringify(data));
      }
      return json(200, { ok: true });
    }

    return json(400, { error: 'Operación desconocida: ' + op });

  } catch(e) {
    console.error('Blobs error:', e.message);
    // Si Blobs no está disponible (desarrollo local), simular respuesta vacía
    if (e.message && e.message.includes('NETLIFY_BLOBS')) {
      return json(200, { rutas: {}, _warning: 'Blobs no disponible en entorno local' });
    }
    return json(500, { error: e.message });
  }
};
