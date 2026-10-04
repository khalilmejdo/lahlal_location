/**
 * L'echafaudage des essais d'integration.
 *
 * Il monte une base NEUVE, applique le schema, seme les referentiels et
 * demarre un vrai serveur sur un port a lui. Les essais parlent ensuite a
 * l'application par HTTP, comme le navigateur — pas en appelant les
 * fonctions de l'interieur.
 *
 * POURQUOI UNE BASE JETABLE PLUTOT QUE CELLE DE DEVELOPPEMENT.
 *
 * Un essai qui s'execute sur la base de travail finit par en dependre : il
 * passe parce que le vehicule qu'il cherche existe, et il echoue le jour ou
 * quelqu'un l'archive. Ici, chaque execution repart de zero, et l'etat
 * teste est celui que l'essai a lui-meme cree.
 *
 * La base est nommee d'apres l'horodatage : deux executions simultanees ne
 * se marchent pas dessus, et une execution interrompue laisse une base
 * qu'on retrouve pour comprendre.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import pg from 'pg';

const RACINE = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** La base d'administration, d'ou l'on cree et detruit les bases d'essai. */
function urlAdministration(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

function urlAvecBase(url, nom) {
  const u = new URL(url);
  u.pathname = '/' + nom;
  return u.toString();
}

/**
 * La chaine de connexion des essais.
 *
 * TEST_DATABASE_URL si elle est posee, sinon DATABASE_URL du fichier .env.
 * On ne devine JAMAIS : sans l'une ni l'autre, les essais s'arretent en le
 * disant, plutot que de tomber sur une base de production par defaut.
 */
async function urlDeBase() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const { config } = await import('../../server/core/config.js');
  if (!config.db.url) {
    throw new Error(
      'Aucune base pour les essais : posez TEST_DATABASE_URL, ou DATABASE_URL dans .env.',
    );
  }
  return config.db.url;
}

async function executer(url, sql) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

/** Lance une commande npm/node du projet avec la base d'essai. */
function lancer(script, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], {
      cwd: RACINE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sortie = '';
    p.stdout.on('data', (d) => { sortie += d; });
    p.stderr.on('data', (d) => { sortie += d; });
    p.on('close', (code) => {
      if (code === 0) resolve(sortie);
      else reject(new Error(script + ' a echoue (' + code + ') :\n' + sortie));
    });
  });
}

/**
 * Monte tout, et rend de quoi parler a l'application.
 *
 * @returns {Promise<{base: string, arreter: () => Promise<void>, appel: Function, connexion: Function}>}
 */
