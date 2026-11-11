/**
 * 모든 LLM 호출의 단일 경로. Claude → Gemini → OpenAI 순으로 폴백.
 * (참고 구현: shorts_lingomori/generator/llm.py + llm_claude.py)
 *
 * 호출부는 예전처럼 client.chat.completions.create({ messages, response_format, temperature })를
 * 부르고 resp.choices[0].message.content / resp.usage를 읽는다 — 제공자를 몰라도 된다.
 *
 * - 키가 있는 제공자만 쓴다 (앱 설정 → 상위 폴더의 .env 순으로 찾음, secrets.ts).
 * - 키 오류·크레딧 부족·쿼터 초과·과부하·연결 실패면 다음 제공자로 넘어간다.
 *   요청 자체가 잘못된 오류(400 등)는 넘기지 않고 그대로 던진다 — 버그를 가리지 않기 위해.
 * - 폴백은 조용히 하지 않는다: 콘솔 로그 + 계정/쿼터 문제는 알림(notify) + 응답의 servedBy.
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { getSecret, type SecretKey } from '../secrets'
import { getSettings } from '../settings'
import { notify } from '../notify'

/**
 * Claude 사고 깊이. 블로그 글은 사실 정확성이 중요하지만 배치로 수십 편을 뽑기도 해서
 * 모델 기본값(medium)을 명시해 둔다. 품질이 모자라면 'high'로 올려 비교할 것.
 */
const CLAUDE_EFFORT = 'medium' as const
/** 본문 JSON + 사고 토큰이 들어갈 여유. 스트리밍이라 타임아웃 걱정은 없다. */
const CLAUDE_MAX_TOKENS = 32000
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'
/** Gemini 무료 티어 쿼터는 같은 날 안 풀린다 — 한 번 막히면 이 시간 동안 건너뛴다 */
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000

export type Provider = 'claude' | 'gemini' | 'openai'

const ORDER: Provider[] = ['claude', 'gemini', 'openai']
const LABEL: Record<Provider, string> = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' }
const KEY_NAME: Record<Provider, SecretKey> = {
  claude: 'anthropicApiKey',
  gemini: 'geminiApiKey',
  openai: 'openaiApiKey'
}

export const NO_LLM_KEY_MESSAGE =
  'AI API 키가 없습니다. 설정에서 OpenAI 키를 넣거나, 상위 폴더의 .env에 ANTHROPIC_API_KEY · GEMINI_API_KEY · OPENAI_API_KEY 중 하나를 넣어주세요.'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  response_format?: { type: 'json_object' }
  /** Gemini·OpenAI에만 전달된다. Claude 최신 모델은 샘플링 값을 받지 않는다(400). */
  temperature?: number
}

export interface ChatResponse {
  choices: { message: { content: string | null } }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  /** 실제로 답한 제공자·모델. 폴백됐으면 이유도 붙는다. 예: "Gemini gemini-3.8-flash (Claude: 크레딧 부족)" */
  servedBy: string
}

export interface LlmClient {
  chat: { completions: { create(req: ChatRequest): Promise<ChatResponse> } }
}

export function hasAnyLlmKey(): boolean {
  return ORDER.some((p) => !!getSecret(KEY_NAME[p]))
}

/** 지금 키가 있는 제공자 (설정 화면 표시용) */
export function availableProviders(): Provider[] {
  return ORDER.filter((p) => !!getSecret(KEY_NAME[p]))
}

// ── 폴백 상태: 계정 문제는 키가 바뀔 때까지, 쿼터 문제는 일정 시간 건너뛴다 ──

interface Blocked {
  key: string
  until: number // Infinity = 키가 바뀔 때까지
  reason: string
}
const blocked = new Map<Provider, Blocked>()

function isBlocked(p: Provider, key: string): boolean {
  const b = blocked.get(p)
  if (!b) return false
  if (b.key !== key || Date.now() >= b.until) {
    blocked.delete(p)
    return false
  }
  return true
}

type FailureKind = 'account' | 'quota' | 'transient'
interface Failure {
  kind: FailureKind
  reason: string
}

/** Claude가 200으로 답했지만 쓸 수 없는 응답(거절·잘림). 다른 제공자로 넘길 만한 실패다. */
class ClaudeOutputError extends Error {}

function classify(p: Provider, e: unknown): Failure | null {
  if (e instanceof ClaudeOutputError) return { kind: 'transient', reason: e.message }
  const msg = e instanceof Error ? e.message : String(e)
  if (p === 'claude') {
    if (e instanceof Anthropic.AuthenticationError) return { kind: 'account', reason: '키 오류' }
    if (e instanceof Anthropic.PermissionDeniedError) return { kind: 'account', reason: '권한 없음' }
    if (e instanceof Anthropic.BadRequestError && /credit/i.test(msg)) return { kind: 'account', reason: '크레딧 부족' }
    if (e instanceof Anthropic.RateLimitError) return { kind: 'transient', reason: '속도 제한' }
    if (e instanceof Anthropic.InternalServerError) return { kind: 'transient', reason: '서버 과부하' }
    if (e instanceof Anthropic.APIConnectionError) return { kind: 'transient', reason: '연결 실패' }
    return null
  }
  if (e instanceof OpenAI.AuthenticationError) return { kind: 'account', reason: '키 오류' }
  if (e instanceof OpenAI.PermissionDeniedError) return { kind: 'account', reason: '권한 없음' }
  // Gemini는 잘못된 키를 400 "API key not valid"로 돌려준다
  if (e instanceof OpenAI.BadRequestError && /api key/i.test(msg)) return { kind: 'account', reason: '키 오류' }
  if (e instanceof OpenAI.RateLimitError) {
    // Gemini 무료 티어의 429는 사실상 일일 쿼터 소진 (링고모리 실측: 재시도해도 그날은 안 풀림)
    return p === 'gemini' || /quota|resource_exhausted|billing/i.test(msg)
      ? { kind: 'quota', reason: '쿼터 초과' }
      : { kind: 'transient', reason: '속도 제한' }
  }
  if (e instanceof OpenAI.InternalServerError) return { kind: 'transient', reason: '서버 과부하' }
  if (e instanceof OpenAI.APIConnectionError) return { kind: 'transient', reason: '연결 실패' }
  return null
}

