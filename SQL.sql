-- ============================================================
-- Schéma public — prêt à coller dans le SQL Editor de Supabase
-- (nettoyé : sans \restrict, sans schémas système auth/storage/realtime,
--  sans COPY ... FROM stdin, encodage accents réparé)
-- ATTENTION : la section RESET supprime les tables du projet (elles étaient vides dans ton dump).
-- ============================================================

-- RESET (permet de relancer le script sans erreur)
DROP TABLE IF EXISTS public.round_voters, public.voter_access, public.candidacy_forms,
                     public.minutes, public.pairs, public.classes CASCADE;
DROP FUNCTION IF EXISTS public.cast_ballot(text, text, text[]);
DROP FUNCTION IF EXISTS public.close_round(text);
DROP FUNCTION IF EXISTS public.decide_access(text, uuid, boolean);
DROP FUNCTION IF EXISTS public.has_voted(text);
DROP FUNCTION IF EXISTS public.is_teacher();
DROP FUNCTION IF EXISTS public.request_access(text, text);

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE public.candidacy_forms (
    class_code text NOT NULL,
    owner uuid DEFAULT auth.uid() NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT candidacy_forms_data_check CHECK ((pg_column_size(data) < 20000))
);

CREATE TABLE public.classes (
    code text NOT NULL,
    name text NOT NULL,
    n integer NOT NULL,
    owner uuid DEFAULT auth.uid() NOT NULL,
    phase text DEFAULT 'cand'::text NOT NULL,
    cast_votes integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    round integer DEFAULT 1 NOT NULL,
    seats integer DEFAULT 2 NOT NULL,
    rounds jsonb DEFAULT '[]'::jsonb NOT NULL,
    double_vote boolean DEFAULT false NOT NULL,
    blank_votes integer DEFAULT 0 NOT NULL,
    abstentions integer DEFAULT 0 NOT NULL,
    need_approval boolean DEFAULT false NOT NULL,
    CONSTRAINT classes_code_check CHECK ((code ~ '^[0-9]{6}$'::text)),
    CONSTRAINT classes_n_check CHECK ((n >= 1)),
    CONSTRAINT classes_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 40))),
    CONSTRAINT classes_phase_check CHECK ((phase = ANY (ARRAY['cand'::text, 'vote'::text, 'res'::text])))
);

CREATE TABLE public.minutes (
    class_code text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT minutes_data_check CHECK ((pg_column_size(data) < 20000))
);

CREATE TABLE public.pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    class_code text NOT NULL,
    owner uuid DEFAULT auth.uid() NOT NULL,
    t text NOT NULL,
    r text NOT NULL,
    prog text DEFAULT ''::text NOT NULL,
    votes integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    seat integer,
    CONSTRAINT pairs_prog_check CHECK ((char_length(prog) <= 400)),
    CONSTRAINT pairs_r_check CHECK (((char_length(r) >= 1) AND (char_length(r) <= 40))),
    CONSTRAINT pairs_t_check CHECK (((char_length(t) >= 1) AND (char_length(t) <= 40)))
);

CREATE TABLE public.round_voters (
    class_code text NOT NULL,
    round integer NOT NULL,
    voter_id uuid NOT NULL
);

CREATE TABLE public.voter_access (
    class_code text NOT NULL,
    voter_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    pseudo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voter_access_pseudo_check CHECK (((pseudo IS NULL) OR ((char_length(pseudo) >= 1) AND (char_length(pseudo) <= 40)))),
    CONSTRAINT voter_access_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'refused'::text])))
);


-- ============================================================
-- CLÉS PRIMAIRES / UNIQUE
-- ============================================================

ALTER TABLE ONLY public.candidacy_forms
    ADD CONSTRAINT candidacy_forms_pkey PRIMARY KEY (class_code, owner);

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (code);

ALTER TABLE ONLY public.minutes
    ADD CONSTRAINT minutes_pkey PRIMARY KEY (class_code);

ALTER TABLE ONLY public.pairs
    ADD CONSTRAINT pairs_class_code_owner_key UNIQUE (class_code, owner);

