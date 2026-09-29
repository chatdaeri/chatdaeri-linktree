# chatdaeri.com 링크트리 프로필 페이지 구축 계획

## 목표
- GitHub 레포에 Linktree 스타일 개인 프로필 페이지 제작
- **Vercel**로 배포
- 기존 GoDaddy 구매 도메인 `chatdaeri.com`을 아임웹(IMWEB)에서 분리하여 Vercel 프로젝트에 연결

## 현재 상태
- GitHub 계정 연결됨 (`chatdaeri` 계정, gh CLI 인증 완료)
- `chatdaeri.com` 도메인은 GoDaddy에서 구매, 현재 네임서버가 아임웹(`ens1~4.hostcocoa.com`)으로 위임되어 아임웹 사이트(`chatdaeri.imweb.me`)에 연결된 상태
- 아직 GitHub 레포 없음 / 프로필 페이지 미제작

## 진행 순서

### 1단계 — GitHub 레포 생성 + 페이지 제작
- [ ] GitHub 레포 생성 (예: `chatdaeri-links`)
- [ ] Linktree 스타일 개인 프로필 페이지 제작 (정적 HTML/CSS, 필요 시 프레임워크)
- [ ] 로컬 커밋 후 GitHub에 push

### 2단계 — Vercel 배포
- [ ] Vercel에 GitHub 레포 연결 (Import Project)
- [ ] 자동 배포 확인 (`*.vercel.app` 임시 URL로 정상 동작 확인)

### 3단계 — 도메인을 GoDaddy 관리로 되돌리기
- [ ] GoDaddy 로그인 → 내 도메인 → `chatdaeri.com` → 네임서버 설정
- [ ] "GoDaddy 기본 네임서버로 변경" 적용 (아임웹 위임 해제)
- [ ] 반영 대기 (수 시간~24시간)

### 4단계 — 아임웹 정리
- [ ] 아임웹 관리자 → 도메인 연결 목록에서 `chatdaeri.com` 제거 (충돌 방지용, 선택이지만 권장)

### 5단계 — Vercel에 도메인 연결
- [ ] Vercel 프로젝트 → Settings → Domains → `chatdaeri.com` 추가 (+ `www.chatdaeri.com`도 추가해 리다이렉트 설정 권장)
- [ ] Vercel이 안내하는 DNS 레코드를 GoDaddy DNS 관리 화면에 등록
  - 일반적으로 apex(`@`)는 A 레코드 `76.76.21.21`, `www`는 CNAME `cname.vercel-dns.com` (Vercel 화면에 표시되는 실제 값 기준으로 등록)
- [ ] 기존 아임웹용 A/CNAME 레코드 삭제

### 6단계 — 검증
- [ ] DNS 전파 확인 (`nslookup chatdaeri.com`, whatsmydns.net)
- [ ] Vercel 대시보드에서 도메인 상태 "Valid Configuration" 확인
- [ ] SSL 인증서 자동 발급 확인 (Vercel이 자동 처리)
- [ ] `https://chatdaeri.com` 정상 접속 확인

## 참고
- Vercel은 apex 도메인 연결이 GitHub Pages보다 매끄럽고(자동 ALIAS 처리), `git push` 시 자동 재배포됨
- 아임웹 SSL/도메인 관련 기존 설정은 이전 완료 후 더 이상 신경 쓸 필요 없음
