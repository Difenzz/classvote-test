/* ==========================================================================
   1. SUPABASE (toute la communication avec la base est ici)
   ========================================================================== */

/* À remplacer par les valeurs de ton projet :
   Supabase → Project Settings → API (clé "anon" / "publishable" uniquement) */
const SUPABASE_URL = "https://tejwsflrwnjpvrelosco.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlandzZmxyd25qcHZyZWxvc2NvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjA4MzQ0MSwiZXhwIjoyMTA3NjU5NDQxfQ.8bCoEhszTZa9yjgR4DG6116Y82a8MdmRxJNevECfDEY";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* Renvoie les données d'une réponse Supabase, ou lève l'erreur */
const check = ({ data, error }) => {
    if (error) {
        throw error;
    }
    return data;
};

/* Transforme une erreur technique en message lisible */
function explain(e) {
    const text = String((e && e.message) || e);

    if (/invalid login credentials/i.test(text)) {
        return "Identifiants incorrects.";
    }
    if (/already registered/i.test(text)) {
        return "Cet e-mail est déjà utilisé.";
    }
    if (/valid email/i.test(text)) {
        return "Adresse e-mail invalide.";
    }
    if (e && e.code === "23505") {
        return "Cet enregistrement existe déjà.";
    }
    if (/anonymous sign-ins are disabled/i.test(text)) {
        return "Connexion impossible pour le moment : préviens ton professeur.";
    }
    if (e && e.code === "42501") {
        return "Action non autorisée (session expirée, droits insuffisants ou phase changée).";
    }
    return text;
}

/* Mise en forme d'une classe reçue de la base (noms attendus par les vues) */
function normalize(c) {
    if (!c) {
        return null;
    }

    const cast  = c.cast_votes || 0;
    const blank = c.blank_votes || 0;
    const abst  = c.abstentions || 0;

    return {
        ...c,
        cast,
        blank,
        abst,
        valid:      cast - blank - abst,        // suffrages exprimés
        doubleVote: !!c.double_vote,
        needApproval: !!c.need_approval,
        round:  c.round || 1,
        seats:  c.seats || 2,
        rounds: c.rounds || [],
        pairs:  (c.pairs || []).sort((a, b) =>
            String(a.created_at).localeCompare(String(b.created_at)))
    };
}

const api = {

    /* --- Session : chaque appareil a au moins une session anonyme ------- */

    async session() {
        const { data } = await sb.auth.getSession();
        let session = data.session;

        if (!session) {
            session = check(await sb.auth.signInAnonymously()).session;
        }
        return session.user;
    },

    async signUp(email, password) {
        const data = check(await sb.auth.signUp({ email, password }));
        return data.session ? data.user : null;   // null = e-mail à confirmer
    },

    async signIn(email, password) {
        return check(await sb.auth.signInWithPassword({ email, password })).user;
    },

    async signOut() {
        await sb.auth.signOut();
    },


    /* --- Classes -------------------------------------------------------- */

    async getClass(code) {
        return normalize(check(
            await sb.from("classes")
                .select("*, pairs(*)")
                .eq("code", code)
                .maybeSingle()
        ));
    },

    async myClasses(ownerId) {
        const list = check(
            await sb.from("classes")
                .select("*, pairs(id)")
                .eq("owner", ownerId)
                .order("created_at", { ascending: false })
        );
        return list.map(normalize);
    },

    /* Crée la classe avec un code unique à 6 chiffres (nouvel essai si doublon) */
    async createClass(name, n, doubleVote, needApproval) {
        for (let i = 0; i < 5; i++) {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            const { error } = await sb.from("classes").insert({
                code, name, n,
                double_vote: !!doubleVote,
                need_approval: !!needApproval
            });

            if (!error) {
                return code;
            }
            if (error.code !== "23505") {
                throw error;
            }
        }
        throw new Error("Impossible de générer un code unique, réessaie.");
    },

    async setPhase(code, phase) {
        const rows = check(
            await sb.from("classes")
                .update({ phase })
                .eq("code", code)
                .select("code")
        );

        /* Sans cette vérification, un refus RLS ne renvoie aucune erreur */
        if (!rows || !rows.length) {
            throw new Error("La phase n'a pas pu être modifiée (droits insuffisants ou classe introuvable).");
        }
    },

    /* Validation des élèves par le professeur (voir migration_v4.sql) */

    /* Élève : envoie son prénom/pseudo au professeur */
    async requestAccess(code, pseudo) {
        return check(await sb.rpc("request_access", { p_class: code, p_pseudo: pseudo }));
    },

    /* Élève : où en est ma demande ? (le pseudo n'est visible que tant qu'elle est en attente) */
    async myAccess(code) {
        const rows = check(
            await sb.from("voter_access")
                .select("status, pseudo")
                .eq("class_code", code)
                .eq("voter_id", me)
                .limit(1)
        );
        return rows && rows[0] ? rows[0] : { status: "none", pseudo: null };
    },

    /* Professeur : toutes les demandes de sa classe */
    async accessRows(code) {
        return check(
            await sb.from("voter_access")
                .select("voter_id, status, pseudo, created_at")
                .eq("class_code", code)
                .order("created_at")
        );
    },

    /* Professeur : valide (true) ou refuse / retire (false) */
    async decideAccess(code, voterId, approve) {
        check(await sb.rpc("decide_access", { p_class: code, p_voter: voterId, p_approve: approve }));
    },

    async deleteClass(code) {
        check(await sb.from("classes").delete().eq("code", code));
    },


    /* --- Binômes -------------------------------------------------------- */

    async addPair(code, t, r, prog) {
        check(await sb.from("pairs").insert({ class_code: code, t, r, prog }));
    },

    async removePair(id) {
        check(await sb.from("pairs").delete().eq("id", id));
    },


    /* --- Vote ----------------------------------------------------------- */

    /* Cet appareil a-t-il déjà voté DANS LE TOUR EN COURS ? (voir migration.sql) */
    async hasVoted(code) {
        return !!check(await sb.rpc("has_voted", { p_class: code }));
    },

    /* Bulletin atomique côté serveur (voir migration_v4.sql).
       kind : "pair" (1 ou 2 binômes), "blank" (vote blanc) ou "abstain" (abstention) */
    async castBallot(code, kind, pairIds) {
        check(await sb.rpc("cast_ballot", {
            p_class: code,
            p_kind:  kind,
            p_pairs: pairIds
        }));
    },

    /* Professeur : clôture le tour en cours (majorité absolue → binôme élu) */
    async closeRound(code) {
        return check(await sb.rpc("close_round", { p_class: code }));
    }
};


/* ==========================================================================
   2. ÉTAT DE L'APPLICATION Emerick
   ========================================================================== */

let me   = null;     // identifiant (auth) de cet appareil ou du professeur
let view = "home";   // écran affiché
let cur  = null;     // code de la classe ouverte
let prof = null;     // identifiant du professeur connecté (null = élève)
let msg  = "";       // message d'erreur à afficher au prochain rendu

let cls       = null;   // classe ouverte (avec ses binômes)
let voted     = false;  // cet appareil a-t-il déjà voté dans cette classe ?
let myClasses = [];     // classes du professeur connecté
let access    = [];     // demandes d'accès des élèves (professeur)
let myAccess  = { status: "none", pseudo: null };   // ma propre demande (élève)

let picked    = [];     // binôme(s) sélectionné(s) sur le bulletin en cours
let pickedKey = "";     // « classe|tour » auquel correspond la sélection

let polling = false;    // un rafraîchissement automatique est-il en cours ?
let again   = false;    // un changement est arrivé pendant ce rafraîchissement
let lastDashSig = "";   // « empreinte » du tableau de bord affiché
let rt      = { key: "", channel: null };   // abonnement temps réel en cours
let rtCount = 0;
let lastSig = "";       // « empreinte » de la dernière classe affichée

const POLL_MS    = 5000;                                   // filet de sécurité si le temps réel décroche
const POLL_VIEWS = ["role", "cand", "vote", "res", "live"];  // écrans mis à jour tout seuls

const PHASES = {
    cand: "Candidatures",
    vote: "Vote",
    res:  "Résultats"
};


/* ==========================================================================
   3. UTILITAIRES Enzo
   ========================================================================== */

const $ = selector => document.querySelector(selector);

const C = () => cls;

/* Échappe le HTML pour éviter l'injection de code */
const esc = s => String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
}[c]));

/* Écrans qui ont besoin de la classe ouverte */
const CLASS_VIEWS = ["role", "cand", "vote", "res", "live", "dossier"];

/* Minuscules sans accents : « Léo » et « leo » sont le même prénom */
const fold = s => String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

/* Élèves validés, mémorisés UNIQUEMENT sur l'appareil du professeur (jamais en base) :
   ils servent à repérer un doublon (même prénom qui se représente en navigation privée)
   et à retirer un accès validé par erreur. */
function loadApproved(k) {
    try {
        return JSON.parse(localStorage.getItem("approved:" + k) || "[]");
    } catch (e) {
        return [];
    }
}

function saveApproved(k, list) {
    try {
        localStorage.setItem("approved:" + k, JSON.stringify(list));
    } catch (e) { /* stockage indisponible : on perd seulement la détection de doublons */ }
}

/* S'assure que cet appareil a une session (nouvel essai si le démarrage a échoué) */
async function ensureMe() {
    if (!me) {
        me = (await api.session()).id;
    }
    return me;
}

/* Charge depuis Supabase les données dont l'écran courant a besoin */
async function refresh() {
    if (view === "dash") {
        myClasses = await api.myClasses(prof);
        return;
    }

    if (CLASS_VIEWS.includes(view)) {
        await ensureMe();
        cls = await api.getClass(cur);

        if (!cls) {
            view = "home";
            cur  = null;
            throw new Error("Cette élection n'existe plus.");
        }

        if (view === "vote") {
            voted    = await api.hasVoted(cur);
            myAccess = cls.needApproval ? await api.myAccess(cur) : { status: "none", pseudo: null };
        }

        if (view === "live" && prof && cls.needApproval) {
            access = await api.accessRows(cur);
        }

        if (view === "dossier") {
            if (!prof) {
                throw new Error("Réservé au professeur.");
            }
            acts    = await api.acts(cur);
            minutes = await api.minutes(cur);
        }
    }
}

/* Change d'écran (en rechargeant les données), avec un message optionnel */
async function go(v, m) {
    view = v;
    msg  = m || "";

    if (location.hash.startsWith("#/")) {
        history.replaceState(null, "", location.pathname + location.search);
    }

    try {
        await refresh();
    } catch (e) {
        msg = explain(e);

        /* Pas de données fiables pour cet écran : retour à l'accueil
           plutôt qu'un affichage cassé ou la classe d'un autre code */
        if (CLASS_VIEWS.includes(view) && (!cls || cls.code !== cur)) {
            cls  = null;
            view = "home";
        }
    }

    render();
}