ALTER TABLE ONLY public.pairs
    ADD CONSTRAINT pairs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.round_voters
    ADD CONSTRAINT round_voters_pkey PRIMARY KEY (class_code, round, voter_id);

ALTER TABLE ONLY public.voter_access
    ADD CONSTRAINT voter_access_pkey PRIMARY KEY (class_code, voter_id);


-- ============================================================
-- CLÉS ÉTRANGÈRES
-- ============================================================

ALTER TABLE ONLY public.candidacy_forms
    ADD CONSTRAINT candidacy_forms_class_code_fkey FOREIGN KEY (class_code) REFERENCES public.classes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_owner_fkey FOREIGN KEY (owner) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.minutes
    ADD CONSTRAINT minutes_class_code_fkey FOREIGN KEY (class_code) REFERENCES public.classes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.pairs
    ADD CONSTRAINT pairs_class_code_fkey FOREIGN KEY (class_code) REFERENCES public.classes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.pairs
    ADD CONSTRAINT pairs_owner_fkey FOREIGN KEY (owner) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.round_voters
    ADD CONSTRAINT round_voters_class_code_fkey FOREIGN KEY (class_code) REFERENCES public.classes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.round_voters
    ADD CONSTRAINT round_voters_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voter_access
    ADD CONSTRAINT voter_access_class_code_fkey FOREIGN KEY (class_code) REFERENCES public.classes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.voter_access
    ADD CONSTRAINT voter_access_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES auth.users(id) ON DELETE CASCADE;


