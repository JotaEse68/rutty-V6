const zlib = require('zlib');
const { promisify } = require('util');
const inflateRaw = promisify(zlib.inflateRaw);

let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { XLSX = null; }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (s, d) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(d) });

function decode(s) {
  return (s||'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g,(_,h)=>String.fromCodePoint(parseInt(h,16)));
}

function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
function col2n(c){let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n;}

const KEYWORDS=['repartidor','rep','conductor','driver','responsable','nombre','destinatario','cliente','usuario','comensal','paciente','direccion','address','domicilio','orden','numero','parada','alergeno','alergia','intolerancia','riesgo','prioridad','cajas','caja','cantidad','bultos','notas','observaciones'];
function esCabecera(fila){
  const hits=fila.filter(c=>KEYWORDS.some(k=>norm(c).includes(k)));
  return hits.length>=2 && fila.length>=2;
}
function esTotalOVacia(fila){
  const txt=norm(fila[0]||'');
  return txt.includes('total')||fila.every(c=>!String(c||'').trim());
}
function limpiarFilas(todas){
  if(!todas || todas.length<2) throw new Error('Excel sin datos suficientes');
  let idxCab=-1;
  for(let i=0;i<Math.min(30,todas.length);i++){
    if(esCabecera(todas[i])){idxCab=i;break;}
  }
  if(idxCab<0) throw new Error('No se encontró cabecera reconocible. Usa columnas como Repartidor, Nombre, Dirección, Alérgenos, Riesgo y Notas.');
  return [todas[idxCab], ...todas.slice(idxCab+1).filter(f=>!esTotalOVacia(f))];
}
function filasACSV(filas){
  return filas.map(f=>f.map(v=>{
    const s=String(v??'').trim();
    return(s.includes(';')||s.includes('"')||s.includes('\n')||s.includes('\r'))?`"${s.replace(/"/g,'""')}"`:s;
  }).join(';')).join('\n');
}

async function leerZip(buf, buscar) {
  let i=0;
  while(i<buf.length-4){
    if(buf[i]===0x50&&buf[i+1]===0x4B&&buf[i+2]===0x03&&buf[i+3]===0x04){
      const comp=buf.readUInt16LE(i+8),csz=buf.readUInt32LE(i+18);
      const fnl=buf.readUInt16LE(i+26),exl=buf.readUInt16LE(i+28);
      const nm=buf.slice(i+30,i+30+fnl).toString('utf8');
      const ds=i+30+fnl+exl;
      const cd=buf.slice(ds,ds+csz);
      if(nm===buscar){
        if(comp===0)return cd.toString('utf8');
        if(comp===8){try{return(await inflateRaw(cd)).toString('utf8');}catch(e){return null;}}
      }
      i=ds+csz;
    }else{i++;}
  }
  return null;
}
function parsearHoja(xml, strings) {
  const filas=[];
  const rowRe=/<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while((rm=rowRe.exec(xml))!==null){
    const celdas={};
    const cellRe=/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while((cm=cellRe.exec(rm[1]))!==null){
      const col=col2n(cm[1]),attrs=cm[2],inner=cm[3];
      const tipo=(attrs.match(/t="([^"]+)"/)??[])[1]||'';
      const valM=inner.match(/<v>([^<]*)<\/v>/);
      const tM=inner.match(/<t[^>]*>([^<]*)<\/t>/);
      let val='';
      if(tipo==='s'&&valM) val=strings[+valM[1]]||'';
      else if(tM) val=decode(tM[1]);
      else if(valM) val=valM[1];
      val=String(val).trim();
      if(val) celdas[col]=val;
    }
    if(Object.keys(celdas).length){
      const mx=Math.max(...Object.keys(celdas).map(Number));
      filas.push(Array.from({length:mx},(_,i)=>celdas[i+1]||''));
    }
  }
  return filas;
}
function extraerSS(xml){
  if(!xml)return[];
  const s=[];
  const re=/<si>([\s\S]*?)<\/si>/g;let m;
  while((m=re.exec(xml))!==null){
    const ts=[];const tr=/<t[^>]*>([^<]*)<\/t>/g;let tm;
    while((tm=tr.exec(m[1]))!==null)ts.push(decode(tm[1]));
    s.push(ts.join(''));
  }
  return s;
}
async function parseManualXlsx(buf){
  if(buf[0]!==0x50||buf[1]!==0x4B) throw new Error('No es un .xlsx válido. Si es .xls antiguo, vuelve a guardarlo como .xlsx o CSV.');
  const[ssXml,sh1]=await Promise.all([leerZip(buf,'xl/sharedStrings.xml'),leerZip(buf,'xl/worksheets/sheet1.xml')]);
  if(!sh1) throw new Error('No se encontró xl/worksheets/sheet1.xml');
  return parsearHoja(sh1, extraerSS(ssXml));
}
function parseConSheetJS(buf){
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: false });
  for (const name of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false, raw: false });
    if (filas && filas.some(r => r.some(c => String(c||'').trim()))) return filas;
  }
  return [];
}

exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:CORS,body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'Method Not Allowed'});
  let body={};
  try{body=JSON.parse(event.body||'{}');}catch(e){return json(400,{error:'Bad JSON'});}
  const{base64,fileName}=body;
  if(!base64)return json(400,{error:'base64 requerido'});
  try{
    const buf=Buffer.from(base64,'base64');
    let todas;
    if (XLSX) todas = parseConSheetJS(buf);
    else todas = await parseManualXlsx(buf);
    const filas = limpiarFilas(todas);
    const csv = filasACSV(filas);
    console.log(`✅ Excel ${fileName||''}: ${filas.length-1} filas, cabecera: ${filas[0].join(', ')}`);
    return json(200,{csv,filas:filas.length-1,cabecera:filas[0],engine:XLSX?'xlsx':'manual'});
  }catch(e){
    console.error('Error Excel:',e.message);
    return json(400,{error:'Error procesando Excel: '+e.message});
  }
};
