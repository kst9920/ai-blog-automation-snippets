/**
 * 텔레그램 봇 — 알림(나가는 쪽) + 원격 명령(들어오는 쪽).
 *
 * 토큰은 secrets(safeStorage 암호화)에 저장. chat_id는 사용자가 봇에게 아무 메시지나
 * 한 번 보내면 자동으로 잡아 설정에 채운다(폴링).
 *
 * 보안: 봇은 토큰만 알면 누구나 말을 걸 수 있다. 원격 명령은 **저장된 chat_id에서 온 것만**
 * 실행한다. 남이 /생성 30으로 API 비용을 태우는 걸 막는다.
 */
import { Bot, GrammyError, HttpError, type Context } from 'grammy'
import { getSecret } from './secrets'
import { getSettings, setSettings } from './settings'

let bot: Bot | null = null
/** 명령 실행 로직은 IPC 쪽(index.ts)에서 주입한다 — telegram이 db/scheduler를 직접 의존하지 않게 */
let commandHandler: ((cmd: TelegramCommand) => Promise<string>) | null = null
/** 봇이 멈춘 이유 / 마지막 명령 처리 오류. UI 상태 표시용 */
let lastError: string | null = null
/** 폴링이 죽었을 때 알릴 곳 (index.ts에서 데스크톱 알림을 주입). 조용히 죽지 않게 */
let failureHandler: ((reason: string) => void) | null = null

export interface TelegramCommand {
  /** queue | generate | publish(예약큐 발행) | publishNow(생성해서 즉시 발행) | roundup(상품추천 생성·발행+소셜타래) | social(발행글 소셜타래 변환) | help | md */
  kind: 'queue' | 'generate' | 'publish' | 'publishNow' | 'roundup' | 'social' | 'help' | 'md'
  /** generate의 개수, publish는 무시 */
  count?: number
  /** 대상 한정 (publish/publishNow/generate). 없으면 티스토리+블로거 둘 다 */
  target?: 'tistory' | 'blogger'
  /** 상품추천/소셜타래용 키워드 또는 상품군 이름 (비우면 자동 선정/최신 글) */
  keyword?: string
  /** md 투입 시 본문 */
  body?: string
}

export function setTelegramCommandHandler(fn: (cmd: TelegramCommand) => Promise<string>): void {
  commandHandler = fn
}

export function setTelegramFailureHandler(fn: (reason: string) => void): void {
  failureHandler = fn
}

export function getBotLastError(): string | null {
  return lastError
}

/** 텔레그램 오류를 사람이 조치할 수 있는 문장으로. 409·401이 실사용에서 제일 흔하다 */
function describeBotError(e: unknown): string {
  if (e instanceof GrammyError) {
    if (e.error_code === 409) {
      return '다른 곳(다른 PC의 autoBlog 등)에서 같은 봇이 이미 실행 중입니다. 한 곳에서만 켜두세요.'
    }
    if (e.error_code === 401 || e.error_code === 404) {
      return '봇 토큰이 틀렸거나 폐기됐습니다. BotFather에서 토큰을 확인해 다시 저장하세요.'
    }
    return `텔레그램 오류 ${e.error_code}: ${e.description}`
  }
  if (e instanceof HttpError) {
    return `텔레그램 서버에 연결하지 못했습니다: ${e.error instanceof Error ? e.error.message : String(e.error)}`
  }
  return e instanceof Error ? e.message : String(e)
}

async function postMessage(token: string, chatId: string, text: string, markdown: boolean): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(markdown ? { parse_mode: 'Markdown' } : {}) }),
    signal: AbortSignal.timeout(15_000)
  })
}

/**
 * 저장된 토큰으로 알림 한 줄 보내기. 토큰/chat_id 없으면 스킵(false).
 * 텔레그램이 거절하면 던진다 — 예전엔 응답을 안 봐서 401·400도 "성공"으로 넘어갔다.
 * Markdown 파싱 실패(본문의 `_`·`*` 등)는 서식 없이 한 번 더 보낸다.
 */
export async function sendTelegram(markdown: string): Promise<boolean> {
  const token = getSecret('telegramToken')
  const chatId = getSettings().telegramChatId
  if (!token || !chatId) return false

  // 봇 인스턴스 없이도 알림은 보낼 수 있게 REST를 직접 친다 (경량)
  let r = await postMessage(token, chatId, markdown, true)
  let data = (await r.json().catch(() => null)) as { description?: string } | null
  if (r.status === 400 && /parse entities/i.test(data?.description ?? '')) {
    r = await postMessage(token, chatId, markdown, false)
    data = (await r.json().catch(() => null)) as { description?: string } | null
  }
  if (!r.ok) {
    throw new Error(`텔레그램 전송 실패 (${r.status}): ${data?.description ?? r.statusText}`)
  }
  return true
}

function authorized(ctx: Context): boolean {
  const chatId = getSettings().telegramChatId
  return !!chatId && String(ctx.chat?.id) === chatId
}