-- ============================================================
-- FONCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION public.cast_ballot(p_class text, p_kind text, p_pairs text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

declare

    v_uid     uuid := auth.uid();

    v_cls     classes%rowtype;

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



    -- L'élève doit avoir été validé par le professeur

    if v_cls.need_approval and not exists (

        select 1 from voter_access

         where class_code = v_cls.code and voter_id = v_uid and status = 'approved') then

        raise exception 'Ton accès au vote n''a pas été validé par le professeur.' using errcode = '42501';

    end if;



    -- Combien de binômes AU MAXIMUM sur ce bulletin ? 1, ou 2 si l'option est activée

    -- (et s'il reste au moins 2 sièges et 2 binômes en lice). L'élève en choisit

    -- de 1 jusqu'à ce maximum : prendre le 2e binôme est facultatif.

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



        if coalesce(cardinality(p_pairs), 0) < 1

           or cardinality(p_pairs) > v_picks

           or coalesce(cardinality(v_ids), 0) <> cardinality(p_pairs) then

            raise exception 'Choisis entre 1 et % binôme(s), tous différents.', v_picks;

        end if;



        select count(*) into v_ok

          from pairs

         where id = any(v_ids) and class_code = v_cls.code and seat is null;



        if v_ok <> cardinality(v_ids) then

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

CREATE OR REPLACE FUNCTION public.close_round(p_class text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

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

CREATE OR REPLACE FUNCTION public.decide_access(p_class text, p_voter uuid, p_approve boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

declare

    c classes%rowtype;

begin

    -- Verrou : le plafond « autant de validés que d'élèves » reste exact

    select * into c from classes where code = p_class for update;



    if not found then

        raise exception 'Classe introuvable.';

    end if;

    if c.owner is distinct from auth.uid() or not public.is_teacher() then

        raise exception 'Action non autorisée.' using errcode = '42501';

    end if;



    if p_approve then

        if (select count(*) from voter_access

             where class_code = c.code and status = 'approved') >= c.n then

            raise exception 'Il y a déjà % élèves validés (= le nombre d''élèves de la classe).', c.n;

        end if;



        update voter_access

           set status = 'approved', pseudo = null          -- le pseudo est effacé ici

         where class_code = c.code and voter_id = p_voter and status = 'pending';

    else

        -- Refuse une demande, ou retire l'accès d'un élève validé par erreur

        update voter_access

           set status = 'refused', pseudo = null

         where class_code = c.code and voter_id = p_voter and status in ('pending', 'approved');

    end if;



    if not found then

        raise exception 'Demande introuvable ou déjà traitée.';

    end if;

end;

$$;

CREATE OR REPLACE FUNCTION public.has_voted(p_class text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

    select exists (

        select 1

        from round_voters rv

        join classes c on c.code = rv.class_code and c.round = rv.round

        where rv.class_code = p_class

          and rv.voter_id   = auth.uid()

    );

$$;

CREATE OR REPLACE FUNCTION public.is_teacher() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$

    select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false

$$;

CREATE OR REPLACE FUNCTION public.request_access(p_class text, p_pseudo text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

declare

    v_uid    uuid := auth.uid();

    c        classes%rowtype;

    v_pseudo text := btrim(coalesce(p_pseudo, ''));

    v_status text;

begin

    if v_uid is null then

        raise exception 'Session requise.' using errcode = '42501';

    end if;

    if char_length(v_pseudo) not between 1 and 40 then

        raise exception 'Indique un prénom ou un pseudo (40 caractères max).';

    end if;



    select * into c from classes where code = p_class;



    if not found then

        raise exception 'Classe introuvable.';

    end if;

    if not c.need_approval then

        raise exception 'Cette élection n''exige pas de validation.';

    end if;

    if c.phase = 'res' then

        raise exception 'L''élection est terminée.';

    end if;



    -- Anti-spam : pas plus de demandes en attente que 2 × la classe

    if (select count(*) from voter_access

         where class_code = c.code and status = 'pending') >= greatest(c.n * 2, 20) then

        raise exception 'Trop de demandes en attente : préviens ton professeur.';

    end if;



    -- Nouvelle demande, ou nouvelle tentative après un refus (jamais écrasé si déjà validé)

    insert into voter_access (class_code, voter_id, status, pseudo)

    values (c.code, v_uid, 'pending', v_pseudo)

    on conflict (class_code, voter_id) do update

        set status = 'pending', pseudo = excluded.pseudo

        where voter_access.status <> 'approved';



    select status into v_status from voter_access

     where class_code = c.code and voter_id = v_uid;



    return v_status;

end;

$$;


-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.candidacy_forms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.minutes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pairs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.round_voters ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.voter_access ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- POLICIES
-- ============================================================

CREATE POLICY cf_delete ON public.candidacy_forms FOR DELETE TO authenticated USING ((owner = auth.uid()));

CREATE POLICY cf_insert ON public.candidacy_forms FOR INSERT TO authenticated WITH CHECK (((owner = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = candidacy_forms.class_code) AND (c.phase = 'cand'::text))))));

CREATE POLICY cf_teacher_delete ON public.candidacy_forms FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = candidacy_forms.class_code) AND (c.owner = auth.uid())))));

CREATE POLICY cf_teacher_read ON public.candidacy_forms FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = candidacy_forms.class_code) AND (c.owner = auth.uid())))));

CREATE POLICY classes_delete ON public.classes FOR DELETE USING (((owner = auth.uid()) AND public.is_teacher()));

CREATE POLICY classes_insert ON public.classes FOR INSERT WITH CHECK (((owner = auth.uid()) AND public.is_teacher() AND (NOT (EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.owner = auth.uid()) AND (c.phase <> 'res'::text)))))));

CREATE POLICY classes_read ON public.classes FOR SELECT USING (true);

CREATE POLICY classes_update ON public.classes FOR UPDATE USING (((owner = auth.uid()) AND public.is_teacher())) WITH CHECK (((owner = auth.uid()) AND public.is_teacher()));

CREATE POLICY minutes_owner ON public.minutes TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = minutes.class_code) AND (c.owner = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = minutes.class_code) AND (c.owner = auth.uid())))));

CREATE POLICY pairs_delete ON public.pairs FOR DELETE USING (((owner = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = pairs.class_code) AND (c.phase = 'cand'::text))))));

CREATE POLICY pairs_insert ON public.pairs FOR INSERT WITH CHECK (((owner = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = pairs.class_code) AND (c.phase = 'cand'::text))))));

CREATE POLICY pairs_read ON public.pairs FOR SELECT USING (true);

