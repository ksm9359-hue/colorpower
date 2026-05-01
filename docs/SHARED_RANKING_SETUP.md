# Shared Ranking Setup (Supabase)

이 프로젝트는 기본적으로 로컬 랭킹으로 동작하며, 아래 설정을 하면 외부 공유 랭킹으로 자동 전환됩니다.

## 1) Supabase 프로젝트 생성

1. Supabase에서 새 프로젝트 생성
2. `Project Settings -> API`에서 아래 값 확인
   - `Project URL`
   - `anon public key`

## 2) 테이블 생성

SQL Editor에서 아래를 실행하세요:

```sql
create table if not exists public.scores (
  name text primary key,
  score integer not null default 0 check (score >= 0 and score <= 50000),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_scores_updated_at on public.scores;
create trigger trg_scores_updated_at
before update on public.scores
for each row execute function public.set_updated_at();
```

## 3) RLS 정책

간단 테스트를 위해 다음 정책을 사용합니다.

```sql
alter table public.scores enable row level security;

create policy "scores_select_all"
on public.scores
for select
to anon
using (true);

create policy "scores_insert_all"
on public.scores
for insert
to anon
with check (true);

create policy "scores_update_all"
on public.scores
for update
to anon
using (true)
with check (true);
```

## 3-1) 권장 보안 강화 (최고점만 갱신)

아래 SQL을 추가로 적용하면 DB 레벨에서 점수 하향 갱신을 막을 수 있습니다.

```sql
create or replace function public.keep_best_score()
returns trigger as $$
begin
  if NEW.score < OLD.score then
    NEW.score = OLD.score;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_scores_keep_best on public.scores;
create trigger trg_scores_keep_best
before update on public.scores
for each row execute function public.keep_best_score();
```

## 4) 로컬 환경변수 설정

프로젝트 루트에 `.env.local` 파일 생성:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_PUBLIC_KEY
```

`npm.cmd run dev` 재시작 후 준비 화면에서 공유 랭킹이 보이면 완료입니다.

## 참고

- 환경변수가 없거나 Supabase 요청 실패 시 로컬 랭킹으로 자동 폴백됩니다.
- 동일 이름은 최고 점수만 유지됩니다.
- 클라이언트에서도 제출 쿨다운(2.5초)과 점수 범위(0~50000) 가드가 적용됩니다.
