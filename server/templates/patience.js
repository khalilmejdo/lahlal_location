/**
 * Ce que voit quelqu'un qui va plus vite que l'application.
 *
 * Un navigateur qui demandait une page pendant un refus recevait le JSON brut
 * de l'erreur :
 *
 *   {"error":{"code":"TROP_DE_REQUETES","message":"Trop de requetes...
 *
 * Personne ne lit cela sans s'inquieter. Ce n'est pourtant qu'une attente de
 * quelques secondes : rien n'est perdu, rien n'est casse. Le JSON reste la
 * bonne reponse pour l'application elle-meme, qui sait quoi en faire ; pour
 * un etre humain devant son navigateur, il faut une phrase.
 *
 * Deux langues, parce que l'agence travaille dans les deux, et l'arabe en
 * premier pour la meme raison que sur les documents.
 *
 * La page ne porte AUCUN script — meme politique que les factures. Le retour
 * se fait par un « meta refresh », qui n'en demande pas.
 */
import { escapeHtml as esc } from '../core/text.js';

/**
 * Les mots, par situation.
 *
 * Chaque entree porte un titre, une explication et ce qu'il faut faire. Le ton
 * est volontairement leger : celui qui tombe dessus n'a rien fait de mal.
 */
const MOTS = {
  429: {
    fr: {
      titre: 'Doucement, on vous suit !',
      texte: 'Vous allez un peu plus vite que l’application. Elle reprend son souffle '
        + 'quelques secondes — rien n’est perdu, rien n’est cassé.',
      action: 'La page revient toute seule dans',
    },
    ar: {
      titre: 'على مهلك، نحن معك !',
      texte: 'أنت أسرع قليلاً من التطبيق. سيلتقط أنفاسه بضع ثوانٍ — لم يضع شيء، ولم يتعطل شيء.',
      action: 'ستعود الصفحة وحدها بعد',
    },
  },
  401: {
    fr: {
      titre: 'Votre session s’est reposée',
      texte: 'Elle a expiré, tout simplement. Vos données sont intactes : il suffit de '
        + 'vous reconnecter.',
      action: 'Retour à la connexion dans',
    },
    ar: {
      titre: 'انتهت جلستك',
      texte: 'انتهت مدة الجلسة، لا أكثر. بياناتك سليمة : يكفي أن تسجّل الدخول من جديد.',
      action: 'العودة إلى تسجيل الدخول بعد',
    },
  },
  defaut: {
    fr: {
      titre: 'Un instant, s’il vous plaît',
      texte: 'L’application n’a pas pu afficher cette page. Vos données ne sont pas '
        + 'concernées.',
      action: 'Nouvelle tentative dans',
    },
    ar: {
      titre: 'لحظة من فضلك',
      texte: 'لم يتمكّن التطبيق من عرض هذه الصفحة. بياناتك ليست معنيّة.',
      action: 'محاولة جديدة بعد',
    },
  },
};

/** Les mots qui conviennent a ce code, avec repli sur le cas general. */
export function motsPour(status) {
  return MOTS[status] || MOTS.defaut;
}

/**
 * Une page d'attente, lisible et rassurante.
 *
 * @param {object} params
 * @param {number} params.status        code HTTP
 * @param {number} [params.retryAfter]  secondes avant de reessayer
 * @param {string} [params.reference]   identifiant de correlation, si utile
 */
export function pagePatience({ status, retryAfter = null, reference = null }) {
  const mots = motsPour(status);
  // Une attente qu'on annonce doit etre tenable : sous une seconde, la page
  // reviendrait avant que l'oeil ait lu la phrase.
  const secondes = Math.min(Math.max(Number(retryAfter) || 5, 3), 120);

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${secondes}">
<title>${esc(mots.fr.titre)}</title>
<style>
  :root { --encre:#1c2434; --gris:#5b6676; --trait:#e3e7ee; --fond:#f6f7fa; --accent:#0b6b5e; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--fond); color:var(--encre); padding:24px;
         font-family:"Segoe UI",system-ui,-apple-system,sans-serif; }
  .carte { background:#fff; border:1px solid var(--trait); border-radius:10px;
           max-width:540px; width:100%; padding:32px 34px;
           box-shadow:0 1px 3px rgba(28,36,52,.06); }
  .fanion { font-size:34px; line-height:1; margin-bottom:14px; }
  h1 { font-size:20px; margin:0 0 10px; }
  p { margin:0 0 14px; line-height:1.55; color:var(--gris); }
  .ar { direction:rtl; text-align:right; }
  .ar h1 { font-size:19px; }
  hr { border:0; border-top:1px solid var(--trait); margin:22px 0; }
  .minuterie { font-size:13px; color:var(--accent); font-weight:600; }
  .pied { margin-top:22px; font-size:12px; color:var(--gris); }
  a { color:var(--accent); }
</style>
</head>
<body>
  <main class="carte">
    <div class="fanion" aria-hidden="true">☕</div>

    <section class="ar" lang="ar" dir="rtl">
      <h1>${esc(mots.ar.titre)}</h1>
      <p>${esc(mots.ar.texte)}</p>
      <p class="minuterie">${esc(mots.ar.action)} ${secondes} ثانية.</p>
    </section>

    <hr>

    <section lang="fr">
      <h1>${esc(mots.fr.titre)}</h1>
      <p>${esc(mots.fr.texte)}</p>
      <p class="minuterie">${esc(mots.fr.action)} ${secondes} secondes.</p>
    </section>

    <p class="pied">
      <a href="/">Revenir à l’accueil</a> &nbsp;·&nbsp; <span dir="rtl">العودة إلى الصفحة الرئيسية</span>
      ${reference ? '<br>Référence : ' + esc(reference) : ''}
    </p>
  </main>
</body>
</html>`;
}
