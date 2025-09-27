// index.js — Backend unificado para Render: WhatsApp Web + Agenda + Panel

/* ===================== IMPORTS (orden correcto) ===================== */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'node:path';
import fs from 'node:fs';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import pdf from 'pdf-parse';
import twilio from 'twilio';
import puppeteer from 'puppeteer';
import qrcode from 'qrcode-terminal';
import pkgWA from 'whatsapp-web.js';

const { Client, LocalAuth } = pkgWA;

/* ===================== CONFIG RUNTIME ===================== */
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const PORT = process.env.PORT || 3000;
const ZONE = 'America/Bogota';
const PANEL_ORIGIN = process.env.PANEL_ORIGIN || 'http://localhost:5173';

// Persistencia de sesión (Render usa /var/data)
const WWEB_DATA_DIR = IS_RENDER ? '/var/data/wwebjs_auth' : (process.platform === 'win32' ? 'C:\\wwebjs\\auth' : './wwebjs_auth');
fs.mkdirSync(WWEB_DATA_DIR, { recursive: true });

// Chrome log en Windows
if (process.platform === 'win32') process.env.CHROME_LOG_FILE = 'NUL';

/* ===================== ENV KEYS ===================== */
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) console.warn('⚠️ Falta GOOGLE_CALENDAR_ID');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.warn('⚠️ Falta OPENAI_API_KEY');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const ALERT_PHONE_NUMBER  = process.env.ALERT_PHONE_NUMBER  || '';
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ALERT_PHONE_NUMBER) {
  console.warn('⚠️ Faltan variables Twilio');
}

// Opción 2: credenciales GCP como base64 (si están, guardamos archivo)
if (IS_RENDER && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64) {
  try {
    const target = '/var/data/sa.json';
    const buf = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64, 'base64');
    fs.writeFileSync(target, buf);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = target;
    console.log('✅ Escribí service account en /var/data/sa.json');
  } catch (e) {
    console.error('❌ No pude escribir sa.json desde B64:', e);
  }
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('⚠️ Falta GOOGLE_APPLICATION_CREDENTIALS o GOOGLE_APPLICATION_CREDENTIALS_JSON_B64');
}

/* ===================== LIBS ===================== */
const app = express();
app.use(bodyParser.json());
app.use(cors({
  origin: [PANEL_ORIGIN, 'http://localhost:5173'],
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

/* ===================== “Airbags” EBUSY (Windows) ===================== */
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || '');
  if (msg.includes('EBUSY') && msg.includes('unlink') && msg.includes('wwebjs') && msg.includes('.db')) {
    console.warn('⚠️ Ignorada excepción EBUSY (LocalAuth cleanup Windows).');
    return;
  }
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = String((reason && reason.message) || reason || '');
  if (msg.includes('EBUSY') && msg.includes('unlink') && msg.includes('wwebjs') && msg.includes('.db')) {
    console.warn('⚠️ Ignorada unhandledRejection EBUSY.');
    return;
  }
  console.error('unhandledRejection:', reason);
});

// Parche de logout para no caer si el archivo está ocupado (Windows)
const __origLogout = LocalAuth.prototype.logout;
LocalAuth.prototype.logout = async function patchedLogout(...args) {
  try { return await __origLogout.apply(this, args); }
  catch (e) {
    const msg = String(e?.message || e || '');
    if (msg.includes('EBUSY') && msg.includes('unlink') && msg.includes('wwebjs') && msg.includes('.db')) {
      console.warn('⚠️ EBUSY en LocalAuth.logout ignorado — continúo sin borrar sesión.');
      return;
    }
    throw e;
  }
};

