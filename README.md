# ai-blog-automation-snippets

AI로 블로그 글을 만들어 예약 발행하는 Electron 데스크톱 앱을 만들면서 쓴 코드 중, 블로그 연재 **「AI 블로그 자동화 삽질기」** 에서 다룬 부분만 추려 놓은 저장소입니다.

- 블로그: https://jujupapa.tistory.com (카테고리: 개발 삽질기)
- 연재는 2026년 11월부터 2027년 1월까지 20편이 차례로 올라갑니다.

## 들어 있는 것

| 파일 | 내용 | 관련 글 |
|---|---|---|
| `src/llm.ts` | Claude → Gemini → OpenAI 순서로 넘어가는 LLM 폴백. 호출부는 OpenAI SDK 모양 그대로 쓰고, 실패를 계정·쿼터·일시 오류로 나눠 넘길지 정한다. Gemini 호환 엔드포인트의 배열 오류 응답을 풀어 주는 `geminiFetch` 포함 | 1~3편, 5편 |
| `src/thumbnail.ts` | Electron 숨은 창에서 HTML을 그려 1200x630 PNG 썸네일로 캡처. `data:` URL 대신 임시 파일을 쓰고 창 하나를 재사용한다 | 9편 |
| `boot.bat` | 더블클릭 한 번으로 Node 버전을 맞추고, 필요할 때만 `npm install`을 돌리고, 앱을 띄우는 배치 파일. `ELECTRON_RUN_AS_NODE` 제거 포함 | 10~11편 |
| `src/github-image-upload.ts` | GitHub Contents API로 이미지 한 장을 공개 저장소에 올리고 주소를 받는다 | 16편 |
| `src/blogger-api.ts` | Blogger API v3로 글 올리기 (refresh token → access token) | 16편 |
| `src/telegram.ts` | grammY 텔레그램 봇. chat_id 자동 등록, 등록된 사용자만 명령 실행, 시작 실패와 처리 중 오류를 잡는 부분 | 19~20편 |

## 읽기 전에

- **이 저장소만으로는 실행되지 않습니다.** 앱에서 발췌한 파일이라 `./secrets`, `./settings`, `./notify` 같은 앱 내부 모듈을 가져옵니다. 각자의 프로젝트에 맞게 그 부분만 바꿔 끼우면 됩니다.
  - `getSecret(name)` : 저장된 API 키·토큰을 돌려주는 함수
  - `getSettings()` / `setSettings()` : 모델 이름, 저장소 이름 같은 설정값
  - `notify(title, body)` : 데스크톱 알림
- 키와 토큰은 코드에 들어 있지 않습니다. 직접 발급해 넣어야 합니다.
- 글 생성 프롬프트, 설정 화면, 그 밖의 발행 모듈은 넣지 않았습니다.
- 환경: Windows, Node 20 이상, Electron 32, TypeScript.

## 라이선스

아직 정하지 않았습니다. 정해지면 이 저장소에 추가합니다.
