-- ============================================================================
-- migration_v6.sql : le professeur peut supprimer les actes de sa classe
-- (utilisé par « Clôturer l'élection »). À exécuter après migration_v5.sql.
-- ============================================================================

drop policy if exists cf_teacher_delete on public.candidacy_forms;
create policy cf_teacher_delete on public.candidacy_forms for delete to authenticated
    using (exists (select 1 from public.classes c where c.code = class_code and c.owner = auth.uid()));
