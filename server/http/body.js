/**
 * Lecture et analyse du corps des requetes.
 *
 * Aucune bibliotheque externe n'intervient ici : le corps est lu avec une borne
 * stricte, puis analyse selon son type declare. Une requete qui depasse la
 * limite est interrompue des le depassement, sans attendre la fin du flux.
 */
import { badRequest, tooLarge, unsupportedMedia } from '../core/errors.js';
import { sansOctetNul } from '../core/text.js';

/* ------------------------------------------------------------------ */
/*  Lecture brute                                                      */
/* ------------------------------------------------------------------ */

/**
 * Lit integralement le corps de la requete, dans la limite indiquee.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    // Content-Length permet de refuser immediatement, sans lire un seul octet.
    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(tooLarge('Le contenu envoye depasse la limite autorisee.'));
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(tooLarge('Le contenu envoye depasse la limite autorisee.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });

    req.on('error', (err) => fail(badRequest('Lecture de la requete interrompue : ' + err.message)));
    req.on('aborted', () => fail(badRequest('Requete interrompue par le client.')));
  });
}

/* ------------------------------------------------------------------ */
/*  Types de contenu                                                   */
/* ------------------------------------------------------------------ */

/** Extrait le type MIME et ses parametres de l'en-tete Content-Type. */
export function parseContentType(header) {
  if (!header) return { type: '', params: {} };
  const [rawType, ...rest] = String(header).split(';');
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type: rawType.trim().toLowerCase(), params };
}

/* ------------------------------------------------------------------ */
/*  JSON                                                               */
/* ------------------------------------------------------------------ */

/** Analyse un corps JSON en refusant tout ce qui n'est pas un objet. */
export function parseJsonBody(buffer) {
  if (!buffer.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw badRequest('Le corps de la requete n est pas un JSON valide.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Le corps de la requete doit etre un objet JSON.');
  }
  // Neutralise la pollution de prototype : une cle "__proto__" recue depuis le
  // reseau ne doit jamais atteindre Object.prototype.
  return sanitizeKeys(parsed);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeKeys(input, depth = 0) {
  if (depth > 12) throw badRequest('Structure JSON trop profonde.');
  if (Array.isArray(input)) return input.map((v) => sanitizeKeys(v, depth + 1));
  if (input === null || typeof input !== 'object') return input;

  const out = Object.create(null);
  for (const [key, val] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    // O-7 : l'octet nul est retire ici, ou passent TOUTES les valeurs de
    // TOUTES les routes — un correctif loge dans un convertisseur de
    // validate.js n'aurait couvert que les champs de ce type-la, et
    // POST /api/auth/login serait tombe pareil.
    out[key] = sansOctetNul(sanitizeKeys(val, depth + 1));
  }
  // On repasse par un objet ordinaire pour rester manipulable comme tel.
  return Object.assign({}, out);
}

/* ------------------------------------------------------------------ */
/*  Formulaires URL-encodes                                            */
/* ------------------------------------------------------------------ */

export function parseUrlEncodedBody(buffer) {
  const params = new URLSearchParams(buffer.toString('utf8'));
  const out = {};
  for (const [key, val] of params) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = sansOctetNul(val);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  multipart/form-data                                                */
/* ------------------------------------------------------------------ */

/**
 * Analyse un corps multipart/form-data deja mis en memoire.
 *
 * Implementation volontairement conservatrice : on ne traite que ce dont
 * l'application a besoin (champs simples et fichiers), et toute structure
 * inattendue est rejetee plutot qu'interpretee au mieux.
 *
 * @param {Buffer} buffer
 * @param {string} boundary
 * @param {{ maxFiles?: number }} [opts]
 * @returns {{ fields: Record<string,string>, files: Array<{field:string,filename:string,mimeType:string,content:Buffer}> }}
 */
export function parseMultipartBody(buffer, boundary, opts = {}) {
  const { maxFiles = 10 } = opts;
  if (!boundary) throw badRequest('Limite (boundary) absente de l en-tete multipart.');

  const delimiter = Buffer.from('--' + boundary);
  const fields = {};
  const files = [];

  let position = buffer.indexOf(delimiter);
  if (position === -1) throw badRequest('Corps multipart mal forme.');
  position += delimiter.length;

  let guard = 0;
  while (position < buffer.length) {
    if (++guard > 200) throw badRequest('Trop de sections dans le formulaire.');

    // Fin du flux : "--" apres la derniere limite.
    if (buffer[position] === 0x2d && buffer[position + 1] === 0x2d) break;

    // Saute le CRLF qui suit la limite.
    if (buffer[position] === 0x0d && buffer[position + 1] === 0x0a) position += 2;
    else break;

    const headerEnd = buffer.indexOf('\r\n\r\n', position);
    if (headerEnd === -1) throw badRequest('En-tetes de section multipart introuvables.');

    const rawHeaders = buffer.toString('utf8', position, headerEnd);
    const bodyStart = headerEnd + 4;

    const nextDelimiter = buffer.indexOf(delimiter, bodyStart);
    if (nextDelimiter === -1) throw badRequest('Section multipart non terminee.');

    // Le CRLF precedant la limite suivante n'appartient pas au contenu.
    const bodyEnd = nextDelimiter - 2;
    const content = buffer.subarray(bodyStart, Math.max(bodyStart, bodyEnd));

    const { name, filename, contentType } = parsePartHeaders(rawHeaders);
    if (name && !FORBIDDEN_KEYS.has(name)) {
      if (filename !== null) {
        if (files.length >= maxFiles) throw badRequest('Trop de fichiers envoyes en une seule fois.');
        // Un champ fichier vide (aucun fichier choisi) est simplement ignore.
        if (filename !== '' && content.length > 0) {
          files.push({
            field: name,
            filename,
            mimeType: contentType || 'application/octet-stream',
            content,
          });
        }
      } else {
        fields[name] = content.toString('utf8');
      }
    }

    position = nextDelimiter + delimiter.length;
  }

  return { fields, files };
}

function parsePartHeaders(rawHeaders) {
  let name = null;
  let filename = null;
  let contentType = null;

  for (const line of rawHeaders.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();

    if (key === 'content-disposition') {
      const nameMatch = val.match(/;\s*name="([^"]*)"/i);
      const fileMatch = val.match(/;\s*filename="([^"]*)"/i);
      if (nameMatch) name = nameMatch[1];
      if (fileMatch) filename = fileMatch[1];
    } else if (key === 'content-type') {
      contentType = parseContentType(val).type;
    }
  }

  return { name, filename, contentType };
}

/* ------------------------------------------------------------------ */
/*  Point d'entree                                                     */
/* ------------------------------------------------------------------ */

/**
 * Lit et analyse le corps selon son type declare.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ jsonLimit:number, uploadLimit:number }} limits
 */
export async function parseBody(req, limits) {
  const { type, params } = parseContentType(req.headers['content-type']);

  if (!type) {
    // Un corps non declare est ignore : POST sans contenu reste valide.
    return { body: {}, files: [] };
  }

  if (type === 'application/json') {
    const buffer = await readBody(req, limits.jsonLimit);
    return { body: parseJsonBody(buffer), files: [] };
  }

  if (type === 'application/x-www-form-urlencoded') {
    const buffer = await readBody(req, limits.jsonLimit);
    return { body: parseUrlEncodedBody(buffer), files: [] };
  }

  if (type === 'multipart/form-data') {
    const buffer = await readBody(req, limits.uploadLimit);
    const { fields, files } = parseMultipartBody(buffer, params.boundary);
    return { body: fields, files };
  }

  throw unsupportedMedia('Type de contenu non pris en charge : ' + type);
}
