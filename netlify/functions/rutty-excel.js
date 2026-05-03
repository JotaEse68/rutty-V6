// rutty-excel.js — Convierte .xlsx a CSV en el servidor
// Maneja inlineStr, sharedStrings y entidades HTML correctamente

const zlib = require('zlib');
const { promisify } = require('util');
const inflateRaw = promisify(zlib.inflateRaw);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (s, d) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(d) });

function decodeEntidades(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function colLetraANum(letra) {
  let n = 0;
  for (let i = 0; i < letra.length; i++) n = n * 26 + (letra.charCodeAt(i) - 64);
  return n;
}

async function leerEntradaZip(buf, buscar) {
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
      const compression = buf.readUInt16LE(i + 8);
      const compSize    = buf.readUInt32LE(i + 18);
      const fnLen       = buf.readUInt16LE(i + 26);
      const extraLen    = buf.readUInt16LE(i + 28);
      const name        = buf.slice(i + 30, i + 30 + fnLen).toString('utf8');
      const dataStart   = i + 30 + fnLen + extraLen;
      const compData    = buf.slice(dataStart, dataStart + compSize);
      if (name === buscar) {
        if (compression === 0) return compData.toString('utf8');
        if (compression === 8) {
          try { return (await inflateRaw(compData)).toString('utf8'); } catch(e) { return null; }
        }
      }
      i = dataStart + compSize;
    } else { i++; }
  }
  return null;
}

function extraerSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const ts = [];
    const tr = /<t[^>]*>([^<]*)<\/t>/g;
    let tm;
    while ((tm = tr.exec(m[1])) !== null) ts.push(decodeEntidades(tm[1]));
    strings.push(ts.join(''));
  }
  return strings;
}

function parsearHoja(xml, strings) {
  const filas = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowM;
  while ((rowM = rowRe.exec(xml)) !== null) {
    const celdas = {};
    const cellRe = /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rowM[1])) !== null) {
      const colIdx  = colLetraANum(cm[1]);
      const attrs   = cm[2];
      const inner   = cm[3];
      const tipoM   = attrs.match(/t="([^"]+)"/);
      const tipo    = tipoM ? tipoM[1] : '';
      const valM    = inner.match(/<v>([^<]*)<\/v>/);
      const inlM    = inner.match(/<t[^>]*>([^<]*)<\/t>/);
      let val = '';
      if (tipo === 's' && valM) {
        val = strings[parseInt(valM[1])] || '';
      } else if (tipo === 'inlineStr' && inlM) {
        val = decodeEntidades(inlM[1]);
      } else if (inlM) {
        val = decodeEntidades(inlM[1]);
      } else if (valM) {
        val = valM[1];
      }
      if (val.trim()) celdas[colIdx] = val.trim();
    }
    if (Object.keys(celdas).length > 0) {
      const maxCol = Math.max(...Object.keys(celdas).map(Number));
      const fila = [];
      for (let c = 1; c <= maxCol; c++) fila.push(celdas[c] || '');
      filas.push(fila);
    }
  }
  return filas;
}

// Detectar qué fila es la cabecera real (tiene palabras clave de columnas conocidas)
function detectarFilaCabecera(filas) {
  const keywords = ['repartidor','nombre','direccion','dirección','orden','alergeno','riesgo','comensal','destinatario'];
  for (let i = 0; i < Math.min(5, filas.length); i++) {
    const fila = filas[i];
    const hits = fila.filter(c => keywords.some(k => c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(k)));
    if (hits.length >= 2) return i;
  }
  return 0;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return json(400, { error: 'Bad JSON' }); }

  const { base64 } = body;
  if (!base64) return json(400, { error: 'base64 requerido' });

  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
      return json(400, { error: 'El archivo no es un Excel válido (.xlsx)' });
    }

    const [ssXml, sheet1Xml] = await Promise.all([
      leerEntradaZip(buf, 'xl/sharedStrings.xml'),
      leerEntradaZip(buf, 'xl/worksheets/sheet1.xml'),
    ]);

    if (!sheet1Xml) return json(400, { error: 'No se encontró la hoja en el Excel' });

    const strings = extraerSharedStrings(ssXml);
    const todasFilas = parsearHoja(sheet1Xml, strings);

    if (todasFilas.length < 2) return json(400, { error: 'El Excel no tiene datos suficientes' });

    // Detectar y saltar filas de título hasta la cabecera real
    const idxCabecera = detectarFilaCabecera(todasFilas);
    const filas = todasFilas.slice(idxCabecera);

    // Convertir a CSV separado por ;
    const csv = filas.map(fila =>
      fila.map(v => {
        const s = String(v || '');
        return (s.includes(';') || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(';')
    ).join('\n');

    console.log(`✅ Excel convertido: ${filas.length-1} filas de datos, cabecera: ${filas[0]?.join(', ')}`);
    return json(200, { csv, filas: filas.length - 1, cabecera: filas[0] });

  } catch(e) {
    console.error('Error Excel:', e.message);
    return json(500, { error: 'Error procesando Excel: ' + e.message });
  }
};