/* ===================== Prompt maestro ===================== */
const systemPrompt = `
Eres **Sana**, asistente virtual de la consulta de mastología del Dr. Juan Felipe Arias.

MISIÓN
- Recibir pacientes, hacer un triage clínico básico y gestionar agenda.
- Cuando necesites interactuar con el sistema (disponibilidad/agendar/guardar/cancelar), **devuelve únicamente un bloque JSON** con la acción correspondiente, **sin texto antes ni después**.
- **Nunca** declares una cita “confirmada” en texto. Primero emite el JSON; cuando el sistema (backend) responda, recién ahí entregas el resumen.

ESTILO
- Saluda y pídele el **nombre completo** al inicio.
- Habla con claridad y brevedad, sin emojis ni adornos.
- Dirígete por el **nombre** del paciente.
- Mantente en el tema clínico; si se desvían, redirígelo.
- No mezcles datos de otros pacientes ni “recuerdes” conversaciones ajenas.

PROTOCOLO PRIORITARIO (SMS) — BI-RADS 4 o 5
- Si detectas (por texto del paciente o porque el sistema te lo indica tras leer un PDF) **BI-RADS 4 o 5**, activa **flujo prioritario**:
  1) **No** consultes horarios ni intentes agendar.
  2) Solicita estos **datos obligatorios**: **Nombre**, **Apellido**, **Cédula**, **Correo**, **Teléfono**, **Dirección**. Pídelos en texto libre; **no** generes JSON.
  3) Cuando el paciente envíe los datos, responde solo: **“Gracias. Ya enviamos su solicitud a un asesor que se pondrá en contacto con usted.”** (el backend envía el SMS).
  4) Durante el período de prioridad (bloqueo de ~1 hora), **no generes JSON** ni pidas más datos; si el paciente escribe, **repite el mismo mensaje** y no ofrezcas citas.
- El sistema puede darte una **nota de sistema** (p. ej., “PRIORITARIO BI-RADS X. Bloqueado hasta …”). Mientras esté activo, respétalo.

FLUJO ESTRICTO (cuando NO hay prioridad activa)
1) Nombre completo.
2) **Motivo de consulta** (elige uno):
   - **Primera vez**
   - **Control presencial**
   - **Control de resultados virtual**
   - **Biopsia guiada por ecografía** (solo particular)
   - **Programación de cirugía** → transferir a humano (Isa/Deivis)
   - **Actualización de órdenes** → transferir a humano (Isa/Deivis)

3) **Seguro/entidad de salud**:
   - Atendemos pólizas y prepagadas: **Sudamericana, Colsanitas, Medplus, Bolívar, Allianz, Colmédica, Coomeva**.
   - También **particular**.
   - **No atendemos EPS** (indícalo con cortesía; puedes orientar a particular).

4) **Estudios de imagen y síntomas**:
   - Solicita el resultado más reciente de **mamografía/ecografía** y la **categoría BI-RADS**.
   - Si el paciente envía un **PDF**, úsalo: si el sistema te adjunta el **resumen** o la **categoría BI-RADS**, tómalos como válidos y **no vuelvas a pedir BI-RADS**.
   - Si **BI-RADS 4 o 5** → aplica el **PROTOCOLO PRIORITARIO (SMS)** (no agendas).
   - Si **BI-RADS 3** → preferir cita en **≤ 7 días hábiles**.
   - Si **BI-RADS 1–2** → mensaje tranquilizador; cita según disponibilidad estándar.
   - Si refiere **masa/nódulo < 3 meses** y no hay BI-RADS 4/5 → prioriza dentro de próximos días válidos (sin romper ventanas).

5) **Datos obligatorios antes de agendar (para cualquier cita)**:
   - **Nombre y apellido**
   - **Cédula**
   - **Entidad de salud** (o “particular”)
   - **Correo electrónico**
   - **Celular**
   - **Dirección** y **Ciudad** (si falta ciudad, pídela con cortesía)
   Si falta algo, **pídelo**. **No** generes JSON de crear_cita hasta tenerlos.

6) **Para “Primera vez”**, además (si existen):
   - Fecha de nacimiento, tipo de sangre, estado civil
   - Estudios previos: ¿tuvo?, ¿cuándo?, ¿dónde?

7) **Disponibilidad y agendamiento**:
   - Si el paciente pide **horarios de un día concreto** → envía **consultar_disponibilidad**.
   - Si pide “qué días tienes libres” o no da fecha → envía **consultar_disponibilidad_rango** desde **hoy** por **14 días**.
   - Para **BI-RADS 4–5** no consultes disponibilidad (ver PROTOCOLO PRIORITARIO).
   - Tras elegir hora:
     - **Primera vez** → primero **guardar_paciente**, luego **crear_cita**.
     - **Control presencial/virtual** → si ya tienes nombre, cédula, entidad, correo, celular, dirección y ciudad → **crear_cita**.

8) **Confirmación**:
   - No confirmes en texto por tu cuenta.
   - Cuando el sistema responda “OK/creada”, entrega **resumen**: fecha, hora y lugar + recordatorios/legales.

CANCELACIÓN DE CITA (verificación estricta, sin listar opciones)
- Flujo obligatorio:
  a) Pide primero la **cédula**.
  b) Luego pide **fecha (AAAA-MM-DD)** y **hora (HH:mm, 24h)** **exactas** de la cita que desea cancelar.
  c) Repite la fecha/hora que el paciente te dio y pide: “¿Confirmas que deseas cancelar esa cita?”.
  d) Solo si responde afirmativamente, envía **únicamente** el JSON:
     - Con ID (si ya lo conoces):
       {
         "action": "cancelar_cita",
         "data": { "cedula": "12345678", "eventId": "abc123", "confirm": true }
       }
     - Sin ID (verificación por cédula+fecha+hora):
       {
         "action": "cancelar_cita",
         "data": { "cedula": "12345678", "fecha": "2025-09-19", "hora": "14:30", "confirm": true }
       }
- **Nunca** listes ni reveles otras citas/horarios. Si falta algún dato o no coincide, indica que “no encontré una cita exactamente con esos datos” y vuelve a pedir la información exacta.

AGENDA (VENTANAS Y LÍMITES)
- **Lugar**: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
- **Duraciones**:
  - Primera vez: **20 min**
  - Control presencial: **15 min**
  - Control virtual (resultados): **10 min**
  - Biopsia: **30 min**
- **Ventanas por día/tipo** (**no romper**):
  - **Martes:** sin consulta (rechaza u ofrece otro día).
  - **Lunes (presencial):** 08:00–11:30 y 14:00–17:30.
  - **Miércoles/Jueves (presencial):** 14:00–16:30.
  - **Viernes presencial:** 08:00–11:30 (**no** presencial viernes tarde).
  - **Viernes virtual:** 14:00–16:30 (**solo** controles virtuales).
- **Límites**:
  - No fechas **pasadas**.
  - No **martes**.
  - No agendar **más allá de 15 días**.

COSTOS (si preguntan)
- Consulta de mastología: **350.000 COP**.
- Biopsia guiada por ecografía (solo particular): **800.000 COP** (incluye patología; **no** incluye consulta de lectura de patología).
- Medios de pago: **efectivo, transferencia**.

LEGALES Y RECORDATORIOS (al confirmar)
- Llegar **15 minutos** antes.
- Traer **impresos** todos los reportes previos: mamografías, ecografías, resonancias, informes de biopsia, resultados de cirugía/patología.
- **Grabaciones no autorizadas**: prohibido grabar audio/video durante la consulta sin autorización (Art. 15 Constitución Política de Colombia y Ley 1581 de 2012).

HANDOFF HUMANO
- Si corresponde: **Isa** o **Deivis** — WhatsApp **3108611759**.

REGLAS DURAS (NO ROMPER)
- Cuando muestres disponibilidad: formato **“9 de septiembre: 14:30, 14:15, …”** (no ISO) y **sin duración**.
- Si ya leíste resultados de PDF o sabes la categoría **BI-RADS**, primero da un **resumen muy breve** y **no vuelvas a pedir la categoría**; sigue el curso.
- No martes, no fuera de ventana, no pasado.
- No >15 días.
- No confirmar sin respuesta del sistema.
- **No mezclar texto y JSON** en el mismo mensaje.
- **No inventes horarios**: primero consulta disponibilidad y ofrece solo lo devuelto por el sistema.
- Si el sistema indica “ocupado” o “fuera de horario”, **no contradigas**: vuelve a pedir disponibilidad u ofrece alternativas válidas.

ACCIONES (JSON ONLY) — **formatos exactos**
1) Guardar paciente
{
  "action": "guardar_paciente",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "fecha_nacimiento": "1985-06-20",
    "tipo_sangre": "O+",
    "estado_civil": "Casada",
    "ciudad": "Barranquilla",
    "direccion": "Cra 45 #23-10",
    "correo": "ana@mail.com",
    "celular": "3101234567",
    "entidad_salud": "Colsanitas",
    "estudios_previos": "Sí",
    "fecha_estudio": "2024-02-10",
    "lugar_estudio": "Clínica Portoazul"
  }
}

2) Consultar disponibilidad (un día)
{
  "action": "consultar_disponibilidad",
  "data": { "tipo": "Control presencial", "fecha": "2025-10-06" }
}

3) Consultar días con cupo (rango)
{
  "action": "consultar_disponibilidad_rango",
  "data": { "tipo": "Control presencial", "desde": "2025-10-01", "dias": 14 }
}

4) Crear cita (solo futura, dentro de ventana y ≤15 días)
{
  "action": "crear_cita",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "entidad_salud": "Colsanitas",
    "tipo": "Control presencial",
    "inicio": "2025-10-06T08:00:00-05:00",
    "fin": "2025-10-06T08:15:00-05:00"
  }
}

5) Cancelar cita (requiere cédula + fecha + hora + confirmación)
{
  "action": "cancelar_cita",
  "data": {
    "cedula": "12345678",
    "fecha": "2025-09-19",
    "hora": "14:30",
    "confirm": true
  }
}
`;