/**
 * 봇 시작. 폴링으로 메시지를 받는다.
 * chat_id가 아직 없으면, 처음 온 메시지의 발신자를 등록한다(자동 감지).
 */
export function startBot(): { ok: boolean; error?: string } {
  const token = getSecret('telegramToken')
  if (!token) return { ok: false, error: '텔레그램 토큰이 없습니다.' }
  if (bot) return { ok: true } // 이미 실행 중

  try {
    lastError = null
    const instance = new Bot(token)
    bot = instance

    // 오류 처리기가 없으면 grammY는 미들웨어 오류 하나로 폴링을 멈춘다 → 기록만 하고 계속 돈다
    instance.catch((err) => {
      lastError = `명령 처리 중 오류: ${describeBotError(err.error)}`
      console.error('[telegram] 명령 처리 오류', err.error)
    })

    instance.on('message', async (ctx) => {
      const settings = getSettings()

      // chat_id 자동 감지: 아직 등록 안 됐으면 이 사람을 주인으로 등록한다
      if (!settings.telegramChatId) {
        setSettings({ telegramChatId: String(ctx.chat.id) })
        await ctx.reply('✅ 이 대화를 autoBlog에 연결했습니다. 이제 여기로 알림이 오고, 명령을 쓸 수 있어요.\n\n/help 로 명령을 확인하세요.')
        return
      }

      // 등록된 주인만 명령 실행
      if (!authorized(ctx)) {
        await ctx.reply('권한이 없습니다. 이 봇은 등록된 사용자만 쓸 수 있어요.')
        return
      }

      const cmd = parseCommand(ctx)
      if (!cmd) {
        await ctx.reply('알 수 없는 명령입니다. /help 로 확인하세요.')
        return
      }
      if (!commandHandler) {
        await ctx.reply('아직 명령을 처리할 준비가 안 됐습니다.')
        return
      }

      try {
        await ctx.reply('처리 중...')
        const result = await commandHandler(cmd)
        await ctx.reply(result)
      } catch (e) {
        await ctx.reply(`실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    })

    // 폴링은 백그라운드로 (start는 resolve되지 않는 long-poll이라 await하지 않는다).
    // 단, 실패(토큰 오류 401, 다른 곳에서 실행 중 409 등)는 반드시 잡는다 — 예전엔 여기서
    // 조용히 죽고 bot 변수만 남아 화면엔 "실행 중"으로 보였다.
    instance.start({ drop_pending_updates: true }).catch((e) => {
      if (bot === instance) bot = null
      lastError = describeBotError(e)
      console.error('[telegram] 봇 중지:', e)
      failureHandler?.(lastError)
    })
    return { ok: true }
  } catch (e) {
    bot = null
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function stopBot(): void {
  void bot?.stop()
  bot = null
}

export function isBotRunning(): boolean {
  return bot !== null
}

/** 명령 뒤에 붙은 대상 표기(티/블/tistory/blogger)를 읽는다. 없으면 undefined = 둘 다 */
function parseTarget(rest: string): 'tistory' | 'blogger' | undefined {
  if (/티|tistory/i.test(rest)) return 'tistory'
  if (/블|blogger/i.test(rest)) return 'blogger'
  return undefined
}

/** 텍스트/문서를 TelegramCommand로 해석 */
function parseCommand(ctx: Context): TelegramCommand | null {
  const text = ctx.message?.text?.trim() ?? ''

  if (/^\/(help|start|도움말)/.test(text)) return { kind: 'help' }
  if (/^\/(큐|queue)/.test(text)) return { kind: 'queue' }

  // 즉시발행(생성해서 바로): 반드시 /발행보다 먼저 검사 (문자열 포함 관계 없음이지만 명확히)
  const now = /^\/(즉시발행|생성발행|publishnow)\s*(.*)$/i.exec(text)
  if (now) return { kind: 'publishNow', target: parseTarget(now[2]) }

  const pub = /^\/(발행|publish)\s*(.*)$/i.exec(text)
  if (pub) return { kind: 'publish', target: parseTarget(pub[2]) }

  // 생성: "/생성", "/생성 3"만. "/생성발행"은 위 publishNow가 먼저 잡는다.
  const gen = /^\/(생성|generate)(?:\s+(\d+))?\s*$/.exec(text)
  if (gen) return { kind: 'generate', count: gen[2] ? Number(gen[2]) : 1 }

  // 상품추천: "/상품추천" (자동 상품군 선정) 또는 "/상품추천 제습기" (지정 상품군)
  const roundup = /^\/(상품추천|추천|roundup)(?:\s+(.+))?$/i.exec(text)
  if (roundup) return { kind: 'roundup', keyword: roundup[2]?.trim() || undefined }

  // 소셜타래: "/소셜", "/타래", "/쓰레드" (최근 Blogger 발행글 또는 키워드 매칭 글)
  const social = /^\/(소셜타래|소셜|타래|쓰레드|social)(?:\s+(.+))?$/i.exec(text)
  if (social) return { kind: 'social', keyword: social[2]?.trim() || undefined }

  return null
}