/* Affiche une erreur sans refaire tout le rendu */
function err(m) {
    const el = $("#msg");

    if (el) {
        el.textContent = m;
    }
}


/* ==========================================================================
   4. LOGIQUE MÉTIER Enzo
   ========================================================================== */

/* Classe des binômes par voix ; les ex æquo partagent le même rang */
function rank(pairs) {
    const list = pairs
        .map(x => ({ ...x }))
        .sort((a, b) => b.votes - a.votes);

    list.forEach((x, i) => {
        const tiedWithPrevious = i && x.votes === list[i - 1].votes;
        x.rk = tiedWithPrevious ? list[i - 1].rk : i + 1;
    });

    return list;
}

/* Binômes déjà élus, dans l'ordre (binôme n°1, binôme n°2…) */
const electedPairs = c => c.pairs
    .filter(x => x.seat != null)
    .sort((a, b) => a.seat - b.seat);

/* Binômes encore en lice */
const runningPairs = c => c.pairs.filter(x => x.seat == null);

/* Majorité absolue des suffrages exprimés (hors blancs et abstentions) */
const majorityNeeded = c => Math.floor(c.valid / 2) + 1;

/* Nombre de sièges pourvus dans le tour en cours : 2 si l'option « 2 binômes » est active */
function slotsOf(c) {
    const left = c.seats - electedPairs(c).length;
    return c.doubleVote ? Math.max(1, Math.min(2, left)) : 1;
}

/* Nombre MAXIMUM de binômes cochables sur le bulletin (même règle que le serveur) :
   l'élève en choisit de 1 jusqu'à ce maximum */
const ballotPicks = c => Math.min(slotsOf(c), runningPairs(c).length);

/* « du binôme n°1 » / « des binômes n°1 et n°2 » */
function seatLabel(c) {
    const first = electedPairs(c).length + 1;

    return slotsOf(c) > 1
        ? `des binômes n°${first} et n°${first + 1}`
        : `du binôme n°${first}`;
}

/* Élus d'un tour archivé (compatible avec les anciens tours à un seul élu) */
const roundWinners = h => h.winners || (h.winner ? [{ id: h.winner, seat: h.seat }] : []);

/* Pourcentage (entier) de voix */
const percent = (votes, total) => total ? Math.round(votes / total * 100) : 0;

/* Empreinte de ce qui est affiché : on ne redessine que si elle change */
function signature(c, hasVoted) {
    const withVotes = view === "live";

    return JSON.stringify([
        c.phase, c.round, c.rounds.length, hasVoted, myAccess.status,
        withVotes ? [c.cast, c.blank, c.abst, access.map(a => [a.voter_id, a.status, a.pseudo])] : 0,
        c.pairs.map(x => [x.id, x.t, x.r, x.prog, x.seat, withVotes ? x.votes : 0])
    ]);
}


/* ==========================================================================
   5. VUES (chaque fonction renvoie le HTML d'un écran) Emerick + Enzo
   ========================================================================== */

/* --- 5.1 Éléments réutilisables -------------------------------------- */

/* selected : undefined = pas de bouton ; true/false = bouton « choisir » (écran de vote) */
function pairHTML(x, selected) {
    const electedTag = x.seat != null
        ? `<span class="tag win">Binôme n°${x.seat} élu</span>`
        : "";

    const program = x.prog
        ? `<p>${esc(x.prog)}</p>`
        : "";

    const voteButton = selected === undefined
        ? ""
        : `<button class="${selected ? "go" : ""}" aria-pressed="${selected}" onclick="pick('${x.id}')">${selected ? "✓ Binôme choisi" : "Choisir ce binôme"}</button>`;

    return `
        <div class="box${selected ? " picked" : ""}">
            <h2>${esc(x.t)} &amp; ${esc(x.r)}</h2>
            ${electedTag}
            <p class="muted">Titulaire : ${esc(x.t)} · Remplaçant : ${esc(x.r)}</p>
            ${program}
            ${voteButton}
        </div>`;
}

function classCardHTML(c) {
    const k = c.code;

    const digits = [...k]
        .map(d => `<span>${d}</span>`)
        .join("");

    /* Sélecteur de phase : la phase courante est mise en avant */
    const seg = Object.keys(PHASES)
        .map(p => `<button type="button" aria-pressed="${c.phase === p}" onclick="phase('${k}','${p}')">${PHASES[p]}</button>`)
        .join("");

    const tags = `
        <span class="tag">${PHASES[c.phase]}</span>
        ${c.doubleVote ? `<span class="tag">2 binômes</span>` : ""}
        ${c.needApproval ? `<span class="tag">Validation des élèves</span>` : ""}`;

    return `
        <section class="box class-card">

            <div class="row between top">
                <div class="grow">
                    <h2>${esc(c.name)}</h2>
                    <div class="row tags">${tags}</div>
                </div>
                <div class="code" aria-label="Code ${k}">${digits}</div>
            </div>

            <div class="stats">
                <div class="stat"><b>${c.n}</b><span>élèves</span></div>
                <div class="stat"><b>${c.pairs.length}</b><span>binôme(s)</span></div>
                <div class="stat"><b>${c.cast}<small>/${c.n}</small></b><span>votes · tour ${c.round}</span></div>
            </div>

            <div class="field-group">
                <span class="small muted" id="ph-${k}">Phase de l'élection</span>
                <div class="seg" role="group" aria-labelledby="ph-${k}">${seg}</div>
            </div>

            <div class="card-actions">
                <button class="go" onclick="showLive('${k}')">Suivre en direct</button>
                <button onclick="openDossier('${k}')">Dossier PDF</button>
                <button class="danger spacer" onclick="del('${k}')">Supprimer</button>
            </div>

        </section>`;
}

/* Une ligne de résultat avec sa barre (le trait central = majorité à 50 %) */
function barRowHTML(x, total, winners) {
    const pct   = percent(x.votes, total);
    const crown = [].concat(winners || []).includes(x.id) ? " 🏆" : "";

    return `
        <div class="bar-row">
            <div class="row between">
                <b>${esc(x.t)} &amp; ${esc(x.r)}${crown}</b>
                <span>${x.votes} voix · ${pct} %</span>
            </div>
            <div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
        </div>`;
}

/* Ligne « blancs / abstentions » sous un décompte */
function ballotsLine(valid, blank, abst) {
    return `${valid} suffrage(s) exprimé(s) · ${blank} blanc(s) · ${abst} abstention(s)`;
}

/* Bilan d'un tour terminé (archivé par le serveur) */
function roundHTML(h) {
    const winners = roundWinners(h);
    const valid   = h.valid ?? h.cast;          // anciens tours : pas de blancs
    const blank   = h.blank || 0;
    const abst    = h.abstain || 0;

    const rows = (h.results || [])
        .map(x => barRowHTML(x, valid, winners.map(w => w.id)))
        .join("");

    const seats = winners.map(w => `n°${w.seat}`).join(" et ");

    const outcome = winners.length
        ? `${winners.length > 1 ? "Binômes" : "Binôme"} ${seats} élu${winners.length > 1 ? "s" : ""} à la majorité absolue.`
        : `Aucune majorité absolue : nouveau tour.`;

    const target = (h.slots || 1) > 1
        ? `Élection des binômes n°${h.seat} et n°${h.seat + 1}`
        : `Élection du binôme n°${h.seat}`;

    return `
        <div class="box">
            <h2>Tour ${h.round}</h2>
            <p class="muted">${target} · ${h.cast} bulletin(s) sur ${h.n} élèves</p>
            <p class="muted">${ballotsLine(valid, blank, abst)}</p>
            ${rows}
            <p class="notice">${outcome}</p>
        </div>`;
}

/* Rappel du dernier tour, affiché aux élèves pendant le vote */
function lastRoundNotice(c) {
    const h = c.rounds[c.rounds.length - 1];

    if (!h) {
        return "";
    }

    const names = roundWinners(h)
        .map(w => {
            const x = (h.results || []).find(r => r.id === w.id);
            return x ? `${esc(x.t)} &amp; ${esc(x.r)} (n°${w.seat})` : "";
        })
        .filter(Boolean);

    const text = names.length
        ? `Tour ${h.round} : ${names.join(" et ")} ${names.length > 1 ? "élus" : "élu"} !`
        : `Tour ${h.round} : aucune majorité absolue, on recommence.`;

    return `<p class="notice">${text}</p>`;
}


/* --- 5.2 Écrans élève ------------------------------------------------ */

function viewHome(m) {
    return `
        <form class="box narrow" onsubmit="event.preventDefault(); joinCode()">

            <h1>🗳️ Élection des délégués</h1>
            <p class="muted">Entre le code donné par ton professeur.</p>

            <input id="code" class="code-in"
                   inputmode="numeric" pattern="[0-9]*" maxlength="6"
                   autocomplete="off" placeholder="000000"
                   aria-label="Code à 6 chiffres">

            ${m}

            <button class="go">Valider</button>
            <button type="button" class="link" onclick="go(prof ? 'dash' : 'plogin')">Espace professeur</button>

        </form>`;
}

function viewRole(m) {
    const c = C();

    return `
        <h1>Classe ${esc(c.name)}</h1>
        <p class="muted">Phase en cours : ${PHASES[c.phase]}</p>

        <div class="hero">
            <button class="e" onclick="voteAccess()">Électeur</button>
            <button class="c" onclick="go('cand')">Candidat</button>
        </div>

        ${m}

        <div class="row">
            <button class="link" onclick="go('home')">← Changer de code</button>
        </div>`;
}