/* ===================== Memoria por usuario ===================== */
const sessions = new Map(); // Map<fromId, {history, lastSystemNote, updatedAtISO, priority, cancelGuard, birads}>
const SESSION_TTL_MIN = 60;
const PRIORITY_LOCK_MIN = 60;
const PRIORITY_LOCK_MESSAGE = 'Ya enviamos su solicitud a un asesor que se pondrá en contacto con usted.';

const CANCEL_ATTEMPT_WINDOW_MIN = 60;
const CANCEL_ATTEMPT_MAX = 3;

function getSession(userId) {
  const now = DateTime.now().setZone(ZONE);
  let s = sessions.get(userId);
  const expired = s && now.diff(DateTime.fromISO(s.updatedAtISO || now.toISO())).as('minutes') > SESSION_TTL_MIN;

  if (!s || expired) {
    s = {
      history: [{ role: 'system', content: systemPrompt }],
      lastSystemNote: null,
      updatedAtISO: now.toISO(),
      priority: null,
      cancelGuard: { windowStartISO: now.toISO(), attempts: 0 },
      birads: null,
    };
    sessions.set(userId, s);
  }
  return s;
}
function touchSession(s) { s.updatedAtISO = DateTime.now().setZone(ZONE).toISO(); }
function capHistory(session, max = 40) {
  if (session.history.length > max) {
    const idx = session.history.findIndex(m => m.role === 'system');
    const base = idx >= 0 ? [session.history[idx]] : [];
    session.history = base.concat(session.history.slice(-(max - base.length)));
  }
}
function resetCancelGuardIfWindowExpired(session) {
  const now = DateTime.now().setZone(ZONE);
  const start = DateTime.fromISO(session.cancelGuard?.windowStartISO || now.toISO());
  if (now.diff(start, 'minutes').minutes >= CANCEL_ATTEMPT_WINDOW_MIN) {
    session.cancelGuard = { windowStartISO: now.toISO(), attempts: 0 };
  }
}
function incCancelAttempt(session) { resetCancelGuardIfWindowExpired(session); session.cancelGuard.attempts = (session.cancelGuard.attempts || 0) + 1; }
function tooManyCancelAttempts(session) { resetCancelGuardIfWindowExpired(session); return (session.cancelGuard.attempts || 0) >= CANCEL_ATTEMPT_MAX; }

