-- 기후 횡단 순위표 설정
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여 넣고 Run을 한 번 누르세요.

-- 1) 기록 표: 판마다 한 줄씩 쌓여요.
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  nickname    text        not null check (char_length(btrim(nickname)) between 1 and 12),
  mode        text        not null check (mode in ('full','af','aw','bw','bs','cs','cfb','df','et')),
  score       integer     not null check (score between 1 and 300000),
  created_at  timestamptz not null default now()
);

-- 2) 보안 규칙: 누구나 읽고 새 기록을 올릴 수만 있어요.
--    고치기·지우기 규칙은 만들지 않았으므로 방문자는 다른 사람 기록을 바꿀 수 없어요.
--    (관리자는 대시보드 Table Editor에서 직접 지울 수 있어요.)
alter table public.scores enable row level security;

drop policy if exists "anyone can read scores" on public.scores;
create policy "anyone can read scores" on public.scores
  for select to anon, authenticated using (true);

drop policy if exists "anyone can add a score" on public.scores;
create policy "anyone can add a score" on public.scores
  for insert to anon, authenticated
  with check (char_length(btrim(nickname)) between 1 and 12 and score between 1 and 300000);

grant select, insert on public.scores to anon, authenticated;

-- 3) 순위표 보기: 코스마다 같은 닉네임은 가장 높은 기록 하나만 보여요.
create or replace view public.leaderboard
with (security_invoker = on) as
select distinct on (mode, lower(btrim(nickname)))
  mode, btrim(nickname) as nickname, score, created_at
from public.scores
order by mode, lower(btrim(nickname)), score desc, created_at asc;

grant select on public.leaderboard to anon, authenticated;

-- 4) 순위표를 빨리 불러오기 위한 색인
create index if not exists scores_mode_score_idx on public.scores (mode, score desc);
