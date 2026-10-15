-- ============================================================================
-- migration_v5.sql : actes de candidature + procès-verbal
-- À exécuter UNE FOIS dans Supabase → SQL Editor.
-- Les deux tables sont lisibles uniquement par le professeur propriétaire de la classe.
-- ============================================================================

-- 1. Actes de candidature (un par candidat, écrit par l'élève, lu par le professeur)
create table if not exists public.candidacy_forms (
    class_code text        not null references public.classes(code) on delete cascade,
    owner      uuid        not null default auth.uid(),
    data       jsonb       not null check (pg_column_size(data) < 20000),
    created_at timestamptz not null default now(),
    primary key (class_code, owner)
);

alter table public.candidacy_forms enable row level security;

drop policy if exists cf_insert on public.candidacy_forms;
create policy cf_insert on public.candidacy_forms for insert to authenticated
    with check (
        owner = auth.uid()
        and exists (select 1 from public.classes c where c.code = class_code and c.phase = 'cand')
    );

drop policy if exists cf_delete on public.candidacy_forms;
create policy cf_delete on public.candidacy_forms for delete to authenticated
    using (owner = auth.uid());

drop policy if exists cf_teacher_read on public.candidacy_forms;
create policy cf_teacher_read on public.candidacy_forms for select to authenticated
    using (exists (select 1 from public.classes c where c.code = class_code and c.owner = auth.uid()));

-- 2. Procès-verbal (un par classe, géré uniquement par le professeur)
create table if not exists public.minutes (
    class_code text primary key references public.classes(code) on delete cascade,
    data       jsonb       not null check (pg_column_size(data) < 20000),
    updated_at timestamptz not null default now()
);

alter table public.minutes enable row level security;

drop policy if exists minutes_owner on public.minutes;
create policy minutes_owner on public.minutes for all to authenticated
    using      (exists (select 1 from public.classes c where c.code = class_code and c.owner = auth.uid()))
    with check (exists (select 1 from public.classes c where c.code = class_code and c.owner = auth.uid()));

revoke all on public.candidacy_forms, public.minutes from anon;
grant select, insert, delete on public.candidacy_forms to authenticated;
grant select, insert, update, delete on public.minutes to authenticated;