function viewCandidate(m) {
    const c      = C();
    const mine   = c.pairs.find(x => x.owner === me);
    const others = c.pairs.filter(x => x.owner !== me);

    /* Colonne de gauche : ma candidature ou le formulaire */
    let left;

    if (mine) {
        const withdrawButton = c.phase === "cand"
            ? `<button class="danger" onclick="unapply('${mine.id}')">Retirer ma candidature</button>`
            : "";

        left = `
            <div class="box">
                <h2>Ton binôme</h2>
                <p>✅ ${esc(mine.t)} (titulaire) &amp; ${esc(mine.r)} (remplaçant)</p>
                ${withdrawButton}
                ${m}
            </div>`;
    } else if (c.phase !== "cand") {
        left = `
            <div class="box">
                <h2>Candidatures closes</h2>
                <p class="muted">La phase de candidature est terminée : tu peux consulter les binômes.</p>
                ${m}
            </div>`;
    } else {
        left = `
            <form class="box" onsubmit="event.preventDefault(); apply()">
                <h2>Se présenter en binôme</h2>

                <p class="muted small">Ces réponses remplissent ton acte de candidature, lu uniquement par ton professeur.
                    La classe ne voit que les prénoms et le programme.</p>

                <div class="row">
                    <input id="nt" placeholder="Prénom du titulaire" aria-label="Prénom du titulaire" maxlength="40" style="flex:1">
                    <input id="ntn" placeholder="Nom du titulaire" aria-label="Nom du titulaire" maxlength="40" style="flex:1">
                </div>
                <div class="row">
                    <input id="nr" placeholder="Prénom du suppléant" aria-label="Prénom du suppléant" maxlength="40" style="flex:1">
                    <input id="nrn" placeholder="Nom du suppléant" aria-label="Nom du suppléant" maxlength="40" style="flex:1">
                </div>
                <textarea id="pres" placeholder="Présentez-vous brièvement (nom, âge, qualités)"
                          aria-label="Présentation" maxlength="400"></textarea>
                <textarea id="mot" placeholder="Vos motivations (pourquoi candidater, comment le titulaire a choisi son suppléant)"
                          aria-label="Motivations" maxlength="600"></textarea>
                <textarea id="pg" placeholder="Votre programme (rôle auprès de la classe, des professeurs, de l'administration, vos projets)"
                          aria-label="Programme" maxlength="800"></textarea>
                <input id="slo" placeholder="Votre slogan" aria-label="Slogan" maxlength="120">

                ${m}

                <button class="go">Candidater</button>
            </form>`;
    }

    /* Colonne de droite : les autres binômes */
    const othersHTML = others.map(x => pairHTML(x)).join("")
        || `<p class="muted">Aucun autre binôme pour l'instant.</p>`;

    return `
        <h1>Page candidat</h1>

        <div class="split">
            <div>
                ${left}
            </div>
            <div>
                <h2>Autres binômes</h2>
                <div class="grid" style="margin-top:12px">${othersHTML}</div>
            </div>
        </div>

        <button class="link" onclick="go('role')">← Retour</button>`;
}

function viewVoter(m) {
    const c       = C();
    const elected = electedPairs(c);
    const running = runningPairs(c);
    const picks   = ballotPicks(c);

    /* La sélection ne vaut que pour la classe et le tour affichés */
    const key = c.code + "|" + c.round;

    if (pickedKey !== key) {
        pickedKey = key;
        picked    = [];
    }
    picked = picked.filter(id => running.some(x => x.id === id));

    /* Validation par le professeur : sans elle, pas de bulletin */
    const accessOK = !c.needApproval || myAccess.status === "approved";
    const waiting  = c.needApproval && myAccess.status === "pending";
    const showForm = c.needApproval && !accessOK && !waiting && c.phase !== "res";
    const canVote  = !voted && c.phase === "vote" && accessOK;

    /* Message d'état : il change tout seul avec la phase et le tour */
    let status;

    if (c.phase === "cand") {
        status = `<p class="notice">Les candidatures sont ouvertes : les binômes apparaissent ici au fur et à mesure. Le vote s'ouvrira bientôt.</p>`;
    } else if (voted) {
        status = `<p class="notice">Ton bulletin est enregistré pour ce tour ✅ Attends la fin du tour…</p>`;
    } else {
        const choose = picks > 1 ? " Tu peux choisir 1 ou 2 binômes." : "";

        status = `<p class="notice">Tour ${c.round} : élection ${seatLabel(c)} sur ${c.seats}. Il faut la majorité absolue des votes.${choose}</p>`;
    }

    /* Accès au vote : demande au professeur */
    let accessHTML = "";

    if (waiting) {
        accessHTML = `<p class="notice">⏳ En attente de validation par ton professeur…</p>`;
    } else if (showForm) {
        const refused = myAccess.status === "refused"
            ? `<p class="notice">Demande refusée par ton professeur.</p>`
            : "";

        accessHTML = `
            ${refused}
            <form class="box" onsubmit="event.preventDefault(); requestAccess()">
                <h2>Accès au vote</h2>
                <input id="pseudo" maxlength="40" autocomplete="off"
                       placeholder="Ton prénom ou pseudo" aria-label="Ton prénom ou pseudo">
                ${m}
                <button class="go">Demander l'accès</button>
            </form>`;
    }

    const electedHTML = elected.length
        ? `<h2>Déjà élus</h2><div class="grid">${elected.map(x => pairHTML(x)).join("")}</div>`
        : "";

    const pairs = running
        .map(x => pairHTML(x, canVote ? picked.includes(x.id) : undefined))
        .join("")
        || `<p class="muted">Aucun binôme candidat pour l'instant.</p>`;

    /* Bulletin : validation, vote blanc, abstention */
    const ready = picks > 0 && picked.length >= 1 && picked.length <= picks;

    const ballotBox = canVote
        ? `<div class="box ballot">
               <h2>Ton bulletin</h2>
               <p class="muted">${picks > 0
                   ? `${picked.length} / ${picks} choisi(s)`
                   : "Aucun binôme en lice."}</p>
               ${m}
               <button class="go" onclick="ballot('pair')" ${ready ? "" : "disabled"}>Valider mon vote</button>
               <div class="row">
                   <button onclick="ballot('blank')">Voter blanc</button>
                   <button onclick="ballot('abstain')">M'abstenir</button>
               </div>
           </div>`
        : "";

    return `
        <h1>Page électeur</h1>
        <p class="muted">Un vote par tour, anonyme et définitif.</p>

        ${c.phase === "vote" ? lastRoundNotice(c) : ""}
        ${status}
        ${canVote || showForm ? "" : m}
        ${accessHTML}

        ${electedHTML}

        <h2>Binômes en lice</h2>
        <div class="grid">${pairs}</div>

        ${ballotBox}

        <button class="link" onclick="go('role')">← Retour</button>`;
}


/* --- 5.3 Écrans professeur ------------------------------------------- */

function viewTeacherLogin(m) {
    return `
        <form class="box narrow" onsubmit="event.preventDefault(); plogin()">

            <h1>Espace professeur</h1>
            <p class="muted">Connecte-toi, ou crée ton compte.</p>

            <input id="pid" type="email" autocomplete="email"
                   placeholder="Adresse e-mail" aria-label="Adresse e-mail">
            <input id="pmdp" type="password" autocomplete="current-password"
                   placeholder="Mot de passe (6 caractères min.)" aria-label="Mot de passe">

            ${m}

            <button class="go">Se connecter</button>
            <button type="button" onclick="plogin(true)">Créer le compte</button>
            <button type="button" class="link" onclick="go('home')">← Retour élève</button>

        </form>`;
}

function viewDashboard(m) {
    const cards = myClasses.map(classCardHTML).join("")
        || `<div class="empty">Aucune élection pour l'instant. Crée la première ci-dessus.</div>`;

    /* Une seule élection en cours à la fois */
    const active = myClasses.some(c => c.phase !== "res");

    const newForm = active ? `
        <div class="notice">Une élection est déjà en cours : publie ses résultats pour pouvoir en créer une nouvelle.</div>
        ${m}` : `
        <form class="box new-election" onsubmit="event.preventDefault(); newClass()">
            <h2>Nouvelle élection</h2>

            <div class="fields">
                <label class="fld">
                    <span class="small muted">Classe</span>
                    <input id="cn" placeholder="ex : 3B" maxlength="40">
                </label>
                <label class="fld">
                    <span class="small muted">Nombre d'élèves</span>
                    <input id="nb" type="number" min="1" placeholder="ex : 28">
                </label>
            </div>

            <div class="opts">
                <label class="opt">
                    <input type="checkbox" id="dbl">
                    <span><b>Vote pour 1 ou 2 binômes</b><br>
                          <span class="small muted">Chaque élève peut choisir jusqu'à 2 binômes sur son bulletin.</span></span>
                </label>

                <label class="opt">
                    <input type="checkbox" id="cod" checked>
                    <span><b>Valider les élèves un par un</b><br>
                          <span class="small muted">Tu approuves chaque élève avant qu'il puisse voter.</span></span>
                </label>
            </div>

            ${m}

            <button class="go">Générer le code</button>
        </form>`;

    return `
        <div class="row between">
            <h1>Espace professeur</h1>
            <button class="link" onclick="logout()">Déconnexion</button>
        </div>

        ${newForm}

        <h2 class="section-title">Mes élections</h2>
        <div class="stack">${cards}</div>`;
}


/* --- 5.4 Direct (professeur) et résultats ---------------------------- */

/* Demandes d'accès à valider (professeur) */
function accessBoxHTML(c) {
    if (!c.needApproval) {
        return "";
    }

    const known    = loadApproved(c.code);
    const pending  = access.filter(a => a.status === "pending");
    const approved = access.filter(a => a.status === "approved").length;

    /* Prénoms déjà vus : validés sur cet appareil + autres demandes en attente */
    const count = {};
    known.forEach(k => { count[fold(k.pseudo)] = (count[fold(k.pseudo)] || 0) + 1; });
    pending.forEach(a => { count[fold(a.pseudo)] = (count[fold(a.pseudo)] || 0) + 1; });

    const rows = pending.map(a => {
        const dup = count[fold(a.pseudo)] > 1
            ? ` <span class="tag warn">⚠ doublon possible</span>`
            : "";

        return `
            <div class="row between access-row">
                <span><b>${esc(a.pseudo)}</b>${dup}</span>
                <span class="row">
                    <button class="go" onclick="decide('${a.voter_id}', true)">Valider</button>
                    <button class="danger" onclick="decide('${a.voter_id}', false)">Refuser</button>
                </span>
            </div>`;
    }).join("") || `<p class="muted">Aucune demande en attente.</p>`;

    const knownHTML = known.length
        ? `<p class="muted small">Validés :</p>
           ${known.map(k => `
               <div class="row between access-row">
                   <span>${esc(k.pseudo)}</span>
                   <button class="link" onclick="decide('${k.id}', false)">Retirer</button>
               </div>`).join("")}`
        : "";

    return `
        <div class="box">
            <div class="row between">
                <h2>Élèves à valider</h2>
                <span>${approved} validé(s) / ${c.n}</span>
            </div>
            ${rows}
            ${knownHTML}
        </div>`;
}


