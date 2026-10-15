-- ============================================================================
-- Élection des délégués : MIGRATION v3
-- À coller dans Supabase → SQL Editor → Run (par-dessus le schéma existant).
-- Le script peut être relancé sans risque.
--
-- Nouveautés :
--   • vote blanc et abstention (côté électeur)
--   • option « 2 binômes par bulletin », choisie par le professeur à la création
--   • codes de vote individuels : empêchent de voter deux fois en navigation
--     privée (une nouvelle session anonyme ne suffit plus, il faut un code
--     valide et non utilisé pour le tour)
--
-- Règles de décompte :
--   • cast_votes   = nombre de bulletins reçus (valides + blancs + abstentions)
--   • suffrages exprimés = cast_votes - blank_votes - abstentions
--   • majorité absolue = plus de la moitié des SUFFRAGES EXPRIMÉS
--     (blancs et abstentions ne comptent pas, comme dans le droit français)
-- ============================================================================


-- 1. COLONNES ---------------------------------------------------------------

alter table public.classes add column if not exists double_vote boolean not null default false;
alter table public.classes add column if not exists use_codes   boolean not null default false;  -- false pour les anciennes élections
alter table public.classes add column if not exists blank_votes int     not null default 0;
alter table public.classes add column if not exists abstentions int     not null default 0;


-- 2. CODES DE VOTE ----------------------------------------------------------

-- Un code par élève (distribué sur papier par le professeur)
create table if not exists public.vote_codes (
    class_code  text not null references public.classes(code) on delete cascade,
    code        text not null,
    primary key (class_code, code)
);

-- Code utilisé pour un tour donné.
-- Volontairement SANS voter_id, SANS date et SANS binôme : impossible de relier
-- un code à un vote, le scrutin reste anonyme.
create table if not exists public.vote_code_uses (
    class_code  text not null,
    round       int  not null,
    code        text not null,
    primary key (class_code, round, code),
    foreign key (class_code, code) references public.vote_codes(class_code, code) on delete cascade
);


-- 3. DROITS ET RLS ----------------------------------------------------------

revoke all on public.vote_codes, public.vote_code_uses from anon, authenticated;

-- Le professeur peut choisir les options à la création (en plus de code, name, n)
grant insert (double_vote, use_codes) on public.classes to authenticated;

-- Seul le professeur propriétaire peut lire les codes de sa classe
grant select on public.vote_codes to authenticated;

alter table public.vote_codes     enable row level security;
alter table public.vote_code_uses enable row level security;   -- aucune policy : accès via fonctions uniquement

drop policy if exists vote_codes_owner_read on public.vote_codes;
create policy vote_codes_owner_read on public.vote_codes for select
    using (
        public.is_teacher()
        and exists (select 1 from public.classes c
                    where c.code = class_code and c.owner = auth.uid())
    );


-- 4. GÉNÉRATION DES CODES (professeur propriétaire) ------------------------------