export async function monterApplication({ port = 8199 } = {}) {
  const urlSource = await urlDeBase();
  const nomBase = 'flotte_test_' + Date.now().toString(36);
  const urlBase = urlAvecBase(urlSource, nomBase);
  const dossierDonnees = fs.mkdtempSync(path.join(os.tmpdir(), 'flotte-essai-'));

  await executer(urlAdministration(urlSource), 'CREATE DATABASE ' + nomBase);

  const env = {
    NODE_ENV: 'development',
    // Le meme fuseau que la production : sans lui, les essais qui parlent
    // d'« aujourd'hui » tomberaient une heure par jour.
    TZ: 'Africa/Casablanca',
    DATABASE_URL: urlBase,
    DATABASE_SSL: 'off',
    PORT: String(port),
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: 'http://127.0.0.1:' + port,
    SECURE_COOKIES: 'false',
    ENABLE_HSTS: 'false',
    BOOTSTRAP_ADMIN_USERNAME: 'essai',
    BOOTSTRAP_ADMIN_PASSWORD: 'MotDePasseEssai2026!',
    // Large, pour que la limitation de debit ne fasse pas echouer une suite
    // qui enchaine les appels. Ce qu'elle protege est teste ailleurs.
    RATE_LIMIT_MAX: '100000',

    /*
     * UN DOSSIER DE DONNEES A SOI, et c'est indispensable.
     *
     * Le dossier `data/` du projet porte l'ancre externe du journal
     * d'audit : la tete de chaine de la base de DEVELOPPEMENT. Un serveur
     * d'essai qui le partage confronte sa propre chaine — celle d'une base
     * neuve, a quelques entrees — a une ancre qui en atteste quarante :
     * la verification conclut a une alteration, et l'essai echoue en
     * accusant un code parfaitement sain.
     *
     * Avec son propre dossier, l'ancre est REELLEMENT exercee : elle
     * s'ecrit, et la verification la confronte a ce qu'elle a ecrit.
     */
    DATA_DIR: dossierDonnees,
    AUDIT_ANCRE_EXTERNE: 'true',
    TRUST_PROXY: 'false',
  };

  await lancer('scripts/migrate.js', env);
  await lancer('scripts/seed.js', env);

  /*
   * Le super-administrateur, cree comme en production : par le script, donc
   * depuis le serveur, jamais depuis un ecran.
   *
   * Trois gestes lui sont reserves — gerer les comptes, redefinir les
   * droits d'un role, restaurer une piece jointe. Sans lui, la suite ne
   * pourrait verifier ni ces trois gestes, ni le fait qu'ils sont refuses
   * a l'administrateur. Le mot de passe s'affiche une fois : on le lit
   * dans la sortie du script, exactement comme l'exploitant le ferait.
   */
  const sortieSuperadmin = await lancer('scripts/superadmin.js', env);
  // Ancre sur la ligne entiere : le script parle aussi du « mot de passe »
  // dans ses explications, et un motif lache y capturerait un mot ordinaire.
  const motDePasseSuperadmin = sortieSuperadmin.match(/^\s*mot de passe\s+(\S+)\s*$/m)?.[1];
  if (!motDePasseSuperadmin) {
    throw new Error('Le mot de passe du super-administrateur ne se lit pas :\n' + sortieSuperadmin);
  }

  const serveur = spawn(process.execPath, ['server/index.js'], {
    cwd: RACINE,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let journal = '';
  serveur.stdout.on('data', (d) => { journal += d; });
  serveur.stderr.on('data', (d) => { journal += d; });

  const base = 'http://127.0.0.1:' + port;
  await attendreDemarrage(base, () => journal);

  /** Un appel HTTP, avec la session et le jeton CSRF de l'appelant. */
  function fabriquerAppel(session) {
    return async function appel(methode, chemin, corps, options = {}) {
      const entetes = { Accept: 'application/json', Origin: base };
      if (session.cookie) entetes.Cookie = session.cookie;
      if (session.csrf) entetes['X-CSRF-Token'] = session.csrf;
      // Les en-tetes de l'appelant s'appliquent EN DERNIER : c'est ce qui
      // permet a un essai de retirer volontairement le jeton CSRF ou de
      // changer l'origine pour verifier que le serveur refuse.
      Object.assign(entetes, options.entetes ?? {});

      let charge;
      if (corps instanceof FormData) charge = corps;
      else if (corps !== undefined) {
        entetes['Content-Type'] = 'application/json';
        charge = JSON.stringify(corps);
      }

      const r = await fetch(base + chemin, { method: methode, headers: entetes, body: charge });
      const posee = r.headers.getSetCookie?.() ?? [];
      for (const c of posee) {
        if (c.startsWith('lf_session=')) session.cookie = c.split(';')[0];
      }

      const type = r.headers.get('content-type') || '';
      const donnees = type.includes('application/json') ? await r.json() : await r.arrayBuffer();
      return { statut: r.status, donnees, entetes: r.headers };
    };
  }

  /** Ouvre une session. Change le mot de passe provisoire si besoin. */
  async function connexion(identifiant, motDePasse, { nouveau = null } = {}) {
    const session = {};
    const appel = fabriquerAppel(session);
    let r = await appel('POST', '/api/auth/login', { username: identifiant, password: motDePasse });
    if (r.statut !== 200) throw new Error('Connexion refusee : ' + JSON.stringify(r.donnees));
    session.csrf = r.donnees.csrfToken;

    if (r.donnees.user.mustChangePassword && nouveau) {
      const c = await appel('POST', '/api/auth/password', {
        currentPassword: motDePasse, newPassword: nouveau,
      });
      if (c.statut !== 200) throw new Error('Changement refuse : ' + JSON.stringify(c.donnees));
      r = await appel('POST', '/api/auth/login', { username: identifiant, password: nouveau });
      session.csrf = r.donnees.csrfToken;
    }
    return { appel, session, utilisateur: r.donnees.user };
  }

  return {
    base,
    // La chaine de connexion de la base jetable : un essai verifie que le
    // declencheur du journal tient meme contre un acces SQL direct.
    urlBase,
    appelAnonyme: fabriquerAppel({}),
    connexion,
    /** Ouvre la session du super-administrateur cree a l'amorcage. */
    connexionSuperadmin: () => connexion('direction', motDePasseSuperadmin,
      { nouveau: 'ParcEprouve2026!' }),
    journal: () => journal,
    async arreter() {
      serveur.kill();
      await new Promise((r) => { serveur.on('close', r); setTimeout(r, 3000).unref?.(); });
      // La base jetable disparait avec la suite : WITH (FORCE) parce que le
      // serveur peut encore tenir une connexion une fraction de seconde.
      try {
        await executer(urlAdministration(urlSource), 'DROP DATABASE IF EXISTS ' + nomBase + ' WITH (FORCE)');
      } catch {
        // Une base d'essai qui survit ne fait de mal a personne ; echouer
        // ici masquerait le resultat des essais eux-memes.
      }
      try {
        fs.rmSync(dossierDonnees, { recursive: true, force: true });
      } catch {
        // Meme raison.
      }
    },
  };
}

async function attendreDemarrage(base, journal, delaiMs = 25000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.status === 200) return;
    } catch {
      // pas encore en ecoute
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Le serveur n a pas demarre :\n' + journal());
}

/** Un tampon PNG minimal mais valide au regard de la detection de type. */
export function pngFactice(taille = 512) {
  const b = Buffer.alloc(taille);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  return b;
}