/* ===================== Helpers agenda ===================== */
const norm = (s = '') => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
function duracionPorTipo(tipo = '') {
  const t = norm(tipo);
  if (t.includes('primera')) return 20;
  if (t.includes('control presencial')) return 15;
  if (t.includes('control virtual')) return 10;
  if (t.includes('biopsia')) return 30;
  return 15;
}
function ventanasPorDia(date, tipo = '') {
  const dow = date.weekday;
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  if (dow === 2) return v; // Martes no
  if (dow === 1) { // Lunes presencial
    if (t.includes('control virtual')) return v;
    push(H(8,0), H(11,30)); push(H(14,0), H(17,30)); return v;
  }
  if (dow === 3 || dow === 4) { // Mié/Jue tarde
    if (t.includes('control virtual')) return v;
    push(H(14,0), H(16,30)); return v;
  }
  if (dow === 5) { // Viernes
    if (t.includes('control virtual')) { push(H(14,0), H(16,30)); }
    else { push(H(8,0), H(11,30)); }
    return v;
  }
  return v;
}
function generarSlots(dateISO, tipo, maxSlots = 100) {
  const date = DateTime.fromISO(dateISO, { zone: ZONE });
  const ventanas = ventanasPorDia(date, tipo);
  const dur = duracionPorTipo(tipo);
  const slots = [];
  for (const win of ventanas) {
    let cursor = win.start;
    while (cursor.plus({ minutes: dur }) <= win.end) {
      const fin = cursor.plus({ minutes: dur });
      slots.push({ inicio: cursor.toISO({ suppressMilliseconds: true }), fin: fin.toISO({ suppressMilliseconds: true }) });
      cursor = fin;
      if (slots.length >= maxSlots) break;
    }
    if (slots.length >= maxSlots) break;
  }
  return { dur, ventanas, slots };
}
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }
async function consultarBusy(ventanas) {
  if (!ventanas.length) return [];
  const timeMin = ventanas[0].start.toUTC().toISO();
  const timeMax = ventanas[ventanas.length - 1].end.toUTC().toISO();
  const resp = await calendar.freebusy.query({ requestBody: { timeMin, timeMax, items: [{ id: CALENDAR_ID }], timeZone: ZONE } });
  const cal = resp.data.calendars?.[CALENDAR_ID];
  return (cal?.busy || []).map(b => ({ start: DateTime.fromISO(b.start, { zone: ZONE }), end: DateTime.fromISO(b.end, { zone: ZONE }) }));
}
function filtrarSlotsLibres(slots, busy) {
  if (!busy.length) return slots;
  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE }); const s2 = DateTime.fromISO(s.fin, { zone: ZONE });
    return !busy.some(b => overlaps(s1, s2, b.start, b.end));
  });
}
function slotDentroDeVentanas(startISO, endISO, tipo) {
  const s = DateTime.fromISO(startISO, { zone: ZONE }); const e = DateTime.fromISO(endISO, { zone: ZONE });
  const ventanas = ventanasPorDia(s, tipo);
  if (!ventanas.length) return false;
  return ventanas.some(w => s >= w.start && e <= w.end);
}
function coerceFutureISODate(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  while (d < today) d = d.plus({ years: 1 });
  return d.toISODate();
}
function coerceFutureISODateOrToday(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  return d < today ? today.toISODate() : d.toISODate();
}
function fmtFechaHumana(isoDate) { return DateTime.fromISO(isoDate, { zone: ZONE }).setLocale('es').toFormat('d LLLL'); }
function fmtHoraHumana(isoDateTime) { return DateTime.fromISO(isoDateTime, { zone: ZONE }).toFormat('H:mm'); }
function parseHoraToMinutes(raw = '') {
  let s = String(raw || '').toLowerCase().replace(/a\s*las\s*/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/(\d{1,2})(?::|\.|h)?\s*(\d{2})?/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10); let mm = m[2] ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(hh) || Number.isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/* ===================== BI-RADS & PACIENTE ===================== */
function detectarBirads(raw = '') {
  const s = String(raw || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').toUpperCase();
  const m = s.match(/\bBI\s*[-\s]?RADS?\s*[:\-]?\s*(0|1|2|3|4[ABC]?|5|6)\b/);
  return m ? m[1] : null;
}
function isPriorityBirads(b) { if (!b) return false; const u = String(b).toUpperCase(); return u.startsWith('4') || u.startsWith('5'); }
function parsePatientData(text = '') {
  const out = {}; const s = String(text || '');
  const get = (re, i = 1) => { const m = s.match(re); return m ? m[i].trim() : undefined; };
  out.nombre = get(/(?:^|\b)nombre\s*[:\-]?\s*([^\n,;]+)/i);
  out.apellido = get(/(?:^|\b)apellido\s*[:\-]?\s*([^\n,;]+)/i);
  out.cedula = get(/(?:c[eé]dula|cedula|cc|documento)\s*[:\-]?\s*([0-9.\-]+)/i);
  out.correo = get(/([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  const phone = s.match(/(\+?\d[\d\s\-]{7,}\d)/);
  out.telefono = phone ? phone[1].replace(/[\s\-]/g, '') : undefined;
  out.direccion = get(/(?:direcci[oó]n|direccion)\s*[:\-]?\s*([^\n]+)/i);
  const parts = s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if ((!out.nombre || !out.apellido || !out.cedula || !out.correo || !out.telefono || !out.direccion) && parts.length >= 6) {
    out.nombre = out.nombre || parts[0]; out.apellido = out.apellido || parts[1]; out.cedula = out.cedula || parts[2];
    out.correo = out.correo || (parts[3].includes('@') ? parts[3] : out.correo);
    out.telefono = out.telefono || parts[4].replace(/[\s\-]/g, ''); out.direccion = out.direccion || parts.slice(5).join(', ');
  }
  return out;
}
function missingPatientFields(d = {}) { return ['nombre','apellido','cedula','correo','telefono','direccion'].filter(k => !d[k] || !String(d[k]).trim()); }
async function sendAlertSMS(datos) {
  const body = `🚨 ALERTA PRIORITARIA (BI-RADS ${datos.birads || 'N/D'})
Paciente: ${datos.nombre || 'N/D'} ${datos.apellido || ''}
Cédula: ${datos.cedula || 'N/D'}
Correo: ${datos.correo || 'N/D'}
Teléfono: ${datos.telefono || 'N/D'}
Dirección: ${datos.direccion || 'N/D'}`;
  try {
    const message = await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to: ALERT_PHONE_NUMBER });
    console.log('✅ SMS enviado:', message.sid);
  } catch (err) { console.error('❌ Error enviando SMS:', err?.message || err); }
}
async function resumirPDF(textoPlano, birads) {
  const prompt = `Resume en 2–3 líneas, en español, los hallazgos clave de este informe. Incluye lateralidad si aparece, hallazgos relevantes y recomendación. Si hay BI-RADS, menciónalo como "BI-RADS ${birads || ''}". Evita datos personales.\n\n==== TEXTO ====\n${String(textoPlano || '').slice(0, 12000)}\n==== FIN ====\n`;
  try {
    const c = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Eres un asistente clínico que escribe resúmenes MUY breves y precisos en español (máx 3 líneas).' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2, max_tokens: 180,
    });
    return c.choices[0].message.content.trim();
  } catch (e) { console.error('⚠️ Error resumiendo PDF:', e?.message || e); return null; }
}

/* ===================== Cancelaciones ===================== */
async function cancelEventById(eventId) {
  try { await calendar.events.delete({ calendarId: CALENDAR_ID, eventId, sendUpdates: 'none' }); return { ok: true }; }
  catch (err) { const code = err?.response?.status || err?.code; return { ok: false, code, err }; }
}
async function findEventByCedulaAndLocal({ cedula, fechaISO, horaHHmm }) {
  if (!cedula || !fechaISO || !horaHHmm) return null;
  const day = DateTime.fromISO(fechaISO, { zone: ZONE }); if (!day.isValid) return null;
  const fechaTarget = day.toISODate(); const targetMinutes = parseHoraToMinutes(horaHHmm); if (targetMinutes == null) return null;
  const timeMin = day.startOf('day').toUTC().toISO(); const timeMax = day.endOf('day').toUTC().toISO();
  const resp = await calendar.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250, q: cedula });
  const items = resp.data.items || []; const normCed = String(cedula).replace(/\D/g, '');
  const byCedula = items.filter(ev => {
    if (!ev || !ev.description) return false;
    const desc = ev.description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const m = /cedula:\s*([0-9.\-]+)/i.exec(desc); const onlyDigits = m?.[1]?.replace(/\D/g, '') || '';
    return onlyDigits === normCed;
  });
  for (const ev of byCedula) {
    const startISO = ev.start?.dateTime; if (!startISO) continue;
    const startLocal = DateTime.fromISO(startISO, { zone: ZONE }); if (!startLocal.isValid) continue;
    const sameDate = startLocal.toISODate() === fechaTarget; const evMinutes = startLocal.hour * 60 + startLocal.minute;
    if (sameDate && evMinutes === targetMinutes) {
      return { eventId: ev.id, startISO: startLocal.toISO(), endISO: ev.end?.dateTime ? DateTime.fromISO(ev.end.dateTime, { zone: ZONE }).toISO() : null };
    }
  }
  return null;
}