CREATE POLICY voter_access_read ON public.voter_access FOR SELECT USING (((voter_id = auth.uid()) OR (public.is_teacher() AND (EXISTS ( SELECT 1
   FROM public.classes c
  WHERE ((c.code = voter_access.class_code) AND (c.owner = auth.uid())))))));


-- ============================================================
-- REALTIME
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='classes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.classes;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='pairs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pairs;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='voter_access') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.voter_access;
  END IF;
END $$;


-- ============================================================
-- DROITS (GRANT / REVOKE)
-- ============================================================

REVOKE ALL ON FUNCTION public.cast_ballot(p_class text, p_kind text, p_pairs text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cast_ballot(p_class text, p_kind text, p_pairs text[]) TO anon;
GRANT ALL ON FUNCTION public.cast_ballot(p_class text, p_kind text, p_pairs text[]) TO authenticated;
GRANT ALL ON FUNCTION public.cast_ballot(p_class text, p_kind text, p_pairs text[]) TO service_role;

REVOKE ALL ON FUNCTION public.close_round(p_class text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_round(p_class text) TO anon;
GRANT ALL ON FUNCTION public.close_round(p_class text) TO authenticated;
GRANT ALL ON FUNCTION public.close_round(p_class text) TO service_role;

REVOKE ALL ON FUNCTION public.decide_access(p_class text, p_voter uuid, p_approve boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.decide_access(p_class text, p_voter uuid, p_approve boolean) TO anon;
GRANT ALL ON FUNCTION public.decide_access(p_class text, p_voter uuid, p_approve boolean) TO authenticated;
GRANT ALL ON FUNCTION public.decide_access(p_class text, p_voter uuid, p_approve boolean) TO service_role;

REVOKE ALL ON FUNCTION public.has_voted(p_class text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_voted(p_class text) TO anon;
GRANT ALL ON FUNCTION public.has_voted(p_class text) TO authenticated;
GRANT ALL ON FUNCTION public.has_voted(p_class text) TO service_role;

GRANT ALL ON FUNCTION public.is_teacher() TO anon;
GRANT ALL ON FUNCTION public.is_teacher() TO authenticated;
GRANT ALL ON FUNCTION public.is_teacher() TO service_role;

REVOKE ALL ON FUNCTION public.request_access(p_class text, p_pseudo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_access(p_class text, p_pseudo text) TO anon;
GRANT ALL ON FUNCTION public.request_access(p_class text, p_pseudo text) TO authenticated;
GRANT ALL ON FUNCTION public.request_access(p_class text, p_pseudo text) TO service_role;

GRANT ALL ON TABLE public.candidacy_forms TO authenticated;
GRANT ALL ON TABLE public.candidacy_forms TO service_role;

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.classes TO anon;
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.classes TO authenticated;
GRANT ALL ON TABLE public.classes TO service_role;

GRANT INSERT(code) ON TABLE public.classes TO authenticated;

GRANT INSERT(name) ON TABLE public.classes TO authenticated;

GRANT INSERT(n) ON TABLE public.classes TO authenticated;

GRANT UPDATE(phase) ON TABLE public.classes TO authenticated;

GRANT INSERT(double_vote) ON TABLE public.classes TO authenticated;

GRANT INSERT(need_approval) ON TABLE public.classes TO authenticated;

GRANT ALL ON TABLE public.minutes TO authenticated;
GRANT ALL ON TABLE public.minutes TO service_role;

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.pairs TO anon;
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.pairs TO authenticated;
GRANT ALL ON TABLE public.pairs TO service_role;

GRANT INSERT(class_code) ON TABLE public.pairs TO authenticated;

GRANT INSERT(t) ON TABLE public.pairs TO authenticated;

GRANT INSERT(r) ON TABLE public.pairs TO authenticated;

GRANT INSERT(prog) ON TABLE public.pairs TO authenticated;

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.round_voters TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.round_voters TO authenticated;
GRANT ALL ON TABLE public.round_voters TO service_role;

GRANT ALL ON TABLE public.voter_access TO service_role;
GRANT SELECT ON TABLE public.voter_access TO authenticated;
