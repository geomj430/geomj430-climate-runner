# 기후 러너 · 웹게임 배포 안내

열대우림에서 툰드라까지 쾨펜 기후 8곳을 달리는 횡스크롤 기후 게임이에요.
누구나 주소만 알면 로그인 없이 할 수 있고, 판이 끝나면 닉네임으로 공용 순위표에 기록을 올려요.

## 파일

| 파일 | 하는 일 |
|---|---|
| `climate-runner.html` | **독립 실행 파일**: 이 파일 하나만 있으면 인터넷 없이 더블클릭으로 실행돼요 (글꼴 포함) |
| `index.html` | 웹사이트용 게임 파일 |
| `supabase-setup.sql` | 순위표 데이터베이스를 만드는 설정 (Supabase에서 한 번만 실행) |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | 휴대폰 홈 화면에 추가했을 때 가로 전체 화면으로 열리게 하는 설정과 앱 아이콘 |

## 독립 실행 파일로 쓰기 (가장 간단해요)

- `climate-runner.html`을 USB나 메신저로 나눠 주고 더블클릭하면 브라우저에서 바로 실행돼요. 인터넷이 없어도 돼요.
- 인터넷 순위표를 연결하지 않으면 **이 기기 순위표**로 동작해요. 같은 컴퓨터(같은 브라우저)에서 한 사람들의 기록끼리 겨뤄요.
- 이 파일에도 아래 1단계의 Supabase 정보를 넣으면 인터넷이 될 때 공용 순위표에 기록이 올라가요.
- 크롬, 엣지, 웨일, 사파리 최신 버전에서 실행돼요.

## 1단계 · 순위표 만들기 (Supabase, 무료)

1. https://supabase.com 에 가입하고 **New project**를 만들어요. 지역은 `Northeast Asia (Seoul)`이 빨라요.
2. 왼쪽 메뉴 **SQL Editor → New query**에 `supabase-setup.sql` 내용을 전부 붙여 넣고 **Run**을 눌러요.
3. **Project Settings → API**(또는 **API Keys**)에서 두 가지를 복사해요.
   - **Project URL** (예: `https://abcdxyz.supabase.co`)
   - **anon public** 키 또는 **publishable** 키
4. `index.html`에서 `const SUPABASE_URL = '';`와 `const SUPABASE_KEY = '';`를 찾아 따옴표 안에 붙여 넣어요.

> anon(publishable) 키는 원래 웹페이지에 공개되는 키라서 넣어도 괜찮아요.
> **service_role(secret) 키는 절대 넣거나 남에게 보내지 마세요.**

## 2단계 · 웹에 올리기 (GitHub Pages, 무료)

1. https://github.com 에 가입하고 오른쪽 위 **+ → New repository**를 눌러요. 이름은 예를 들어 `climate-run`, 공개 범위는 **Public**으로 해요.
2. 저장소 화면에서 **Add file → Upload files**로 `index.html`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` 네 파일을 함께 올리고 **Commit changes**를 눌러요.
3. **Settings → Pages**에서 Source를 **Deploy from a branch**, Branch를 **main / (root)**로 정하고 **Save**를 눌러요.
4. 1~2분 뒤 `https://<GitHub 아이디>.github.io/climate-run/` 주소로 게임이 열려요. 이 주소를 학생들에게 나눠 주면 돼요.

## 운영하면서

- **부적절한 닉네임이나 이상한 기록 지우기**: Supabase **Table Editor → scores**에서 그 줄을 골라 삭제해요.
- **순위표 초기화**: SQL Editor에서 `truncate public.scores;`를 실행해요.
- **알아 둘 점**
  - 점수는 각자의 브라우저에서 계산돼요. 마음먹으면 가짜 점수를 보낼 수도 있어요. 데이터베이스에서 점수 범위(최대 300,000점)와 닉네임 길이는 검사하지만, 완전히 막을 수는 없어요. 상을 주는 대회라면 상위 기록은 직접 확인해 주세요.
  - Supabase 무료 프로젝트는 일주일 넘게 아무도 쓰지 않으면 일시 정지될 수 있어요. 대시보드에서 **Restore**를 누르면 다시 켜져요.
  - 기후 도감 카드와 닉네임은 각자의 브라우저에만 저장돼요.

## 휴대폰에서 가로 화면으로

- 안드로이드 크롬에서는 게임을 시작하면 전체 화면으로 바뀌고 가로로 고정돼요.
- 아이폰 사파리처럼 웹페이지의 방향 고정을 막는 브라우저에서는, 세로로 들면 "휴대폰을 가로로 돌려 주세요" 안내가 뜨고 게임이 잠시 멈춰요.
- 브라우저 메뉴의 **홈 화면에 추가**로 설치하면 안드로이드에서는 처음부터 가로 전체 화면 앱처럼 열려요.
