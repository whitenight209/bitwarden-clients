[![Github Workflow build browser on main](https://github.com/bitwarden/clients/actions/workflows/build-browser.yml/badge.svg?branch=main)](https://github.com/bitwarden/clients/actions/workflows/build-browser.yml?query=branch:main)
[![Crowdin](https://d322cqt584bo4o.cloudfront.net/bitwarden-browser/localized.svg)](https://crowdin.com/project/bitwarden-browser)

# Bitwarden Browser Extension

<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/3C4iKO0.png" width="64" height="64"></a>
<a href="https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/" target="_blank"><img src="https://imgur.com/ihXsdDO.png" width="64" height="64"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/bitwarden-free-password/jbkfoedolllekgbhcbcoahefnbanhhlh" target="_blank"><img src="https://imgur.com/vMcaXaw.png" width="64" height="64"></a>
<a href="https://addons.opera.com/extensions/details/bitwarden-free-password-manager/" target="_blank"><img src="https://imgur.com/nSJ9htU.png" width="64" height="64"></a>
<a href="https://bitwarden.com/download/" target="_blank"><img src="https://imgur.com/ENbaWUu.png" width="64" height="64"></a>
<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/EuDp4vP.png" width="64" height="64"></a>
<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/z8yjLZ2.png" width="64" height="64"></a>
<a href="https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/" target="_blank"><img src="https://imgur.com/MQYBSrD.png" width="64" height="64"></a>

The Bitwarden browser extension is written using the Web Extension API and Angular.

![My Vault](https://raw.githubusercontent.com/bitwarden/brand/main/screenshots/web-browser-extension-generator.png)

## Documentation

커스텀 Chrome 확장 설치 파일은 [최신 GitHub Release](https://github.com/whitenight209/bitwarden-clients/releases/latest)에서 `extension-chrome-custom-VERSION.zip`을 내려받으세요. 압축을 풀고 `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다**에서 `manifest.json`이 있는 폴더를 선택하면 됩니다.

`main`에 확장 관련 변경을 푸시하면 [Custom Chrome Extension CI](https://github.com/whitenight209/bitwarden-clients/actions/workflows/publish-browser-custom.yml)가 자동으로 다음 버전을 빌드·게시합니다. Actions의 **Run workflow**로도 실행할 수 있으며 버전 입력을 비우면 자동으로 정합니다. 실행 결과의 **Artifacts**에서도 설치 ZIP을 받을 수 있습니다.

새 버전은 실제 잠금 해제 완료 시 마지막 성공 확인에서 24시간이 지났으면 조회합니다. 팝업·패널을 여는 것만으로 조회하지 않으며, 새 버전 배너의 **업데이트 보기**를 눌러 설정에 진입한 뒤 **업데이트 적용**을 눌렀을 때만 설치합니다. 업데이트용 주기 타이머나 자동 설치 옵션은 없습니다.

Please refer to the [Browser section](https://contributing.bitwarden.com/getting-started/clients/browser/) of the [Contributing Documentation](https://contributing.bitwarden.com/) for build instructions, recommended tooling, code style tips, and lots of other great information to get you started.

커스텀 Chrome 빌드의 현재 배포 구조와 변경 파일 기반 업데이트 설계는 [GitHub Releases 자동 업데이트 설계](../../docs/browser-extension-github-auto-update.md)를 참고하세요.

설정 ON/OFF에 따라 모든 확장 화면 진입점을 패널로 전환하는 구조는 [사이드 패널 모드 설계](../../docs/browser-extension-side-panel-mode.md)를 참고하세요.

CI 실행과 다운로드, 최초 설치와 자동 테스트 명령, 직접 실행할 E2E 시나리오는 [커스텀 기능 구현·테스트 가이드](../../docs/browser-extension-custom-features-testing.md)에 있습니다.
