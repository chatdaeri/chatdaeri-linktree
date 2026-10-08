# chatdaeri.com 링크트리 프로필 페이지 구축 계획

## 2026-10-08 — 자동화 자료 구매 링크 추가

- [x] 기업교육 사례보기 바로 아래에 `https://shop.chatdaeri.com/`으로 연결되는 '자동화 자료 구매하기' 버튼 추가.
- [x] 기업교육 사례보기와 같은 `.link-card`를 사용해 흰색 배경·버튼 크기·호버·키보드 포커스 효과 재사용. 기존 링크처럼 새 탭으로 열고 `noopener noreferrer` 적용.
- [x] 검증: 아래 명령으로 링크 순서·주소·새 탭 속성·색상 클래스 및 기존 파일 보존 확인 통과. `git diff --check` 통과.
- [x] 작업 브랜치 커밋·푸시 및 main 대상 [PR #1](https://github.com/chatdaeri/chatdaeri-linktree/pull/1) 생성. 병합·운영 배포는 제외.

검증·진행 기록: 쓰기 허용된 작업공간의 별도 복제본에서 `feat/shop-link` 브랜치로 작업했습니다. 원본 저장소는 변경하지 않았습니다. `gh auth status`는 인증이 유효하지 않다고 보고했고, `git ls-remote --heads origin main`은 github.com 이름 해석 실패로 원격 조회가 안 됐습니다. 브랜치 푸시와 PR 생성은 아직 수행하지 못했습니다. 브라우저 연결이 없어 실제 PC·모바일 화면과 호버·키보드 동작도 미확인입니다. 기존 CSS 파일은 바이트 단위로 동일함을 확인했습니다.

2026-10-08 후속 변경: 사용자 요청에 따라 구매 버튼을 기업교육 사례보기와 같은 흰색 스타일로 변경합니다. 뉴스레터의 코랄색과 기존 CSS는 유지합니다. 위의 인증·연결 실패 기록은 최초 작업 당시 상태이며, 이후 PR #1이 생성되었습니다. 같은 PR 브랜치에 이번 변경을 반영합니다.

### 검증 명령

저장소에는 테스트·빌드 명령이 없으므로 Python 표준 라이브러리로 이번 변경만 확인합니다.

```sh
python3 - <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import subprocess

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a' and 'link-card' in attrs.get('class', '').split():
            self.cards.append(attrs)

html = Path('index.html').read_text()
links = Links()
links.feed(html)
assert len(links.cards) == 3
assert links.cards[1]['href'] == 'https://synergylabs.kr/#edu-cases'
shop = links.cards[2]
assert shop['href'] == 'https://shop.chatdaeri.com/'
assert shop['class'] == links.cards[1]['class'] == 'link-card'
assert links.cards[0]['class'] == 'link-card primary'
assert shop['target'] == '_blank'
assert set(shop['rel'].split()) == {'noopener', 'noreferrer'}
addition = '        <a class="link-card" href="https://shop.chatdaeri.com/" target="_blank" rel="noopener noreferrer">자동화 자료 구매하기 <span aria-hidden="true">↗</span></a>\n'
assert html.count(addition) == 1
assert html.replace(addition, '') == subprocess.check_output(['git', 'show', 'main:index.html']).decode()
assert Path('styles.css').read_bytes() == subprocess.check_output(['git', 'show', 'main:styles.css'])
print('링크 순서·URL·새 탭·색상 클래스·기존 HTML/CSS 보존 확인 통과')
PY
git diff --check
```

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
