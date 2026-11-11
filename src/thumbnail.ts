/**
 * 제목 카드 썸네일(1200x630) 생성.
 *
 * 기존 파이썬 구현(make_thumbnail.py)은 PIL로 픽셀을 직접 그렸다.
 * Node에는 마땅한 대안이 없다 — node-canvas는 윈도우 네이티브 빌드가 고통스럽고,
 * sharp는 SVG 렌더링에 별도 폰트 설정이 필요해 한글이 깨지기 쉽다.
 *
 * 그런데 Electron에는 크로미움이 통째로 들어있다. HTML로 그려서 캡처하면
 * 네이티브 의존성 0개 + 시스템 한글 폰트 그대로 사용 + 디자인 수정이 CSS로 끝난다.
 *
 * 색상/여백/폰트 크기는 make_thumbnail.py의 값을 그대로 옮긴 것.
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'

const W = 1200
const H = 630

// 배색: 민트 화이트 (2026-07-23 변경).
// 기존 짙은 네이비(#182030)는 모바일 피드에서 무겁고 어두워 보여 밝은 톤으로 교체했다.
// 티스토리·Blogger 공통 — 두 블로그의 썸네일 브랜드를 하나로 유지한다.
const BG = '#f7fbfa' // 거의 흰색에 가까운 민트 화이트
const ACCENT = '#12b886' // 민트그린 포인트 (좌측 바 + 라벨)
const TITLE_COLOR = '#12303a' // 짙은 청록 — 밝은 배경에서 대비 확보
const SUB_COLOR = '#6b8f89' // 흐린 청록 (푸터)
// 밝은 썸네일은 흰 배경 블로그에서 경계가 사라진다 → 둥근 테두리 카드로 만든다.
// 모서리 바깥은 투명(alpha)이라 어떤 배경색 위에서도 둥글게 보인다.
const BORDER_COLOR = '#cfe8e0' // 연한 민트 테두리
const RADIUS = 28 // 모서리 반경(px)
const BORDER_W = 2

/** 생성 카테고리 → 썸네일에 찍을 라벨 (make_thumbnail.py의 CATEGORY_LABEL) */
export const CATEGORY_LABEL: Record<string, string> = {
  dev_tutorial: '개발 튜토리얼',
  it_trend: '기술 해설',
  dev_tool: '개발 툴',
  save_money: '절약 정보',
  life_tool: '생활 도구',
  life_health: '건강 관리',
  life_product: '상품 추천',
  life_guide: '신청 가이드',
  life_versus: '비교 가이드',
  life_checklist: '체크리스트'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface ThumbnailInput {
  title: string
  /** 좌측 상단 카테고리 라벨 */
  label: string
  /** 하단 블로그 주소 */
  footer: string
}

function buildHtml({ title, label, footer }: ThumbnailInput): string {
  // 제목이 길면 글자를 줄인다 (파이썬: 30자 이하 76px, 초과 62px)
  const titleSize = title.length <= 30 ? 76 : 62

  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  /* 배경 투명 — 카드 바깥(둥근 모서리)이 비쳐서 어떤 블로그 배경에도 자연스럽게 얹힌다 */
  body { background: transparent; }
  .card {
    position: absolute; inset: 0;
    background: ${BG};
    border: ${BORDER_W}px solid ${BORDER_COLOR};
    border-radius: ${RADIUS}px;
    overflow: hidden;
    font-family: 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', sans-serif;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 80px;
  }
  /* 왼쪽 포인트 바 (카드 overflow:hidden이 모서리에 맞춰 잘라준다) */
  .bar { position: absolute; left: 0; top: 0; width: 14px; height: ${H}px; background: ${ACCENT}; }
  .label { position: absolute; left: 80px; top: 90px; font-size: 34px; font-weight: 700; color: ${ACCENT}; }
  .title {
    font-size: ${titleSize}px; font-weight: 700; color: ${TITLE_COLOR};
    line-height: 1.35; word-break: keep-all;
    /* 파이썬 구현과 동일하게 최대 4줄까지만 */
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .footer { position: absolute; left: 80px; bottom: 62px; font-size: 28px; color: ${SUB_COLOR}; }
</style></head>
<body>
  <div class="card">
    <div class="bar"></div>
    <div class="label">${escapeHtml(label)}</div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="footer">${escapeHtml(footer)}</div>
  </div>
</body></html>`
}

/**
 * 렌더링용 숨은 창. 매번 만들고 부수면 두 번째 호출부터 ERR_FAILED로 죽는다 (실측).
 * 하나를 만들어 계속 재사용한다.
 */
let renderWindow: BrowserWindow | null = null

function getWindow(): BrowserWindow {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow
  renderWindow = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    // 둥근 모서리 바깥을 투명하게 캡처하려면 창 자체가 투명이어야 한다
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true, // 창을 띄우지 않고 렌더링 (show:false만으론 캡처가 빈 화면일 수 있다)
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  renderWindow.on('closed', () => {
    renderWindow = null
  })
  return renderWindow
}

/** 창을 하나만 쓰므로 동시에 두 개를 그리면 서로를 덮어쓴다 → 순서대로 처리 */
let queue: Promise<unknown> = Promise.resolve()

async function renderOnce(input: ThumbnailInput): Promise<Buffer> {
  const win = getWindow()

  // data: URL로 최상위 이동은 크로미움이 막는다 → 임시 파일로 쓰고 연다
  const dir = join(app.getPath('userData'), 'tmp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'thumbnail.html')
  writeFileSync(file, buildHtml(input), 'utf8')

  await win.loadFile(file)
  // 폰트가 적용되기 전에 캡처하면 글자가 밀리거나 안 보인다
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  if (png.length === 0) throw new Error('캡처 결과가 비어 있습니다.')
  return png
}

/**
 * 썸네일 PNG 생성. 화면에 보이지 않는 창에 그린 뒤 캡처한다.
 * 실패하면 예외 — 호출부가 "이미지 없이 발행"으로 넘어갈지 판단한다.
 */
export async function renderThumbnail(input: ThumbnailInput): Promise<Buffer> {
  const run = queue.then(() => renderOnce(input))
  // 앞선 렌더가 실패해도 큐가 멈추면 안 된다
  queue = run.catch(() => undefined)
  return run
}