function viewLive(m) {
    const c       = C();
    const elected = electedPairs(c);
    const running = rank(runningPairs(c));
    const needed  = majorityNeeded(c);

    /* Binômes qui dépassent la moitié des suffrages exprimés */
    const qualified = c.valid > 0
        ? running.filter(x => x.votes >= needed).map(x => x.id)
        : [];

    const rows = running.map(x => barRowHTML(x, c.valid, qualified)).join("")
        || `<p class="muted">Aucun binôme en lice.</p>`;

    const electedHTML = elected.length
        ? `<div class="box">
               <h2>Déjà élus</h2>
               ${elected.map(x => `<p><span class="tag win">Binôme n°${x.seat}</span> <b>${esc(x.t)} &amp; ${esc(x.r)}</b></p>`).join("")}
           </div>`
        : "";

    let verdict;

    if (c.phase !== "vote") {
        verdict = `<p class="notice">Le vote n'est pas ouvert (phase : ${PHASES[c.phase]}).</p>`;
    } else if (qualified.length) {
        const names = running
            .filter(x => qualified.includes(x.id))
            .map(x => `${esc(x.t)} &amp; ${esc(x.r)}`)
            .join(" et ");

        verdict = `<p class="notice">✅ ${names} ${qualified.length > 1 ? "ont" : "a"} la majorité absolue : tu peux clôturer le tour.</p>`;
    } else {
        verdict = `<p class="notice">Majorité absolue : ${needed} voix sur ${c.valid} exprimée(s). Pas encore atteinte.</p>`;
    }

    const closeButton = c.phase === "vote"
        ? `<button class="go" onclick="closeRound()">Clôturer le tour ${c.round}</button>`
        : "";

    const history = c.rounds.map(roundHTML).reverse().join("");

    return `
        <h1>En direct · ${esc(c.name)}</h1>
        <p class="muted">
            <span class="tag">${PHASES[c.phase]}</span>
            Tour ${c.round} · élection ${seatLabel(c)} sur ${c.seats} ·
            ${c.pairs.length} binôme(s) · mise à jour automatique
        </p>

        <div class="box">
            <div class="row between">
                <h2>Participation</h2>
                <span>${c.cast} / ${c.n} (${percent(c.cast, c.n)} %)</span>
            </div>
            <div class="bar" aria-hidden="true"><i style="width:${percent(c.cast, c.n)}%"></i></div>
            <p class="muted">${ballotsLine(c.valid, c.blank, c.abst)}</p>
        </div>

        ${accessBoxHTML(c)}

        ${verdict}
        ${m}

        <div class="box">
            <h2>Tous les binômes</h2>
            ${rows}
        </div>

        ${electedHTML}

        <div class="card-actions">
            ${closeButton}
            <button onclick="phase('${c.code}','vote','live')">Ouvrir le vote</button>
            <button onclick="phase('${c.code}','res','live')">Publier les résultats</button>
        </div>

        <nav class="nav-row" aria-label="Navigation">
            <button class="link" onclick="go('dash')">← Tableau de bord</button>
            <button class="link" onclick="go('res')">Écran des résultats</button>
            <button class="link" onclick="openDossier('${c.code}')">Dossier PDF</button>
        </nav>

        ${history ? `<h2>Tours précédents</h2><div class="grid">${history}</div>` : ""}`;
}

function viewResults() {
    const c = C();

    /* Les élèves ne voient rien tant que le prof n'a pas publié */
    if (c.phase !== "res" && !prof) {
        return `
            <h1>Résultats</h1>
            <p>Les résultats ne sont pas encore publiés.</p>
            <button onclick="go('role')">← Retour</button>`;
    }

    const elected = electedPairs(c);

    const electedHTML = elected.length
        ? `<div class="grid">${elected.map(x => `
              <div class="box winner">
                  <span class="tag win">Binôme n°${x.seat}</span>
                  <h2>🏆 ${esc(x.t)} &amp; ${esc(x.r)}</h2>
                  <p class="muted">Titulaire : ${esc(x.t)} · Remplaçant : ${esc(x.r)}</p>
              </div>`).join("")}</div>`
        : `<p class="notice">Aucun binôme n'a encore été élu à la majorité absolue.</p>`;

    /* Si l'élection n'est pas terminée : état du tour en cours */
    const running = rank(runningPairs(c));
    const ongoing = elected.length < c.seats && running.length && c.cast > 0
        ? `<div class="box">
               <h2>Tour ${c.round} (en cours)</h2>
               <p class="muted">${ballotsLine(c.valid, c.blank, c.abst)}</p>
               ${running.map(x => barRowHTML(x, c.valid)).join("")}
           </div>`
        : "";

    const history = c.rounds.map(roundHTML).reverse().join("");

    const backTo = prof ? "dash" : "role";

    return `
        <h1>Résultats · ${esc(c.name)}</h1>
        <p class="muted">${c.seats} binôme(s) à élire à la majorité absolue · ${c.rounds.length} tour(s) terminé(s)</p>

        ${electedHTML}
        ${ongoing}

        ${history ? `<h2>Détail des tours</h2><div class="grid">${history}</div>` : ""}

        <button onclick="go('${backTo}')">← Retour</button>`;
}


/* --- 5.5 Routeur ----------------------------------------------------- */

const VIEWS = {
    home:   viewHome,
    plogin: viewTeacherLogin,
    dash:   viewDashboard,
    role:   viewRole,
    cand:   viewCandidate,
    vote:   viewVoter,
    res:    viewResults,
    live:   viewLive
};

function render() {
    const m = `<p class="msg" id="msg" role="alert">${esc(msg)}</p>`;
    msg = "";

    const draw = VIEWS[view];

    if (draw) {
        $("#app").innerHTML = draw(m);
    }

    lastSig = cls && CLASS_VIEWS.includes(view)
        ? view + "|" + signature(cls, voted)
        : "";

    lastDashSig = view === "dash" ? dashSig(myClasses) : "";

    syncRealtime();
    setTitle();
}


/* ==========================================================================
   6. ACTIONS
   ========================================================================== */

/* --- 6.1 Élève : rejoindre une classe -------------------------------- */

async function joinCode() {
    const k = $("#code").value.replace(/\D/g, "");

    if (k.length !== 6) {
        return err("Le code contient 6 chiffres.");
    }

    let c;

    try {
        await ensureMe();
        c = await api.getClass(k);

        if (!c) {
            return err("Code inconnu.");
        }
    } catch (e) {
        return err(explain(e));
    }

    cur = k;

    /* Résultats déjà publiés : on les montre directement */
    go(c.phase === "res" ? "res" : "role");
}

async function voteAccess() {
    /* Accessible dès la phase de candidature : l'élève voit les binômes arriver.
       La phase a pu changer depuis le dernier chargement : go() la relit. */
    try {
        const c = await api.getClass(cur);

        if (!c) {
            return go("home", "Cette élection n'existe plus.");
        }

        go(c.phase === "res" ? "res" : "vote");
    } catch (e) {
        err(explain(e));
    }
}


/* --- 6.2 Professeur : compte ----------------------------------------- */

async function plogin(create) {
    const email = $("#pid").value.trim().toLowerCase();
    const pw    = $("#pmdp").value;

    if (!email || pw.length < 6) {
        return err("E-mail requis et mot de passe de 6 caractères minimum.");
    }

    try {
        const user = create
            ? await api.signUp(email, pw)
            : await api.signIn(email, pw);

        if (!user) {
            return err("Compte créé : confirme ton e-mail, puis connecte-toi.");
        }

        me   = user.id;
        prof = user.id;
    } catch (e) {
        return err(explain(e));
    }

    go("dash");
}

async function logout() {
    await api.signOut();

    prof = null;
    me   = (await api.session()).id;   // nouvelle session anonyme

    go("home");
}


/* --- 6.3 Professeur : élections -------------------------------------- */

async function newClass() {
    const name       = $("#cn").value.trim();
    const n          = parseInt($("#nb").value, 10);
    const doubleVote = $("#dbl").checked;
    const needApproval = $("#cod").checked;

    if (!name || !(n >= 1)) {
        return err("Renseigne la classe et le nombre d'élèves.");
    }

    try {
        await api.createClass(name, n, doubleVote, needApproval);
    } catch (e) {
        return err(e.code === "42501" ? "Tu as déjà une élection en cours." : explain(e));
    }

    go("dash");
}

async function phase(k, p, next = "dash") {
    try {
        await api.setPhase(k, p);
        go(next);
    } catch (e) {
        go(next, explain(e));
    }
}

/* Écran « en direct » : tous les binômes et leurs voix, mis à jour tout seul */
function showLive(k) {
    cur = k;
    go("live");
}

/* Valide (ok = true) ou refuse / retire (ok = false) un élève */
async function decide(id, ok) {
    const request = access.find(a => a.voter_id === id);

    try {
        await api.decideAccess(cur, id, ok);

        /* Mémoire locale (appareil du professeur) pour repérer les doublons */
        let list = loadApproved(cur);

        if (ok && request) {
            list.push({ id, pseudo: request.pseudo });
        } else if (!ok) {
            list = list.filter(k => k.id !== id);
        }
        saveApproved(cur, list);

        go("live");
    } catch (e) {
        go("live", explain(e));
    }
}

/* Clôture le tour : le serveur désigne l'élu (majorité absolue) ou relance un tour */
async function closeRound() {
    const c = C();

    if (!c || c.phase !== "vote") {
        return;
    }

    if (!confirm("Clôturer le tour " + c.round + " ? Les votes seront comptés et le tour suivant commencera si besoin.")) {
        return;
    }

    try {
        await api.closeRound(cur);
        go("live");
    } catch (e) {
        go("live", explain(e));
    }
}

async function del(k) {
    if (!confirm("Supprimer cette élection ? Cette action est définitive.")) {
        return;
    }

    try {
        await api.deleteClass(k);
        go("dash");
    } catch (e) {
        go("dash", explain(e));
    }
}


/* --- 6.4 Candidat ---------------------------------------------------- */