create or replace function public.generate_codes(p_class text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    c       classes%rowtype;
    v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- sans I, O, 0, 1
    v_code  text;
    v_count int;
    i       int;
begin
    select * into c from classes where code = p_class for update;

    if not found then
        raise exception 'Classe introuvable.';
    end if;
    if c.owner is distinct from auth.uid() or not public.is_teacher() then
        raise exception 'Action non autorisée.' using errcode = '42501';
    end if;

    select count(*) into v_count from vote_codes where class_code = c.code;

    while v_count < c.n loop
        v_code := '';
        for i in 1..6 loop
            v_code := v_code || substr(v_alpha, 1 + floor(random() * 32)::int, 1);
        end loop;

        insert into vote_codes (class_code, code) values (c.code, v_code)
        on conflict do nothing;

        if found then
            v_count := v_count + 1;
        end if;
    end loop;

    return v_count;
end;
$$;

revoke all on function public.generate_codes(text) from public;
grant execute on function public.generate_codes(text) to authenticated;


-- 5. BULLETIN : binôme(s) / blanc / abstention ----------------------------------
-- Remplace cast_vote(text). Un seul point d'entrée, tout est vérifié côté serveur.

drop function if exists public.cast_vote(text);
drop function if exists public.cast_ballot(text, text, text[], text);

create function public.cast_ballot(
    p_class text,
    p_kind  text,                       -- 'pair' | 'blank' | 'abstain'
    p_pairs text[] default '{}',        -- id des binômes choisis (kind = 'pair')
    p_code  text   default null         -- code de vote personnel (si la classe l'exige)
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid     uuid := auth.uid();
    v_cls     classes%rowtype;
    v_code    text := upper(btrim(coalesce(p_code, '')));
    v_elected int;
    v_running int;
    v_picks   int;
    v_ids     uuid[];
    v_ok      int;
begin
    if v_uid is null then
        raise exception 'Session requise.' using errcode = '42501';
    end if;
    if p_kind not in ('pair', 'blank', 'abstain') then
        raise exception 'Type de bulletin inconnu.';
    end if;

    -- Verrouille la classe : les votes simultanés passent un par un
    select * into v_cls from classes where code = p_class for update;

    if not found then
        raise exception 'Classe introuvable.';
    end if;
    if v_cls.phase <> 'vote' then
        raise exception 'Le vote n''est pas ouvert.' using errcode = '42501';
    end if;
    if v_cls.cast_votes >= v_cls.n then
        raise exception 'Tous les votes de ce tour ont été exprimés.';
    end if;

    -- Combien de binômes sur ce bulletin ? 1, ou 2 si l'option est activée
    -- (et s'il reste au moins 2 sièges et 2 binômes en lice)
    select count(*) filter (where seat is not null),
           count(*) filter (where seat is null)
      into v_elected, v_running
      from pairs where class_code = v_cls.code;

    v_picks := case when v_cls.double_vote
                    then least(2, v_cls.seats - v_elected)
                    else 1 end;
    v_picks := least(v_picks, v_running);

    if p_kind = 'pair' then
        if v_picks < 1 then
            raise exception 'Aucun binôme en lice.';
        end if;

        select array_agg(distinct x::uuid) into v_ids from unnest(p_pairs) as x;

        if coalesce(cardinality(p_pairs), 0) <> v_picks
           or coalesce(cardinality(v_ids), 0) <> v_picks then
            raise exception 'Choisis exactement % binôme(s) différent(s).', v_picks;
        end if;

        select count(*) into v_ok
          from pairs
         where id = any(v_ids) and class_code = v_cls.code and seat is null;

        if v_ok <> v_picks then
            raise exception 'Binôme invalide ou déjà élu.';
        end if;
    end if;

    -- Un bulletin par appareil et par tour
    begin
        insert into round_voters (class_code, round, voter_id)
        values (v_cls.code, v_cls.round, v_uid);
    exception when unique_violation then
        raise exception 'Tu as déjà voté pour ce tour.';
    end;

    -- Un bulletin par CODE et par tour : bloque le vote en navigation privée
    if v_cls.use_codes then
        if not exists (select 1 from vote_codes
                       where class_code = v_cls.code and code = v_code) then
            raise exception 'Code de vote invalide.';
        end if;

        begin
            insert into vote_code_uses (class_code, round, code)
            values (v_cls.code, v_cls.round, v_code);
        exception when unique_violation then
            raise exception 'Ce code de vote a déjà servi pour ce tour.';
        end;
    end if;

    -- Décompte
    if p_kind = 'pair' then
        update pairs set votes = votes + 1 where id = any(v_ids);
    end if;

    update classes
       set cast_votes  = cast_votes + 1,
           blank_votes = blank_votes + (p_kind = 'blank')::int,
           abstentions = abstentions + (p_kind = 'abstain')::int
     where code = v_cls.code;
end;
$$;

revoke all on function public.cast_ballot(text, text, text[], text) from public;
grant execute on function public.cast_ballot(text, text, text[], text) to authenticated;


-- 6. CLÔTURE D'UN TOUR (remplace la version précédente) ------------------------
-- • majorité absolue calculée sur les suffrages exprimés (hors blancs/abstentions)
-- • mode « 2 binômes » : jusqu'à 2 binômes peuvent être élus dans le même tour ;
--   en cas d'égalité pour le dernier siège, les ex æquo ne sont pas élus
--   et repartent au tour suivant

create or replace function public.close_round(p_class text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    c         classes%rowtype;
    v_valid   int;
    v_first   int;     -- n° du premier siège en jeu dans ce tour
    v_done    int;     -- sièges déjà pourvus
    v_slots   int;     -- sièges pourvus au maximum dans ce tour
    v_cids    uuid[];
    v_cvotes  int[];
    v_take    int;
    v_tie     int;
    v_win     jsonb := '[]'::jsonb;
    v_left    int;
    v_snap    jsonb;
    v_finish  boolean;
    v_record  jsonb;
    i         int;
begin
    select * into c from classes where code = p_class for update;

    if not found then
        raise exception 'Classe introuvable.';
    end if;
    if c.owner is distinct from auth.uid() then
        raise exception 'Action non autorisée.' using errcode = '42501';
    end if;
    if c.phase <> 'vote' then
        raise exception 'Le vote n''est pas ouvert.';
    end if;
    if c.cast_votes = 0 then
        raise exception 'Aucun bulletin reçu dans ce tour.';
    end if;

    v_valid := c.cast_votes - c.blank_votes - c.abstentions;

    select count(*) into v_done from pairs where class_code = c.code and seat is not null;
    v_first := v_done + 1;
    v_slots := case when c.double_vote then least(2, c.seats - v_done) else 1 end;

    -- Photo des résultats du tour (archivée)
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 't', t, 'r', r, 'votes', votes)
                              order by votes desc, created_at), '[]'::jsonb)
      into v_snap
      from pairs where class_code = c.code and seat is null;

    -- Binômes ayant la majorité absolue des suffrages exprimés, du meilleur au moins bon
    select array_agg(id    order by votes desc, created_at),
           array_agg(votes order by votes desc, created_at)
      into v_cids, v_cvotes
      from pairs
     where class_code = c.code and seat is null
       and v_valid > 0 and votes * 2 > v_valid;

    if v_cids is not null then
        v_take := least(cardinality(v_cids), v_slots);

        -- Égalité pour le dernier siège : les ex æquo ne sont pas élus
        if cardinality(v_cids) > v_take and v_cvotes[v_take] = v_cvotes[v_take + 1] then
            v_tie := v_cvotes[v_take];
            while v_take > 0 and v_cvotes[v_take] = v_tie loop
                v_take := v_take - 1;
            end loop;
        end if;

        for i in 1..v_take loop
            update pairs set seat = v_done + i where id = v_cids[i];
            v_win := v_win || jsonb_build_array(jsonb_build_object('id', v_cids[i], 'seat', v_done + i));
        end loop;

        v_done := v_done + v_take;
    end if;

    select count(*) into v_left from pairs where class_code = c.code and seat is null;
    v_finish := v_done >= c.seats or v_left = 0;

    v_record := jsonb_build_object(
        'round',   c.round,
        'seat',    v_first,
        'slots',   v_slots,
        'cast',    c.cast_votes,
        'n',       c.n,
        'blank',   c.blank_votes,
        'abstain', c.abstentions,
        'valid',   v_valid,
        'winner',  v_win -> 0 -> 'id',        -- compatibilité avec l'ancien affichage
        'winners', v_win,
        'results', v_snap
    );

    if v_finish then
        -- Élection terminée : on garde les compteurs du dernier tour, résultats publiés
        update classes
           set rounds = rounds || jsonb_build_array(v_record),
               phase  = 'res'
         where code = c.code;
    else
        -- Tour suivant : compteurs remis à zéro, le vote reste ouvert
        update pairs set votes = 0 where class_code = c.code;
        update classes
           set rounds      = rounds || jsonb_build_array(v_record),
               round       = c.round + 1,
               cast_votes  = 0,
               blank_votes = 0,
               abstentions = 0
         where code = c.code;
    end if;

    return jsonb_build_object('won', jsonb_array_length(v_win) > 0,
                              'elected', jsonb_array_length(v_win),
                              'finished', v_finish);
end;
$$;

revoke all on function public.close_round(text) from public;
grant execute on function public.close_round(text) to authenticated;
