-- ============================================================
-- migration_v6.sql — à exécuter UNE FOIS dans le SQL Editor de Supabase
-- Ajoute la fonction purge_dossier : clôture de l'élection
-- (suppression définitive des actes de candidature et du procès-verbal).
-- Non destructif : aucune table ni donnée existante n'est touchée.
-- Peut être relancé sans erreur.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_dossier(p_class text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    c classes%rowtype;
begin
    select * into c from classes where code = p_class for update;

    if not found then
        raise exception 'Classe introuvable.';
    end if;
    if c.owner is distinct from auth.uid() or not public.is_teacher() then
        raise exception 'Action non autorisée.' using errcode = '42501';
    end if;
    if c.phase <> 'res' then
        raise exception 'Publie d''abord les résultats pour pouvoir clôturer.';
    end if;

    -- Actes de candidature et procès-verbal : suppression définitive
    delete from candidacy_forms where class_code = c.code;
    delete from minutes         where class_code = c.code;
end;
$$;

REVOKE ALL ON FUNCTION public.purge_dossier(p_class text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_dossier(p_class text) TO anon;
GRANT ALL ON FUNCTION public.purge_dossier(p_class text) TO authenticated;
GRANT ALL ON FUNCTION public.purge_dossier(p_class text) TO service_role;
