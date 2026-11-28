# Chrome 확장 E2E 환경

macOS에서는 전용 Colima VM, Linux에서는 Docker 엔진 안에서 같은 Chrome for Testing 이미지를 실행한다. Xvfb와 Openbox가 화면을 제공하므로 물리 모니터는 필요 없다.

## 실행

Node 24, Docker CLI를 준비한다. macOS에서는 Colima도 설치한다. 확장 빌드 후 다음 명령을 실행한다.

```sh
npm run build:prod:chrome --workspace @bitwarden/browser
node e2e/infra/chrome/run.mjs
```

다른 빌드 폴더를 검증하려면 `--extension /절대/경로`를 지정한다. 개인 Chrome 프로필은 사용하지 않는다.

잠금 화면 패널이 이미 열려 있고 아직 웹 잠금해제 요청은 없는 경우도 별도로 실행한다.

```sh
node e2e/infra/chrome/run.mjs --preopen-panel
```

기본 실행은 닫힌 패널에서 웹 버튼으로 시작한다. `--preopen-panel`은 준비 단계에서 실제 툴바 동작으로 잠금 패널을 먼저 열고 같은 웹 버튼을 검증한다. 두 경우 모두 요청을 반복한 뒤 같은 창의 새 잠금 패널 하나와 빈 비밀번호 입력란, OS 키 입력을 확인한다. 이미 열린 잠금 화면은 완전히 종료한 뒤 다시 열어 Chrome의 키보드 포커스를 받는다. 입력 중이던 비밀번호는 초기화하며 복사하거나 저장하지 않는다.

실행별 테스트 프로필에 개발자 모드를 켜고 Chrome 시작 시 확장 폴더를 로드한다. 수동 설치의 개발자 모드 조건을 재현한다. 개발자 모드가 없으면 Chrome은 계정 잠금 중 `runtime.reload()` 뒤 확장을 `unsupportedDeveloperExtension` 사유로 비활성화할 수 있다.

환경 기능만 검사하는 명령은 다음과 같다.

```sh
node e2e/infra/chrome/run.mjs --suite environment
```

Linux CI에서는 Colima 없이 같은 테스트를 실행한다.

```sh
node e2e/infra/chrome/run.mjs --provider docker
```

## 1. 환경 확인

- Colima·Docker CLI와 확장 Manifest를 확인한다.
- macOS에서는 `bitwarden-e2e` 전용 VM을 확인하거나 기동한다. 기본 자원은 ARM64, CPU 2개, RAM 4GiB다.
- 모든 Docker 명령은 `colima-bitwarden-e2e` 컨텍스트를 명시한다. 현재 Docker 컨텍스트를 전환하지 않는다.
- 실행별 컨테이너와 볼륨을 생성하고 확장 파일을 복사한다. 원본 빌드 폴더는 변경하지 않는다.

이미 실행 중이던 VM은 종료하지 않는다. 실행기가 시작한 VM은 종료 시 정지한다. 디버깅 목적으로 VM을 유지하려면 `--keep-vm`을 지정한다.

## 2. 실제 브라우저 E2E

기본 `authenticated` 스위트는 임시 Vaultwarden 서버와 무작위 계정을 생성한다. 서버는 브라우저 컨테이너와 네트워크를 공유하며, 브라우저의 `https://localhost:8080`에서만 사용한다. 호스트에 서버 포트를 공개하지 않는다. 실행마다 임시 TLS 인증서를 생성하고 Node에는 해당 인증서를, Chrome에는 해당 공개 키 핀만 신뢰하도록 전달한다. 인증서 검증 전체를 끄지 않는다.

계정 준비에는 Vaultwarden 등록 API와 공식 Bitwarden SDK의 암호화 함수를 사용한다. 고정한 Vaultwarden이 지원하는 V1 계정 키 형식으로 등록하며, 가입 웹 화면 자체는 테스트하지 않는다. 등록 API 성공 이후 실제 확장 로그인과 잠금 해제로 계정의 유효성을 확인한다.

검증 대상은 실제 확장 로그인, 설정에서 사이드 패널 활성화, 계정 잠금, 웹 입력 필드의 실제 잠금 해제 버튼, 네이티브 `SIDE_PANEL`의 마스터 비밀번호 입력 포커스, OS 키 입력과 실제 잠금 해제다. 잠금 해제 버튼을 누른 뒤에는 패널 클릭·`focus()`·창 활성화로 포커스를 보정하지 않는다.

계정 잠금은 보안을 위해 확장 프로세스를 재시작한다. 잠금 화면 표시와 재시작 완료를 구분하고 실제 worker 교체를 확인한다. Worker 진단에는 직접 CDP 요청과 제한 시간을 사용하며, 실패는 추가 진단 전에 먼저 보고서에 저장한다.

`environment` 스위트는 계정 없이 Chrome 실행, OS 키 입력, 실제 네이티브 사이드 패널과 로그인 이메일 입력을 확인한다. 이 결과로 인증·비밀번호 잠금 해제 회귀가 검증됐다고 판단하지 않는다.

Chrome for Testing 158.0.8127.88, Puppeteer-core 25.19.0, Vaultwarden 1.37.5 이미지를 고정한다. Vaultwarden 이미지에는 digest도 지정한다. Linux ARM64와 AMD64를 지원한다.

## 3. 리포트와 정리

성공과 실패 모두 `.debug/chrome-e2e/<실행 ID>/`에 다음 파일을 남긴다.

- `report.html`, `report.json`: 환경 점검·테스트·정리 결과
- `commands.log`: 실행 명령과 로그
- `browser/report.json`: 브라우저 단계별 결과
- `browser/*.png`: 전체 가상 화면 스크린샷
- `server.log`: 임시 서버 로그

최근 실행 위치는 `.debug/chrome-e2e/latest.json`에 기록한다. 생성한 비밀번호를 명령 인자나 리포트에 기록하지 않는다. 비밀번호를 입력 중인 실패 화면은 저장하지 않는다.

보고서를 호스트에 복사한 뒤 실행별 컨테이너·볼륨을 삭제한다. 계정·서버 데이터와 브라우저 프로필도 함께 제거된다. 실행기가 시작한 VM은 정지하고 실행 잠금을 해제한다. 이미지와 빌드 캐시는 재사용한다. 종료 코드 0은 테스트와 정리가 모두 성공했음을 뜻한다.

실패 보고서와 정리 경로를 확인하는 명령은 다음과 같다. 이 명령은 의도적으로 실패하고 종료 코드 1을 반환한다.

```sh
node e2e/infra/chrome/run.mjs --suite environment --force-failure
```

동일 작업 공간에서는 실행 잠금으로 중복 실행을 막는다. SIGINT·SIGTERM은 정리 경로로 처리한다.

유일한 `Chrome Extension Release` 워크플로도 Linux Docker 환경에서 같은 인증 스위트를 실행한다. 패키징한 실제 릴리스 버전으로 테스트하고, E2E가 성공해야 릴리스 파일을 업로드·배포한다. 실패한 실행의 보고서도 `chrome-e2e-<run ID>` 아티팩트에 남긴다.

## 검증 범위

이 환경의 Linux 결과가 macOS의 파일 선택기·접근 제한·영구 권한 동작까지 보장하지는 않는다. 관련 동작은 macOS에서 별도로 검증한다.

실제 Chrome이 `SIDE_PANEL.windowId=-1`을 반환할 수 있다. 환경의 패널 표시·키 입력 성공과 제품의 요청 중계 성공은 별도 검사 대상이며, 진단 정보에 실제 패널의 창 조회 결과를 남긴다.