async function apply() {
    const v    = id => $("#" + id).value.trim();
    const t    = v("nt");
    const r    = v("nr");
    const prog = v("pg");

    /* Acte de candidature : lu uniquement par le professeur */
    const act = { classe: "", tp: t, tn: v("ntn"), sp: r, sn: v("nrn"), pres: v("pres"), mot: v("mot"), prog, slogan: v("slo") };

    if (!t || !r || !act.tn || !act.sn) {
        return err("Indique le nom et le prénom du titulaire et du suppléant.");
    }

    if (!act.pres || !act.mot || !prog) {
        return err("Remplis ta présentation, tes motivations et ton programme.");
    }

    if (t.toLowerCase() === r.toLowerCase()) {
        return err("Le titulaire et le remplaçant doivent être deux élèves différents.");
    }

    /* Phase et binômes relus en base : la copie locale peut être périmée */
    let c;

    try {
        await ensureMe();
        c = await api.getClass(cur);
    } catch (e) {
        return err(explain(e));
    }

    if (!c) {
        return go("home", "Cette élection n'existe plus.");
    }

    if (c.phase !== "cand") {
        return go("cand", "Les candidatures sont closes.");
    }

    if (c.pairs.some(x => x.owner === me)) {
        return go("cand", "Tu as déjà présenté un binôme.");
    }

    act.classe = c.name;

    try {
        await api.saveAct(cur, act);
    } catch (e) {
        return err(e.code === "23505" ? "Tu as déjà présenté un binôme." : explain(e));
    }

    try {
        await api.addPair(cur, t, r, prog.slice(0, 400));   // version publique, plus courte
        go("cand");
    } catch (e) {
        await api.removeAct(cur).catch(() => {});

        err(e.code === "23505" ? "Tu as déjà présenté un binôme." : explain(e));
    }
}

async function unapply(id) {
    if (C().phase !== "cand") {
        return;
    }

    try {
        await api.removePair(id);
        await api.removeAct(cur).catch(() => {});
        go("cand");
    } catch (e) {
        go("cand", explain(e));
    }
}


/* --- 6.5 Électeur ---------------------------------------------------- */

/* Coche / décoche un binôme sur le bulletin (1 ou 2 selon l'élection) */
function pick(id) {
    const c = C();

    if (!c || voted || c.phase !== "vote") {
        return;
    }

    if (picked.includes(id)) {
        picked = picked.filter(x => x !== id);
    } else {
        picked.push(id);

        /* Trop de choix : le plus ancien est remplacé */
        while (picked.length > ballotPicks(c)) {
            picked.shift();
        }
    }

    softRender();
}

/* Élève : envoie son prénom/pseudo au professeur */
async function requestAccess() {
    const pseudo = $("#pseudo").value.trim();

    if (!pseudo) {
        return err("Indique ton prénom ou un pseudo que ton professeur reconnaîtra.");
    }

    try {
        await api.requestAccess(cur, pseudo);
        go("vote");
    } catch (e) {
        err(explain(e));
    }
}

/* Dépose le bulletin : kind = "pair" (binôme[s] cochés), "blank" ou "abstain" */
async function ballot(kind) {
    const c = C();

    if (!c || voted || c.phase !== "vote") {
        return;
    }

    if (c.needApproval && myAccess.status !== "approved") {
        return err("Ton accès au vote n'a pas encore été validé par le professeur.");
    }

    let question;
    let ids = [];

    if (kind === "pair") {
        const k = ballotPicks(c);

        if (k < 1 || picked.length < 1 || picked.length > k) {
            return err("Choisis au moins un binôme avant de valider (ou vote blanc / abstention).");
        }

        ids = picked.slice();

        const names = ids
            .map(id => c.pairs.find(p => p.id === id))
            .filter(Boolean)
            .map(x => x.t + " & " + x.r)
            .join(" et ");

        question = "Confirmer ton vote pour " + names + " ? Il sera définitif.";
    } else if (kind === "blank") {
        question = "Voter blanc ? Ton bulletin comptera comme une participation mais ne sera attribué à aucun binôme. C'est définitif.";
    } else {
        question = "T'abstenir ? Tu ne prendras pas part à ce tour. C'est définitif.";
    }

    if (!confirm(question)) {
        return;
    }

    try {
        await api.castBallot(cur, kind, ids);
        picked = [];
        go("vote");
    } catch (e) {
        go("vote", explain(e));   // ex : « Ton accès au vote n'a pas été validé. »
    }
}


/* ==========================================================================
   7. MISE À JOUR AUTOMATIQUE (direct) 
   ========================================================================== */

/* Redessine l'écran sans perdre ce que l'utilisateur est en train de saisir */
function softRender() {
    const saved = [...document.querySelectorAll("#app input[id], #app textarea[id]")]
        .map(el => ({
            id:      el.id,
            value:   el.value,
            checked: el.checked,
            focus:   el === document.activeElement
        }));

    render();

    saved.forEach(s => {
        const el = document.getElementById(s.id);

        if (el) {
            el.value = s.value;
            el.checked = s.checked;

            if (s.focus) {
                el.focus();
            }
        }
    });
}

/* Relit la classe ; ne redessine que si quelque chose a changé.
   Quand le professeur publie les résultats, les élèves y sont emmenés
   automatiquement, sans aucun clic. */
async function poll() {
    if (document.hidden || !cur || !POLL_VIEWS.includes(view)) {
        return;
    }

    if (polling) {
        again = true;
        return;
    }

    polling = true;

    try {
        const fresh = await api.getClass(cur);

        if (!fresh) {
            return go("home", "Cette élection n'existe plus.");
        }

        /* L'utilisateur a pu changer d'écran pendant le chargement */
        if (!POLL_VIEWS.includes(view)) {
            return;
        }

        cls = fresh;

        if (!prof) {
            if (fresh.phase === "res" && view !== "res") {
                view = "res";
            } else if (fresh.phase !== "res" && view === "res") {
                view = fresh.phase === "vote" ? "vote" : "role";
            }
        }

        if (view === "vote") {
            voted = await api.hasVoted(cur);

            if (fresh.needApproval) {
                myAccess = await api.myAccess(cur);
            }
        }

        if (view === "live" && prof && fresh.needApproval) {
            access = await api.accessRows(cur);
        }

        const sig = view + "|" + signature(fresh, voted);

        if (sig !== lastSig) {
            lastSig = sig;
            softRender();
        }
    } catch (e) {
        console.warn("Mise à jour automatique impossible :", e);
    } finally {
        polling = false;

        if (again) {
            again = false;
            refreshLive();
        }
    }
}

/* Tableau de bord du professeur : même principe que poll() */
function dashSig(list) {
    return JSON.stringify(list.map(c =>
        [c.code, c.phase, c.round, c.cast, c.blank, c.abst, c.pairs.length, c.rounds.length]));
}

async function pollDash() {
    if (document.hidden || view !== "dash" || !prof) {
        return;
    }

    if (polling) {
        again = true;
        return;
    }

    polling = true;

    try {
        const fresh = await api.myClasses(prof);

        if (view !== "dash") {
            return;
        }

        myClasses = fresh;

        const sig = dashSig(fresh);

        if (sig !== lastDashSig) {
            lastDashSig = sig;
            softRender();
        }
    } catch (e) {
        console.warn("Mise à jour automatique impossible :", e);
    } finally {
        polling = false;

        if (again) {
            again = false;
            refreshLive();
        }
    }
}

const refreshLive = () => view === "dash" ? pollDash() : poll();


/* --- Temps réel : la base prévient dès qu'une ligne change -------------- */

function watch(key, specs) {
    if (rt.key === key) {
        return;
    }

    if (rt.channel) {
        sb.removeChannel(rt.channel);
    }

    rt = { key, channel: null };

    if (!key) {
        return;
    }

    const channel = sb.channel("live-" + (++rtCount));

    specs.forEach(sp => channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: sp.table, filter: sp.filter },
        refreshLive
    ));

    channel.subscribe();
    rt.channel = channel;
}

/* S'abonne à ce que l'écran courant affiche (classe ouverte, ou toutes les classes du professeur) */
function syncRealtime() {
    let key   = "";
    let specs = [];

    if (cur && cls && POLL_VIEWS.includes(view)) {
        key   = "class:" + cur;
        specs = [
            { table: "classes",      filter: "code=eq." + cur },
            { table: "pairs",        filter: "class_code=eq." + cur },
            { table: "voter_access", filter: "class_code=eq." + cur }
        ];
    } else if (view === "dash" && prof && myClasses.length) {
        const codes = myClasses.map(c => c.code).join(",");

        key   = "dash:" + codes;
        specs = [
            { table: "classes", filter: "owner=eq." + prof },
            { table: "pairs",   filter: "class_code=in.(" + codes + ")" }
        ];
    }

    watch(key, specs);
}

/* Filet de sécurité + rattrapage quand l'onglet redevient visible */
setInterval(refreshLive, POLL_MS);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        refreshLive();
    }
});


/* ==========================================================================
   7bis. ACTES DE CANDIDATURE ET PROCÈS-VERBAL (PDF)
   ========================================================================== */

let acts    = [];     // actes de candidature de la classe (professeur uniquement)
let minutes = null;   // procès-verbal enregistré (professeur uniquement)
let pvRows  = 4;      // nombre de lignes « binômes » du procès-verbal affiché

Object.assign(api, {

    /* Élève : enregistre son acte (lisible par le professeur seulement) */
    async saveAct(code, data) {
        check(await sb.from("candidacy_forms").insert({ class_code: code, data }));
    },

    async removeAct(code) {
        check(await sb.from("candidacy_forms").delete().eq("class_code", code).eq("owner", me));
    },

    /* Professeur : tous les actes de sa classe */
    async acts(code) {
        return check(
            await sb.from("candidacy_forms")
                .select("owner, data, created_at")
                .eq("class_code", code)
                .order("created_at")
        );
    },

    async minutes(code) {
        const row = check(await sb.from("minutes").select("data").eq("class_code", code).maybeSingle());
        return row ? row.data : null;
    },

    /* Clôture : supprime définitivement actes et procès-verbal de la classe */
    async purgeDossier(code) {
        check(await sb.from("candidacy_forms").delete().eq("class_code", code));
        check(await sb.from("minutes").delete().eq("class_code", code));

        /* Un refus RLS ne renvoie aucune erreur : on vérifie qu'il ne reste rien */
        const left = await api.acts(code);

        if (left.length) {
            throw new Error("Suppression impossible : exécute migration_v6.sql dans Supabase.");
        }
    },

    async saveMinutes(code, data) {
        check(await sb.from("minutes").upsert({
            class_code: code,
            data,
            updated_at: new Date().toISOString()
        }));
    }
});


/* --- Génération des PDF (jsPDF, chargé à la demande) ------------------- */

function loadPdf() {
    if (window.jspdf) {
        return Promise.resolve(window.jspdf.jsPDF);
    }

    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
        s.onload  = () => resolve(window.jspdf.jsPDF);
        s.onerror = () => reject(new Error("Module PDF indisponible : vérifie ta connexion."));
        document.head.appendChild(s);
    });
}

/* Les polices PDF standard ne connaissent que le Latin-1 */
const pdfSafe = s => String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...")
    .replace(/[–—]/g, "-").replace(/œ/g, "oe").replace(/Œ/g, "Oe")
    .replace(/[^\n\u0020-\u007E\u00A0-\u00FF]/g, "");