/* ===================== Reparador JSON acciones ===================== */
function repairJSON(raw = '') {
  let s = String(raw || '');
  s = s.replace(/```/g, '').replace(/\bjson\b/gi, '');
  s = s.replace(/[\u00A0\u200B\uFEFF]/g, ' ');
  s = s.replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s.trim();
}
function extractActionJSONBlocks(text = '') {
  const cleaned = repairJSON(text);
  const out = [];
  const idx = cleaned.indexOf('"action"');
  if (idx !== -1) {
    let start = cleaned.lastIndexOf('{', idx);
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try { const obj = JSON.parse(candidate); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {}
          break;
        }
      }
    }
  }
  if (out.length === 0) {
    const objs = cleaned.match(/\{[\s\S]*?\}/g) || [];
    for (const raw of objs) { try { const obj = JSON.parse(raw); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {} }
  }
  return out;
}

/* ===================== Acciones IA (usa sesión) ===================== */
async function maybeHandleAssistantAction(text, session) {
  const payloads = extractActionJSONBlocks(text);
  if (!payloads.length) return null;

  const results = [];
  const now = DateTime.now().setZone(ZONE);

  for (const payload of payloads) {
    const action = norm(payload.action || '');

    if (action === 'consultar_disponibilidad') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { fecha } = payload.data || {};
      if (fecha) fecha = coerceFutureISODate(fecha);
      const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
      if (!ventanas.length) { results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: [], note: 'Día sin consulta' }); continue; }
      const busy = await consultarBusy(ventanas);
      const libres = filtrarSlotsLibres(slots, busy).slice(0, 12);
      results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
      continue;
    }

    if (action === 'consultar_disponibilidad_rango') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { desde, dias = 14 } = payload.data || {};
      const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : now.toISODate();
      if (dias > 15) dias = 15;
      const lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
      results.push({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: lista });
      continue;
    }

    if (action === 'crear_cita') {
      const d = payload.data || {};
      const s = DateTime.fromISO(d.inicio, { zone: ZONE });
      const e = DateTime.fromISO(d.fin, { zone: ZONE });
      if (!s.isValid || !e.isValid || s >= e) { results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' }); session.lastSystemNote = 'Falló: fecha/hora inválida.'; continue; }
      const maxDay = now.plus({ days: 15 }).endOf('day');
      if (s < now) { results.push({ ok: false, error: 'fecha_pasada', message: 'La hora ya pasó. Elige fecha futura.' }); session.lastSystemNote = 'Falló: fecha pasada.'; continue; }
      if (s > maxDay) { results.push({ ok: false, error: 'fuera_rango', message: 'No agendamos más allá de 15 días.' }); session.lastSystemNote = 'Falló: +15 días.'; continue; }
      if (!slotDentroDeVentanas(d.inicio, d.fin, d.tipo)) { results.push({ ok: false, error: 'fuera_horario', message: 'Día/horario no válido según reglas.' }); session.lastSystemNote = 'Falló: fuera horario.'; continue; }

      const fb = await calendar.freebusy.query({ requestBody: { timeMin: s.toUTC().toISO(), timeMax: e.toUTC().toISO(), items: [{ id: CALENDAR_ID }], timeZone: ZONE } });
      const cal = fb.data.calendars?.[CALENDAR_ID];
      const busy = (cal?.busy || []).map(b => ({ start: DateTime.fromISO(b.start, { zone: ZONE }), end: DateTime.fromISO(b.end, { zone: ZONE }) }));
      const solapa = busy.some(b => overlaps(s, e, b.start, b.end));
      if (solapa) { results.push({ ok: false, error: 'slot_ocupado', message: 'Ese horario ya está reservado. Elige otra opción.' }); session.lastSystemNote = 'Falló: solapado.'; continue; }

      try {
        const ins = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: `[${d.tipo}] ${d.nombre} (${d.entidad_salud})`,
            location: 'Clínica Portoazul, piso 7, consultorio 707, Barranquilla',
            description: `Cédula: ${d.cedula}\nEntidad: ${d.entidad_salud}\nTipo: ${d.tipo}`,
            start: { dateTime: s.toISO(), timeZone: ZONE },
            end:   { dateTime: e.toISO(), timeZone: ZONE },
          },
        });
        results.push({ ok: true, eventId: ins.data.id, htmlLink: ins.data.htmlLink || null });
        session.lastSystemNote = 'Cita creada en Google Calendar (ok).';
      } catch (err) {
        console.error('❌ Error creando evento:', err?.response?.data || err);
        results.push({ ok: false, error: 'gcal_insert_error', message: 'No se pudo crear la cita en Google Calendar.' });
        session.lastSystemNote = 'Falló insertar en Calendar.';
      }
      continue;
    }

    if (action === 'guardar_paciente') { results.push({ ok: true, saved: true }); continue; }

    if (action === 'cancelar_cita') {
      const d = payload.data || {};
      const cedula = (d.cedula || '').trim();
      if (!cedula) { results.push({ ok: false, error: 'falta_cedula', message: 'Necesito la cédula para ubicar tu cita.' }); continue; }
      if (tooManyCancelAttempts(session)) { results.push({ ok: false, error: 'rate_limited', message: 'Demasiados intentos. Habla con un asesor.' }); continue; }

      if (d.eventId && d.confirm === true) {
        const del = await cancelEventById(d.eventId);
        if (!del.ok) { results.push({ ok: false, error: 'cancel_error', code: del.code, message: 'No se pudo cancelar la cita.' }); continue; }
        results.push({ ok: true, cancelled: true, eventId: d.eventId }); session.lastSystemNote = 'Se canceló una cita (ok).'; continue;
      }

      const fecha = (d.fecha || '').trim(); const hora = (d.hora || '').trim();
      if (!fecha || !hora) { results.push({ ok: false, error: 'falta_fecha_hora', message: 'Indícame fecha (AAAA-MM-DD) y hora (HH:mm).' }); continue; }
      const horaOk = parseHoraToMinutes(d.hora);
      if (horaOk == null) { results.push({ ok: false, error: 'hora_invalida', message: 'Hora inválida. Usa 24h: 08:00 o 14:30.' }); continue; }

      const found = await findEventByCedulaAndLocal({ cedula, fechaISO: fecha, horaHHmm: hora });
      if (!found) { incCancelAttempt(session); results.push({ ok: false, error: 'no_encontrada', message: 'No encontré una cita exactamente con esos datos.' }); continue; }
      if (d.confirm !== true) { results.push({ ok: false, error: 'requiere_confirmacion', message: 'Confirma si deseas cancelar la cita indicada.' }); continue; }

      const del = await cancelEventById(found.eventId);
      if (!del.ok) { results.push({ ok: false, error: 'cancel_error', code: del.code, message: 'No se pudo cancelar la cita.' }); continue; }
      results.push({ ok: true, cancelled: true, eventId: found.eventId }); session.lastSystemNote = 'Se canceló una cita (ok).';
      continue;
    }
  }

  if (results.length === 1) return { handled: true, makeResponse: results[0] };
  return { handled: true, makeResponse: results };
}

/* ===================== /chat (IA por sesión) ===================== */
app.post('/chat', async (req, res) => {
  const from = String(req.body.from || 'anon');
  const userMsg = String(req.body.message || '').trim();

  const session = getSession(from);
  const now = DateTime.now().setZone(ZONE);

  if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) session.priority = null;
  if (session.priority?.active && session.priority.status === 'submitted') return res.json({ reply: PRIORITY_LOCK_MESSAGE });

  if (userMsg === '__RESET__') { sessions.delete(from); return res.json({ ok: true, reset: true }); }

  const todayNote = `Hoy es ${DateTime.now().setZone(ZONE).toISODate()} (${ZONE}). Reglas: Martes sin consulta; virtual solo viernes tarde; no más de 15 días ni fechas pasadas.`;
  session.history.push({ role: 'system', content: todayNote });
  if (session.birads) session.history.push({ role: 'system', content: `BIRADS ${session.birads} detectado previamente. No pidas de nuevo la categoría.` });
  if (session.lastSystemNote) { session.history.push({ role: 'system', content: session.lastSystemNote }); session.lastSystemNote = null; }

  session.history.push({ role: 'user', content: userMsg });
  capHistory(session); touchSession(session);

  try {
    const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: session.history });
    let reply = completion.choices[0].message.content || '';
    const actionResult = await maybeHandleAssistantAction(reply, session);

    if (actionResult?.handled && actionResult.makeResponse) {
      const mr = actionResult.makeResponse;
      const many = Array.isArray(mr) ? mr : [mr];
      const errors = many.filter(x => x && x.ok === false);
      const daysResp = many.find(x => Array.isArray(x?.dias_disponibles));
      const daySlots = many.find(x => Array.isArray(x?.slots));
      const cancelled = many.find(x => x && x.cancelled === true);

      if (cancelled) {
        reply = '✅ Tu cita fue cancelada. Si deseas agendar otra, dime la fecha o qué días te sirven y lo hacemos.';
      } else if (errors.length) {
        reply = errors.map(e => `⚠️ ${e.message || 'Operación no completada.'}`).join('\n\n');
      } else if (daySlots) {
        if (!daySlots.slots.length) reply = `Para ${fmtFechaHumana(daySlots.fecha)} no hay cupos válidos. ¿Quieres otra fecha?`;
        else {
          const fechaTxt = fmtFechaHumana(daySlots.fecha);
          const horas = daySlots.slots.map(s => fmtHoraHumana(s.inicio)).join(', ');
          reply = `${fechaTxt}: ${horas}\n\n¿Te sirve alguna hora? Responde con la hora exacta (ej. "8:15").`;
        }
      } else if (daysResp) {
        if (!daysResp.dias_disponibles.length) reply = `No tengo cupos en los próximos ${daysResp.dias} días. ¿Probamos otro rango?`;
        else {
          const lineas = daysResp.dias_disponibles.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Horarios disponibles:\n${lineas}\n\n¿Cuál eliges?`;
        }
      }

      session.history.push({ role: 'assistant', content: reply });
      capHistory(session); touchSession(session);
      return res.json({ reply, makeResponse: actionResult.makeResponse });
    }

    // Fallback cuando el user pide "disponibilidad" sin JSON
    const u = userMsg.toLowerCase();
    const pideDispon = /disponibilidad|horarios|agenda|qué días|que dias|que horarios|que horario/.test(u);
    if (!actionResult && pideDispon) {
      try {
        const desde = DateTime.now().setZone(ZONE).toISODate();
        const tipo = 'Control presencial';
        const dias = 14;
        const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desde, dias });
        if (!diasDisp.length) reply = `No tengo cupos en los próximos ${dias} días. ¿Probamos otro rango o tipo (virtual viernes tarde)?`;
        else {
          const lineas = diasDisp.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Horarios disponibles:\n${lineas}\n\n¿Cuál eliges?`;
        }
      } catch (e) { console.error('❌ Fallback disponibilidad error:', e); reply = '⚠️ No pude consultar la disponibilidad ahora. Intenta de nuevo en unos minutos.'; }
    }

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session); touchSession(session);
    res.json({ reply, makeResponse: null });
  } catch (e) {
    console.error('OpenAI error:', e);
    res.status(500).json({ error: 'ai_error' });
  }
});

/* ====== Disponibilidad por rango ====== */
async function disponibilidadPorDias({ tipo, desdeISO, dias = 14, maxSlotsPorDia = 6 }) {
  if (dias > 15) dias = 15;
  if (dias > 10) dias = 10;
  const start = DateTime.fromISO(desdeISO, { zone: ZONE });
  const diasLista = []; for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3;
  const out = []; let idx = 0;

  async function worker() {
    while (true) {
      let d; if (idx < diasLista.length) { d = diasLista[idx]; idx += 1; } else break;
      try {
        const dISO = d.toISODate();
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 200);
        if (!ventanas.length) continue;
        const busy = await consultarBusy(ventanas);
        const libres = filtrarSlotsLibres(slots, busy);
        if (libres.length > 0) {
          out.push({
            fecha: dISO, duracion_min: dur, total: libres.length,
            ejemplos: libres.slice(0, maxSlotsPorDia).map(s => DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('H:mm')),
            slots: libres.slice(0, maxSlotsPorDia),
          });
        }
      } catch (e) { console.error('⚠️ Error consultando día:', e); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return out;
}

/* ===================== WA PANEL STATE (para tu panel) ===================== */
let IA_GLOBAL_ON = true;
const chatIAState = new Map();           // key: '57300...@c.us' -> true/false
const conversationsMeta = new Map();     // id/name/number/lastMessage/lastTime/labels

const waStatus = { status: 'initializing', lastHeartbeat: null, requiresQR: false };

// Endpoints para el panel
app.get('/health/session', async (req, res) => {
  const state = await getStateSafe();
  const requiresQR = waStatus.requiresQR;
  res.json({ status: state?.toLowerCase?.() || 'unknown', lastHeartbeat: waStatus.lastHeartbeat, requiresQR, captcha: false });
});
app.post('/ai/toggle', (req, res) => {
  const { global_state } = req.body || {};
  if (typeof global_state === 'string') IA_GLOBAL_ON = global_state === 'on';
  if (typeof global_state === 'boolean') IA_GLOBAL_ON = !!global_state;
  res.json({ success: true, global: IA_GLOBAL_ON });
});
app.get('/conversations', (req, res) => {
  const items = Array.from(conversationsMeta.values()).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  res.json({ items });
});
app.patch('/conversations/:id/state', (req, res) => {
  const id = req.params.id;
  const { ia_state, until } = req.body || {};
  const on = ia_state === 'on' || ia_state === true;
  chatIAState.set(id, on);
  if (conversationsMeta.has(id)) {
    const c = conversationsMeta.get(id);
    c.iaOn = on; c.silencedUntil = until || null;
    conversationsMeta.set(id, c);
  }
  res.json({ success: true });
});

/* ===================== WHATSAPP WEB ===================== */
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'prod-qr',
    dataPath: WWEB_DATA_DIR,          // sesión persiste (Render: /var/data/wwebjs_auth)
  }),
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  takeoverTimeoutMs: 60000,
  qrMaxRetries: 999,
  webVersionCache: { type: 'local', path: './.wwebjs_cache' },
  puppeteer: {
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-features=FirstPartySets',
      '--single-process',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    timeout: 0,
  },
});

client.on('qr', (qr) => { waStatus.requiresQR = true; console.log('📲 QR generado. Escanéalo:'); qrcode.generate(qr, { small: true }); });
client.on('ready', async () => { waStatus.requiresQR = false; console.log('✅ WhatsApp Web listo.'); });
client.on('auth_failure', (m) => { console.error('❌ auth_failure:', m); });
client.on('change_state', (st) => { waStatus.status = String(st || '').toLowerCase(); });
client.on('disconnected', (reason) => {
  console.error('❌ WhatsApp desconectado:', reason);
  // No borrar sesión; reintento controlado
  scheduleReinit(5000);
});

setInterval(() => { waStatus.lastHeartbeat = DateTime.now().toISO(); }, 15000);

let reinitTimer = null;
function scheduleReinit(ms = 5000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try { client.initialize(); } catch (e) { console.error('reinit error:', e?.message || e); }
  }, ms);
}

async function getStateSafe() {
  try { return await client.getState(); } catch { return 'DISCONNECTED'; }
}

async function sendWhatsAppText(toChatId, body) {
  const state = await getStateSafe();
  if (state !== 'CONNECTED') {
    console.warn(`[sendWhatsAppText] cancelado — state=${state}`);
    return false;
  }
  try {
    await client.sendMessage(toChatId, String(body || '').slice(0, 4096));
    return true;
  } catch (e) {
    console.error('sendMessage error:', e?.message || e);
    return false;
  }
}

async function downloadPdfFromMessage(message) {
  try {
    const media = await message.downloadMedia();
    if (!media) return null;
    const mime = String(media.mimetype || '').toLowerCase();
    if (!mime.startsWith('application/pdf')) return null;
    const buf = Buffer.from(media.data, 'base64');
    return buf;
  } catch (e) { console.error('⚠️ Error descargando media:', e); return null; }
}

const toPanelId = (msg) => msg.from; // '57300...@c.us'
const toHumanNumber = (fromId) => fromId.replace('@c.us', '').replace('@g.us', '');

// Handler de mensajes entrantes
client.on('message', async (msg) => {
  try {
    const fromId = msg.from;
    const number = toHumanNumber(fromId);
    const session = getSession(fromId);
    const now = DateTime.now().setZone(ZONE);

    conversationsMeta.set(fromId, {
      id: fromId,
      name: msg._data?.notifyName || number,
      number,
      lastMessage: msg.body || msg.type,
      lastTime: Date.now(),
      labels: [],
      iaOn: chatIAState.has(fromId) ? chatIAState.get(fromId) : true,
      silencedUntil: null
    });

    const chatOn = chatIAState.has(fromId) ? chatIAState.get(fromId) : true;
    if (!IA_GLOBAL_ON || !chatOn) return;

    if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) session.priority = null;
    if (session.priority?.active && session.priority.status === 'submitted') { await sendWhatsAppText(fromId, PRIORITY_LOCK_MESSAGE); return; }

    let userText = '';
    let biradsDetectado = null;

    if (msg.hasMedia) {
      const buf = await downloadPdfFromMessage(msg);
      if (buf) {
        try {
          const parsed = await pdf(buf);
          const birads = detectarBirads(parsed.text || ''); biradsDetectado = birads;
          const resumen = await resumirPDF(parsed.text || '', birads || ''); if (resumen) await sendWhatsAppText(fromId, `📝 Resumen del PDF:\n${resumen}`);
          if (birads) {
            session.birads = birads;
            if (isPriorityBirads(birads)) {
              const lockUntil = now.plus({ minutes: PRIORITY_LOCK_MIN }).toISO();
              session.priority = { active: true, status: 'collecting', birads, startedAtISO: now.toISO(), lockUntilISO: lockUntil, sentSMS: false, data: {} };
              session.lastSystemNote = `PRIORITARIO BI-RADS ${birads}. Bloqueado hasta ${lockUntil}.`;
              await sendWhatsAppText(fromId, 'Detectamos un resultado prioritario. Por favor envíe: Nombre, Apellido, Cédula, Correo, Teléfono, Dirección.');
              return;
            } else {
              session.lastSystemNote = `BIRADS ${birads} detectado desde PDF. No pidas de nuevo la categoría; procede según reglas.`;
              userText = `BI-RADS ${birads} detectado por PDF. Continúa el flujo clínico.`;
            }
          } else userText = 'Leí tu PDF pero no detecté la categoría BI-RADS. ¿Cuál es tu BI-RADS?';
        } catch (e) { console.error('❌ Error procesando PDF:', e); userText = 'Tu PDF llegó pero hubo un problema al leerlo. ¿Puedes confirmar la categoría BI-RADS o reenviarlo?'; }
      } else userText = '📎 Recibí tu archivo. Por ahora solo puedo leer PDFs para extraer un breve resumen y BI-RADS.';
    } else {
      if (msg.type === 'chat') {
        userText = msg.body || '';
        const b = detectarBirads(userText); if (b) biradsDetectado = b;
      } else if (msg.type === 'buttons_response' || msg.type === 'list_response') {
        userText = msg.body || msg.selectedButtonId || msg.selectedRowId || 'OK';
      } else userText = 'Recibí tu mensaje. ¿Cómo quieres continuar?';
    }

    if (isPriorityBirads(biradsDetectado) && !(session.priority?.active)) {
      const lockUntil = now.plus({ minutes: PRIORITY_LOCK_MIN }).toISO();
      session.priority = { active: true, status: 'collecting', birads: biradsDetectado, startedAtISO: now.toISO(), lockUntilISO: lockUntil, sentSMS: false, data: {} };
      session.lastSystemNote = `PRIORITARIO BI-RADS ${biradsDetectado}. Bloqueado hasta ${lockUntil}.`;
      await sendWhatsAppText(fromId, 'Detectamos un resultado prioritario. Por favor envíe: Nombre, Apellido, Cédula, Correo, Teléfono, Dirección.');
      return;
    }

    if (session.priority?.active && session.priority.status === 'collecting') {
      const parsed = parsePatientData(userText);
      session.priority.data = { ...session.priority.data, ...parsed };
      const faltan = missingPatientFields(session.priority.data);
      if (faltan.length === 0 && !session.priority.sentSMS) {
        await sendAlertSMS({ ...session.priority.data, birads: session.priority.birads });
        session.priority.sentSMS = true; session.priority.status = 'submitted';
        await sendWhatsAppText(fromId, '✅ Gracias. ' + PRIORITY_LOCK_MESSAGE);
        return;
      }
      if (faltan.length > 0) {
        await sendWhatsAppText(fromId, `Para avanzar, por favor envíe los datos faltantes: ${faltan.join(', ')}.\nFormato sugerido:\nNombre, Apellido, Cédula, Correo, Teléfono, Dirección.`);
        return;
      }
    }

    await sendWhatsAppText(fromId, '⏳ Un momento, estoy consultando…');

    try {
      const r = await fetch(`http://localhost:${PORT}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromId, message: userText }),
      });
      const data = await r.json().catch(() => null);
      const botReply = data?.reply || 'Ups, no pude procesar tu mensaje.';
      await sendWhatsAppText(fromId, botReply);
    } catch (e) {
      console.error('❌ Error en procesamiento diferido:', e?.message || e);
      await sendWhatsAppText(fromId, '⚠️ Hubo un problema consultando. Intenta otra vez.');
    }
  } catch (e) { console.error('❌ Handler message error:', e?.message || e); }
});

/* ===================== ARRANQUE ===================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
client.initialize();