// ── 제공자별 호출 ──

const JSON_ONLY = 'Respond with a single JSON object only. No code fences, no text before or after it.'

function stripFences(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  return t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}

async function callClaude(key: string, model: string, req: ChatRequest): Promise<ChatResponse> {
  const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content)
  if (req.response_format?.type === 'json_object') systemParts.push(JSON_ONLY)
  const turns = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const client = new Anthropic({ apiKey: key })
  const msg = await client.beta.messages
    .stream({
      model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemParts.join('\n\n'),
      messages: turns,
      output_config: { effort: CLAUDE_EFFORT },
      // 안전 분류기가 드물게 거절하면 서버가 권장 모델로 다시 돌린다. Haiku에는 이 기능이 없다.
      ...(model.includes('haiku')
        ? {}
        : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const })
    })
    .finalMessage()

  if (msg.stop_reason === 'refusal') throw new ClaudeOutputError('요청 거절')
  if (msg.stop_reason === 'max_tokens') throw new ClaudeOutputError('응답이 max_tokens에서 잘림')
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  const promptTokens = msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
  return {
    choices: [{ message: { content: stripFences(text) } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: msg.usage.output_tokens,
      total_tokens: promptTokens + msg.usage.output_tokens
    },
    servedBy: `Claude ${msg.model}`
  }
}

/**
 * Gemini 호환 엔드포인트는 오류를 배열([{ error }])로 준다. OpenAI SDK가 이걸 못 읽어
 * "400 status code (no body)"가 되고 키 오류·쿼터 초과를 구분할 수 없게 된다 → 객체로 풀어준다.
 */
const geminiFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const res = await fetch(url, init)
  if (res.ok) return res
  const text = await res.text()
  let body = text
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed[0]) body = JSON.stringify(parsed[0])
  } catch {
    // JSON이 아니면 그대로
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

async function callOpenAiCompat(p: Provider, key: string, model: string, req: ChatRequest): Promise<ChatResponse> {
  const client = new OpenAI(
    p === 'gemini'
      ? { apiKey: key, baseURL: GEMINI_BASE_URL, fetch: geminiFetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'] }
      : { apiKey: key }
  )
  // OpenAI JSON 모드는 메시지에 "json"이란 단어가 없으면 400을 낸다 — Claude 경로처럼 지시를 덧붙인다
  const needsJsonWord =
    req.response_format?.type === 'json_object' && !req.messages.some((m) => /json/i.test(m.content))
  const resp = await client.chat.completions.create({
    model,
    messages: needsJsonWord ? [...req.messages, { role: 'system', content: JSON_ONLY }] : req.messages,
    response_format: req.response_format,
    temperature: req.temperature
  })
  const content = resp.choices[0]?.message?.content ?? null
  return {
    choices: [{ message: { content: content == null ? null : stripFences(content) } }],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens
        }
      : undefined,
    servedBy: `${LABEL[p]} ${model}`
  }
}

function modelFor(p: Provider): string {
  const s = getSettings()
  return p === 'claude' ? s.claudeModel : p === 'gemini' ? s.geminiModel : s.openaiModel
}

async function create(req: ChatRequest): Promise<ChatResponse> {
  const withKeys = ORDER.map((p) => ({ p, key: getSecret(KEY_NAME[p]) })).filter(
    (c): c is { p: Provider; key: string } => !!c.key
  )
  if (withKeys.length === 0) throw new Error(NO_LLM_KEY_MESSAGE)

  // 막힌 제공자는 뒤로 — 전부 막혔으면 그래도 순서대로 시도한다 (그새 충전했을 수 있다)
  const ready = withKeys.filter((c) => !isBlocked(c.p, c.key))
  const candidates = [...ready, ...withKeys.filter((c) => !ready.includes(c))]

  const failures: string[] = []
  let lastError: unknown
  for (const { p, key } of candidates) {
    const model = modelFor(p)
    try {
      const resp = p === 'claude' ? await callClaude(key, model, req) : await callOpenAiCompat(p, key, model, req)
      if (failures.length) resp.servedBy += ` (${failures.join(', ')})`
      return resp
    } catch (e) {
      const f = classify(p, e)
      if (!f) throw e
      lastError = e
      failures.push(`${LABEL[p]}: ${f.reason}`)
      console.warn(`[LLM] ${LABEL[p]} ${model} 실패(${f.reason}) → 다음 제공자로`, e instanceof Error ? e.message : e)
      if (f.kind !== 'transient' && !isBlocked(p, key)) {
        blocked.set(p, { key, until: f.kind === 'account' ? Infinity : Date.now() + QUOTA_COOLDOWN_MS, reason: f.reason })
        notify(
          `AI ${LABEL[p]} 사용 불가: ${f.reason}`,
          f.kind === 'account'
            ? '키를 바꾸거나 충전할 때까지 다음 제공자로 생성합니다.'
            : '1시간 동안 다음 제공자로 생성합니다.'
        )
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`모든 AI 제공자가 실패했습니다 (${failures.join(', ')}): ${detail}`)
}

const client: LlmClient = { chat: { completions: { create } } }

/** 키 확인은 호출 시점에 한다 — 키가 없으면 create가 NO_LLM_KEY_MESSAGE로 던진다 */
export function createLlm(): LlmClient {
  return client
}