const slug = s => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function pdfFooter(doc) {
    for (let i = 1; i <= doc.getNumberOfPages(); i++) {
        doc.setPage(i);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text("Document généré par ClassVote le " + new Date().toLocaleDateString("fr-FR"), 105, 291, { align: "center" });
    }
}

/* Une page « ACTE DE CANDIDATURE » */
function drawAct(doc, a) {
    const M = 18, W = 210, w = W - 2 * M;
    let y = 24;

    const room = h => {
        if (y + h > 282) {
            doc.addPage();
            y = 22;
        }
    };

    doc.setTextColor(15, 27, 61);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(21);
    doc.text("ACTE DE CANDIDATURE", W / 2, y, { align: "center" });

    y += 5;
    doc.setDrawColor(30, 63, 204);
    doc.setLineWidth(.9);
    doc.line(M, y, W - M, y);
    y += 11;
    doc.setFontSize(11);

    const field = (label, value) => {
        doc.setFont("helvetica", "bold");
        const lw = doc.getTextWidth(label) + 3;

        doc.setFont("helvetica", "normal");
        const lines = doc.splitTextToSize(pdfSafe(value), w - lw);

        room(lines.length * 5.5 + 3);
        doc.setFont("helvetica", "bold");
        doc.text(label, M, y);
        doc.setFont("helvetica", "normal");
        doc.text(lines, M + lw, y);
        y += lines.length * 5.5 + 3;
    };

    const block = (label, value) => {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10.5);
        const head = doc.splitTextToSize("- " + label, w);

        doc.setFont("helvetica", "normal");
        const lines = doc.splitTextToSize(pdfSafe(value), w - 8);
        const h = Math.max(26, lines.length * 4.9 + 8);

        room(head.length * 5 + h + 8);

        doc.setFont("helvetica", "bold");
        doc.text(head, M, y);
        y += head.length * 5 + 1.5;

        doc.setDrawColor(150, 160, 190);
        doc.setLineWidth(.3);
        doc.roundedRect(M, y, w, h, 2, 2);

        doc.setFont("helvetica", "normal");
        doc.text(lines, M + 4, y + 6.5);
        y += h + 8;
    };

    field("CLASSE :", a.classe);
    field("NOM, PRÉNOM DU TITULAIRE :", `${a.tn} ${a.tp}`);
    field("NOM, PRÉNOM DU SUPPLÉANT :", `${a.sn} ${a.sp}`);
    y += 4;

    block("PRÉSENTEZ-VOUS BRIÈVEMENT (NOM, ÂGE, QUALITÉS) :", a.pres);
    block("VOS MOTIVATIONS (POURQUOI VOUS AVEZ CHOISI D'ÊTRE CANDIDATS, COMMENT LE TITULAIRE A CHOISI SON SUPPLÉANT) :", a.mot);
    block("VOTRE PROGRAMME (VOTRE RÔLE AUPRÈS DE LA CLASSE, DES PROFESSEURS, DE L'ADMINISTRATION, VOS PROJETS) :", a.prog);
    block("VOTRE SLOGAN ? :", a.slogan);
}

/* Tableau simple : chaque ligne s'adapte à son texte */
function pdfTable(doc, x, y, widths, head, rows, minH = 8) {
    doc.setDrawColor(90, 100, 130);
    doc.setLineWidth(.25);
    doc.setTextColor(15, 27, 61);

    const draw = (cells, bold) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(9.5);

        const lines = cells.map((c, i) => doc.splitTextToSize(pdfSafe(c), widths[i] - 4));
        const h = Math.max(minH, Math.max(...lines.map(l => l.length)) * 4.4 + 4);

        if (y + h > 282) {
            doc.addPage();
            y = 20;
        }

        let cx = x;

        cells.forEach((_, i) => {
            if (bold) {
                doc.setFillColor(232, 236, 250);
                doc.rect(cx, y, widths[i], h, "FD");
            } else {
                doc.rect(cx, y, widths[i], h);
            }
            doc.text(lines[i], cx + 2, y + 5.4);
            cx += widths[i];
        });

        y += h;
    };

    draw(head, true);
    rows.forEach(r => draw(r, false));
    return y;
}

const PV_STATS = [
    ["eleves",      "Nombre d'élèves de la classe"],
    ["absents",     "Nombre d'élèves absents"],
    ["abstentions", "Abstentions"],
    ["votants",     "Votants"],
    ["blancs",      "Bulletins blancs ou nuls"],
    ["exprimes",    "Suffrages exprimés"],
    ["majorite",    "Majorité absolue (1/2 des voix +1)"]
];

/* « PROCÈS-VERBAL D'ÉLECTION DES DÉLÉGUÉS DE CLASSE » */
function drawMinutes(doc, p) {
    const M = 18, W = 210, w = W - 2 * M;
    const dots = (v, n) => v || ".".repeat(n);
    let y = 22;

    doc.setTextColor(15, 27, 61);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("PROCÈS-VERBAL D'ÉLECTION", W / 2, y, { align: "center" });
    doc.text("DES DÉLÉGUÉS DE CLASSE", W / 2, y + 7, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Année scolaire " + pdfSafe(p.annee), W / 2, y + 15, { align: "center" });
    y += 25;

    const intro = doc.splitTextToSize(pdfSafe(
        `Je soussigné(e) M. / Mme ${dots(p.prof, 20)} déclare avoir fait procéder le ${dots(p.date, 12)} ` +
        `à l'élection des deux délégués de la classe de ${dots(p.classe, 12)}.`), w);

    doc.text(intro, M, y);
    y += intro.length * 5.5 + 5;

    y = pdfTable(doc, M, y, [94, 40, 40],
        ["TITULAIRE + SON SUPPLÉANT", "Suffrages 1er tour", "Suffrages 2ème tour"],
        p.rows.map(r => [r.name, r.t1, r.t2])) + 8;

    y = pdfTable(doc, M, y, [94, 40, 40],
        ["", "1er tour", "2ème tour"],
        PV_STATS.map(([k, label]) => [label, p.stats[k][0], p.stats[k][1]])) + 9;

    if (y > 225) {
        doc.addPage();
        y = 22;
    }

    doc.setFont("helvetica", "bold");
    doc.text("Élèves élus délégués :", M, y);
    y += 3;

    y = pdfTable(doc, M, y, [84, 30, 60],
        ["TITULAIRE + SUPPLÉANT", "Régime : D.P, EXT", "Signatures"],
        p.elus.map(e => [e.name || "/", e.regime || "/", ""]), 14) + 12;

    if (y > 235) {
        doc.addPage();
        y = 22;
    }

    doc.setFont("helvetica", "normal");
    doc.text(pdfSafe("Signature du président de séance : " + (p.president || "")), M, y);
    y += 24;
    doc.text(pdfSafe("Les assesseurs : " + [p.assesseurs[0], p.assesseurs[1]].filter(Boolean).join("   ")), M, y);
    y += 24;
    doc.text("Binôme de titulaires :", M, y);
}

function note(text, ok) {
    const el = $("#msg");

    if (el) {
        el.textContent = text;
        el.classList.toggle("ok", !!ok);
    }
}

async function savePdf(list, name) {
    try {
        const J   = await loadPdf();
        const doc = new J({ unit: "mm", format: "a4" });

        list.forEach((a, i) => {
            if (i) {
                doc.addPage();
            }
            drawAct(doc, a.data);
        });

        pdfFooter(doc);
        doc.save(name);
        note("PDF téléchargé.", true);
    } catch (e) {
        note(explain(e));
    }
}

function downloadAct(owner) {
    const a = acts.find(z => z.owner === owner);

    if (a) {
        savePdf([a], `acte-candidature-${slug(a.data.classe)}-${slug(a.data.tn)}-${slug(a.data.sn)}.pdf`);
    }
}

function downloadAllActs() {
    if (!acts.length) {
        return note("Aucun acte à télécharger.");
    }
    savePdf(acts, `actes-candidature-${slug(C().name)}.pdf`);
}


/* --- Procès-verbal : formulaire du professeur -------------------------- */

/* Pré-remplissage à partir du vote (modifiable par le professeur) */
function defaultMinutes(c) {
    const r1 = c.rounds[0];
    const r2 = c.rounds[1];

    const votes = (h, id) => {
        const x = h && (h.results || []).find(z => z.id === id);
        return x ? String(x.votes) : "";
    };

    const stats = h => {
        if (!h) {
            return {};
        }
        const valid = h.valid ?? h.cast;

        return {
            eleves: h.n, absents: Math.max(0, h.n - h.cast), abstentions: h.abstain || 0,
            votants: h.cast - (h.abstain || 0), blancs: h.blank || 0,
            exprimes: valid, majorite: Math.floor(valid / 2) + 1
        };
    };

    const nameOf = x => {
        const a = acts.find(z => z.owner === x.owner);
        return a ? `${a.data.tn} ${a.data.tp} + ${a.data.sn} ${a.data.sp}` : `${x.t} + ${x.r}`;
    };

    const s1 = stats(r1);
    const s2 = stats(r2);

    const rows = c.pairs.slice(0, 8).map(x => ({ name: nameOf(x), t1: votes(r1, x.id), t2: votes(r2, x.id) }));
    const elus = electedPairs(c).slice(0, 2).map(x => ({ name: nameOf(x), regime: "" }));

    while (rows.length < 4) {
        rows.push({ name: "", t1: "", t2: "" });
    }
    while (elus.length < 2) {
        elus.push({ name: "", regime: "" });
    }

    return {
        prof: "", date: new Date().toLocaleDateString("fr-FR"), classe: c.name, annee: "2026-2027",
        rows,
        stats: Object.fromEntries(PV_STATS.map(([k]) => [k, [String(s1[k] ?? ""), String(s2[k] ?? "")]])),
        elus, president: "", assesseurs: ["", ""]
    };
}

function readMinutes() {
    const g = id => ($("#" + id) ? $("#" + id).value.trim() : "");

    return {
        prof: g("pv-prof"), date: g("pv-date"), classe: g("pv-classe"), annee: g("pv-annee"),
        rows: Array.from({ length: pvRows }, (_, i) => ({ name: g("pv-n" + i), t1: g("pv-a" + i), t2: g("pv-b" + i) })),
        stats: Object.fromEntries(PV_STATS.map(([k]) => [k, [g(`pv-s-${k}-1`), g(`pv-s-${k}-2`)]])),
        elus: [0, 1].map(i => ({ name: g("pv-en" + i), regime: g("pv-er" + i) })),
        president: g("pv-pres"),
        assesseurs: [g("pv-ass0"), g("pv-ass1")]
    };
}

function viewDossier(m) {
    const c  = C();
    const pm = minutes || defaultMinutes(c);

    pvRows = pm.rows.length;

    const field = (id, label, val) =>
        `<label class="fld"><span class="small muted">${label}</span><input id="${id}" value="${esc(val)}" maxlength="80"></label>`;

    const actsHTML = c.pairs.map(x => {
        const a = acts.find(z => z.owner === x.owner);

        return a
            ? `<div class="access-row row between">
                   <span><b>${esc(x.t)} &amp; ${esc(x.r)}</b><br>
                         <span class="muted small">${esc(a.data.tn)} ${esc(a.data.tp)} · ${esc(a.data.sn)} ${esc(a.data.sp)}</span></span>
                   <button onclick="downloadAct('${esc(a.owner)}')">Télécharger (PDF)</button>
               </div>`
            : `<div class="access-row"><b>${esc(x.t)} &amp; ${esc(x.r)}</b> <span class="muted small">· pas d'acte enregistré</span></div>`;
    }).join("") || `<p class="muted">Aucun binôme pour l'instant.</p>`;

    const rowsHTML = pm.rows.map((r, i) => `
        <tr>
            <td><input id="pv-n${i}" value="${esc(r.name)}" aria-label="Binôme ${i + 1}"></td>
            <td><input id="pv-a${i}" value="${esc(r.t1)}" aria-label="Suffrages 1er tour, binôme ${i + 1}"></td>
            <td><input id="pv-b${i}" value="${esc(r.t2)}" aria-label="Suffrages 2ème tour, binôme ${i + 1}"></td>
        </tr>`).join("");

    const statsHTML = PV_STATS.map(([k, label]) => `
        <tr>
            <th scope="row">${label}</th>
            <td><input id="pv-s-${k}-1" value="${esc(pm.stats[k][0])}" aria-label="${label}, 1er tour"></td>
            <td><input id="pv-s-${k}-2" value="${esc(pm.stats[k][1])}" aria-label="${label}, 2ème tour"></td>
        </tr>`).join("");

    const elusHTML = pm.elus.map((e, i) => `
        <tr>
            <td><input id="pv-en${i}" value="${esc(e.name)}" aria-label="Élu ${i + 1}"></td>
            <td>
                <select id="pv-er${i}" aria-label="Régime, élu ${i + 1}">
                    ${["", "D.P", "EXT"].map(o => `<option value="${o}" ${e.regime === o ? "selected" : ""}>${o || "—"}</option>`).join("")}
                </select>
            </td>
        </tr>`).join("");

    return `
        <h1>Dossier · ${esc(c.name)}</h1>
        <p class="muted">Réservé au professeur : actes de candidature et procès-verbal.</p>

        ${m}

        <div class="box">
            <div class="row between">
                <h2>Actes de candidature</h2>
                <button class="go" onclick="downloadAllActs()">Tout télécharger (1 PDF)</button>
            </div>
            ${actsHTML}
        </div>

        <form class="box pv" onsubmit="event.preventDefault(); saveMinutes()">
            <h2>Procès-verbal d'élection</h2>
            <p class="muted small">Pré-rempli à partir du vote ; corrige ce qui doit l'être (absents, régime, noms…).</p>

            <div class="split">
                ${field("pv-prof", "Je soussigné(e) M. / Mme", pm.prof)}
                ${field("pv-date", "Élection du", pm.date)}
                ${field("pv-classe", "Classe de", pm.classe)}
                ${field("pv-annee", "Année scolaire", pm.annee)}
            </div>

            <div class="scroll"><table>
                <tr><th>Titulaire + suppléant</th><th>1er tour</th><th>2ème tour</th></tr>
                ${rowsHTML}
            </table></div>

            <div class="scroll"><table>
                <tr><th></th><th>1er tour</th><th>2ème tour</th></tr>
                ${statsHTML}
            </table></div>

            <h2>Élèves élus délégués</h2>
            <div class="scroll"><table>
                <tr><th>Titulaire + suppléant</th><th>Régime</th></tr>
                ${elusHTML}
            </table></div>

            <div class="split">
                ${field("pv-pres", "Président de séance", pm.president)}
                ${field("pv-ass0", "Assesseur 1", pm.assesseurs[0])}
                ${field("pv-ass1", "Assesseur 2", pm.assesseurs[1])}
            </div>

            <div class="row">
                <button class="go">Enregistrer</button>
                <button type="button" onclick="downloadMinutes()">Enregistrer et télécharger (PDF)</button>
            </div>
        </form>

        <div class="box">
            <h2>Clôturer l'élection</h2>
            <p class="muted">Supprime définitivement les actes de candidature et le procès-verbal enregistrés.
               Télécharge-les d'abord : après la clôture, ils ne sont plus récupérables.</p>
            ${c.phase === "res" ? "" : `<p class="notice">Publie d'abord les résultats pour pouvoir clôturer.</p>`}
            <div class="row">
                <button class="danger" onclick="closeElection()" ${c.phase === "res" ? "" : "disabled"}>Clôturer et supprimer les données</button>
            </div>
        </div>

        <button class="link" onclick="go('dash')">← Tableau de bord</button>`;
}

Object.assign(VIEWS, { dossier: viewDossier });

function openDossier(k) {
    if (prof) {
        cur = k;
        go("dossier");
    }
}

async function saveMinutes(quiet) {
    const p = readMinutes();

    try {
        await api.saveMinutes(cur, p);
        minutes = p;
        if (!quiet) {
            note("Procès-verbal enregistré.", true);
        }
        return p;
    } catch (e) {
        note(explain(e));
        return null;
    }
}

async function closeElection() {
    if (C().phase !== "res") {
        return note("Publie d'abord les résultats.");
    }

    if (!confirm("Clôturer l'élection ? Les actes de candidature et le procès-verbal seront supprimés définitivement. Les as-tu téléchargés ?")) {
        return;
    }

    try {
        await api.purgeDossier(cur);
        minutes = null;
        await go("dossier");
        note("Élection clôturée : les données ont été supprimées.", true);
    } catch (e) {
        note(explain(e));
    }
}

async function downloadMinutes() {
    const p = await saveMinutes(true);

    if (!p) {
        return;
    }

    try {
        const J   = await loadPdf();
        const doc = new J({ unit: "mm", format: "a4" });

        drawMinutes(doc, p);
        pdfFooter(doc);
        doc.save(`proces-verbal-${slug(p.classe) || "classe"}.pdf`);
        note("Procès-verbal enregistré et téléchargé.", true);
    } catch (e) {
        note(explain(e));
    }
}


/* ==========================================================================
   8. THÈME, COOKIES ET PAGES LÉGALES
   ========================================================================== */

/* --- 8.1 Cookies maison (le jeton de session Supabase est géré à part) -- */

const CONSENT_KEY = "cv_consent";   // « all » ou « essential », 6 mois
const THEME_KEY   = "cv_theme";     // « light » ou « dark », seulement si « all »
const COOKIE_DAYS = 180;

function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(name, value, days) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${days * 86400}; path=/; SameSite=Lax${secure}`;
}

function eraseCookie(name) {
    document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax`;
}


/* --- 8.2 Mode sombre ---------------------------------------------------- */

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

const currentTheme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

function setTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.content = theme === "dark" ? "#0B1020" : "#F2F4F9";
    }

    const btn = $("#theme-btn");
    if (btn) {
        btn.setAttribute("aria-label", theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre");
    }

    /* Mémorisé uniquement si l'utilisateur a accepté les cookies de préférence */
    if (persist && readCookie(CONSENT_KEY) === "all") {
        writeCookie(THEME_KEY, theme, COOKIE_DAYS);
    }
}

function toggleTheme() {
    setTheme(currentTheme() === "dark" ? "light" : "dark", true);
}

/* Sans choix mémorisé, on suit le réglage du système en direct */
darkQuery.addEventListener("change", e => {
    if (!readCookie(THEME_KEY)) {
        setTheme(e.matches ? "dark" : "light");
    }
});

setTheme(currentTheme());


/* --- 8.3 Bandeau de consentement --------------------------------------- */

function showConsent(custom) {
    const prefs = readCookie(CONSENT_KEY) === "all";

    const body = custom
        ? `
            <label class="opt">
                <input type="checkbox" checked disabled>
                <span><b>Essentiels</b> (toujours actifs) : connexion anonyme ou professeur, mémorisation de ton choix.</span>
            </label>
            <label class="opt">
                <input type="checkbox" id="ck-pref" ${prefs ? "checked" : ""}>
                <span><b>Préférences</b> : retenir ton thème clair ou sombre.</span>
            </label>
            <div class="row">
                <button class="go" onclick="saveConsent()">Enregistrer mes choix</button>
                <button class="link" onclick="showConsent(false)">Retour</button>
            </div>`
        : `
            <p class="muted small">
                Ce site utilise uniquement le stockage nécessaire à son fonctionnement.
                Tu peux en plus autoriser la mémorisation de ton thème. Aucun cookie publicitaire
                ni de mesure d'audience. <a href="#/cookies">En savoir plus</a>
            </p>
            <div class="row">
                <button class="go" onclick="setConsent('essential')">Tout refuser</button>
                <button class="go" onclick="setConsent('all')">Tout accepter</button>
                <button class="link" onclick="showConsent(true)">Personnaliser</button>
            </div>`;

    $("#consent-root").innerHTML = `
        <section class="consent" role="dialog" aria-labelledby="ck-t">
            <div class="consent-card">
                <h2 id="ck-t">🍪 Cookies</h2>
                ${body}
            </div>
        </section>`;

    const first = $("#consent-root button, #consent-root input:not([disabled])");
    if (first && custom) {
        first.focus();
    }
}

function setConsent(value) {
    writeCookie(CONSENT_KEY, value, COOKIE_DAYS);

    if (value === "all") {
        writeCookie(THEME_KEY, currentTheme(), COOKIE_DAYS);
    } else {
        eraseCookie(THEME_KEY);
    }

    $("#consent-root").innerHTML = "";
}

function saveConsent() {
    setConsent($("#ck-pref").checked ? "all" : "essential");
}


/* --- 8.4 Contenu des pages légales ------------------------------------- */

const TODO = t => `<mark class="todo">[${t}]</mark>`;
const UPDATED = "15 octobre 2026";

const SLUGS = {
    legal:   "mentions-legales",
    cgu:     "cgu",
    cookies: "cookies"
};

const PAGE_TITLES = {
    legal:   "Mentions légales",
    cgu:     "Conditions générales d'utilisation",
    cookies: "Cookies et données personnelles",
    nf:      "Page introuvable"
};

const STATIC_VIEWS = Object.keys(PAGE_TITLES);

let backView = "home";   // écran où revenir en quittant une page légale

const docHTML = (title, body) => `
    <article class="doc">
        <h1>${title}</h1>
        <p class="muted small">Dernière mise à jour : ${UPDATED}</p>
        ${body}
        <div class="row"><button class="link" onclick="closePage()">← Retour à l'application</button></div>
    </article>`;

function viewLegal() {
    return docHTML("Mentions légales", `
        <h2>Éditeurs du site</h2>
        <p>ClassVote est édité par <b>Enzo Perdu</b> et <b>Emerick Woiret</b>, personnes physiques.
           Contact : ${TODO("enzo.perdu@outlook.fr")}</p>

        <h2>Directeurs de la publication</h2>
        <p>Enzo Perdu et Emerick Woiret.</p>

        <h2>Hébergement</h2>
        <p>Site : ${TODO("Vercel")}</p>
        <p>Base de données et authentification : Supabase (supabase.com).</p>

        <h2>Propriété intellectuelle</h2>
        <p>© 2026 Enzo Perdu et Emerick Woiret. Tous droits réservés.</p>
        <p>Le nom ClassVote, le code source, la conception graphique, les textes et l'organisation
           de ce site sont la propriété exclusive d'Enzo Perdu et d'Emerick Woiret, ses auteurs.
           Toute reproduction, représentation, modification ou exploitation, totale ou partielle,
           sans leur autorisation écrite préalable est interdite
           (articles L.111-1, L.122-4 et L.335-2 du Code de la propriété intellectuelle).</p>
        <p>Les contenus saisis par les utilisateurs (prénoms, programmes) restent leur propriété ;
           ils autorisent seulement leur affichage dans l'élection concernée.</p>
        <p>Éléments tiers : polices Big Shoulders Display et Public Sans (licence SIL OFL, via Google Fonts)
           et bibliothèques Supabase JS et jsPDF (licence MIT).</p>

        <h2>Responsabilité</h2>
        <p>Le site est fourni sans garantie de disponibilité continue. Les éditeurs ne peuvent être tenus
           responsables d'une interruption, d'une perte de données ou d'un usage non conforme du service.</p>

        <h2>Données personnelles</h2>
        <p>Voir la page <a href="#/cookies">Cookies et données personnelles</a>.</p>

        <h2>Droit applicable</h2>
        <p>Le droit français s'applique. En cas de litige, les tribunaux français sont compétents,
           sous réserve des règles protégeant les consommateurs.</p>`);
}

function viewCgu() {
    return docHTML("Conditions générales d'utilisation", `
        <h2>1. Objet</h2>
        <p>ClassVote permet d'organiser l'élection des délégués d'une classe : candidatures en binôme
           (titulaire et remplaçant), vote anonyme, résultats. Utiliser le site vaut acceptation des présentes conditions.</p>

        <h2>2. Rôles</h2>
        <ul>
            <li><b>Professeur</b> : crée un compte, ouvre une élection, valide les élèves si besoin, ouvre le vote, publie les résultats.</li>
            <li><b>Élève</b> : entre le code à 6 chiffres, peut se porter candidat ou voter, sans compte.</li>
        </ul>
        <p>Le service est prévu pour un usage scolaire. Les élèves mineurs l'utilisent sous la responsabilité du professeur qui organise l'élection.</p>

        <h2>3. Règles du vote</h2>
        <ul>
            <li>Chaque appareil dispose d'un seul bulletin par tour.</li>
            <li>Le vote blanc et l'abstention sont possibles. Un bulletin validé est définitif.</li>
            <li>Un binôme est élu à la majorité absolue des suffrages exprimés ; sinon un nouveau tour a lieu.</li>
        </ul>

        <h2>4. Comportement attendu</h2>
        <p>Il est interdit de saisir des contenus injurieux, discriminatoires, diffamatoires ou illicites, d'usurper l'identité d'autrui,
           de voter plusieurs fois par des moyens détournés ou de perturber le service (attaque, automatisation, tentative d'accès non autorisé).
           Ne saisis que les informations demandées : l'acte de candidature (noms, présentation) n'est lu que par le professeur.
           Le professeur peut supprimer une élection ou une candidature.</p>

        <h2>5. Compte professeur</h2>
        <p>Le professeur est responsable de la confidentialité de son mot de passe et des élections qu'il crée.</p>

        <h2>6. Données personnelles</h2>
        <p>Le traitement des données est décrit dans la page <a href="#/cookies">Cookies et données personnelles</a>.</p>

        <h2>7. Propriété intellectuelle</h2>
        <p>Le site appartient à Enzo Perdu et Emerick Woiret (voir les <a href="#/mentions-legales">mentions légales</a>).
           Aucun droit sur le code, le nom ou le design n'est cédé aux utilisateurs.</p>

        <h2>8. Responsabilité et disponibilité</h2>
        <p>Le service est fourni « en l'état », sans garantie d'absence d'erreur ou d'interruption.
           Les résultats ont une valeur pédagogique ; ils n'ont pas de valeur d'élection officielle.</p>

        <h2>9. Modification des conditions</h2>
        <p>Les CGU peuvent évoluer ; la version en ligne fait foi, avec sa date de mise à jour.</p>

        <h2>10. Droit applicable et contact</h2>
        <p>Droit français. Contact : ${TODO("enzo.perdu@outlook.fr")}</p>`);
}

function viewCookies() {
    return docHTML("Cookies et données personnelles", `
        <h2>Ce qui est stocké sur ton appareil</h2>
        <div class="scroll"><table>
            <tr><th>Nom</th><th>Rôle</th><th>Durée</th><th>Consentement</th></tr>
            <tr><td>Session (sb-…-auth-token)</td><td>Te reconnaître : session anonyme de l'élève ou connexion du professeur</td><td>Jusqu'à déconnexion</td><td>Non requis (essentiel)</td></tr>
            <tr><td>cv_consent</td><td>Retenir ton choix sur les cookies</td><td>6 mois</td><td>Non requis (essentiel)</td></tr>
            <tr><td>cv_theme</td><td>Retenir ton thème clair ou sombre</td><td>6 mois</td><td>Oui (préférences)</td></tr>
            <tr><td>approved:… (professeur)</td><td>Repérer les doublons d'élèves, uniquement sur l'appareil du professeur</td><td>Jusqu'à effacement</td><td>Non requis (essentiel)</td></tr>
        </table></div>
        <p>Aucun cookie publicitaire, aucun outil de mesure d'audience, aucun suivi entre sites.</p>
        <div class="row"><button onclick="showConsent(true)">Modifier mes choix</button></div>

        <h2>Responsables du traitement</h2>
        <p>Enzo Perdu et Emerick Woiret. Contact : ${TODO("enzo.perdu@outlook.fr")}</p>

        <h2>Données traitées</h2>
        <ul>
            <li>Professeur : adresse e-mail et mot de passe (chiffré par Supabase), élections créées.</li>
            <li>Élève : identifiant technique anonyme de l'appareil, bulletin (sans nom), prénom ou pseudo si la validation est activée.</li>
            <li>Candidat : noms et prénoms du binôme, présentation, motivations, programme et slogan (acte de candidature). Les prénoms et le programme sont visibles par la classe ; l'acte complet n'est lu que par le professeur.</li>
            <li>Professeur : procès-verbal de l'élection (résultats, noms des élus, président et assesseurs).</li>
        </ul>
        <p>Finalités : faire fonctionner l'élection (exécution du service). Les actes de candidature et le procès-verbal sont supprimés dès que le professeur clôture l'élection ; le reste des données est supprimé avec l'élection.
           Elles sont hébergées chez Supabase, qui agit comme sous-traitant.</p>
        <p>Les polices sont chargées depuis Google Fonts : ton adresse IP est alors transmise à Google.</p>

        <h2>Tes droits</h2>
        <p>Tu peux demander l'accès, la rectification ou l'effacement de tes données, ou t'opposer à leur traitement, en écrivant à l'adresse de contact.
           Tu peux aussi introduire une réclamation auprès de la CNIL (<a href="https://www.cnil.fr/fr/plaintes" rel="noopener">cnil.fr/fr/plaintes</a>).</p>`);
}

function viewNotFound() {
    return `
        <section class="nf doc">
            <div class="num" aria-hidden="true">404</div>
            <span class="stamp">Bulletin nul</span>
            <h1>Page introuvable</h1>
            <p class="muted">Cette page n'existe pas ou a été déplacée.</p>
            <button class="go" onclick="closePage()">Retour à l'accueil</button>
        </section>`;
}

Object.assign(VIEWS, {
    legal:   viewLegal,
    cgu:     viewCgu,
    cookies: viewCookies,
    nf:      viewNotFound
});


/* --- 8.5 Routage des pages légales (#/cgu, #/cookies…) ----------------- */

function pageFromHash() {
    if (!location.hash.startsWith("#/")) {
        return null;
    }

    const slug = location.hash.slice(2);
    return Object.keys(SLUGS).find(k => SLUGS[k] === slug) || "nf";
}

function syncHash() {
    const page = pageFromHash();

    if (page) {
        if (!STATIC_VIEWS.includes(view)) {
            backView = view;
        }
        view = page;
        render();
        window.scrollTo(0, 0);
    } else if (STATIC_VIEWS.includes(view)) {
        go(backView);
    }
}

function closePage() {
    go(backView === "nf" ? "home" : backView);
}

function setTitle() {
    document.title = PAGE_TITLES[view]
        ? PAGE_TITLES[view] + " · ClassVote"
        : "Élection des délégués";
}

window.addEventListener("hashchange", syncHash);
window.addEventListener("popstate", syncHash);

if (!readCookie(CONSENT_KEY)) {
    showConsent(false);
}


/* ==========================================================================
   9. DÉMARRAGE Emerick
   ========================================================================== */

(async () => {
    try {
        const user = await api.session();
        me = user.id;

        /* Un professeur déjà connecté retrouve directement son tableau de bord */
        if (!user.is_anonymous) {
            prof = user.id;

            if (pageFromHash()) {
                view = "dash";
                return syncHash();
            }

            return go("dash");
        }
    } catch (e) {
        /* Aucun message ici : l'élève n'a encore rien fait.
           La session sera retentée (ensureMe) à sa première action. */
        console.warn("Session non établie au démarrage :", e);
    }

    if (pageFromHash()) {
        syncHash();
    } else {
        render();
    }
})();
