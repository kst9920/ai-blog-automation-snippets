/**
 * Blogger 공식 API v3 호출.
 *
 * 티스토리와 달리 세션 쿠키가 아니라 구글 OAuth를 쓴다.
 * refresh token(장수명)으로 access token(단수명)을 그때그때 발급받아 호출한다.
 * 기존 파이썬(publish_blogger.py)에서 검증된 방식.
 */
import { getSecret } from '../../secrets'
import { getSettings } from '../../settings'

async function getAccessToken(): Promise<string> {
  const clientSecret = getSecret('bloggerClientSecret')
  const refreshToken = getSecret('bloggerRefreshToken')
  const { bloggerClientId } = getSettings()

  if (!bloggerClientId || !clientSecret || !refreshToken) {
    throw new Error('Blogger 인증 정보가 없습니다. 설정에서 client id/secret과 refresh token을 등록하세요.')
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: bloggerClientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })

  const text = await r.text()
  if (!r.ok) throw new Error(`구글 토큰 갱신 실패 (status=${r.status}): ${text.slice(0, 200)}`)
  const data = JSON.parse(text) as { access_token?: string }
  if (!data.access_token) throw new Error('구글 응답에 access_token이 없습니다.')
  return data.access_token
}

/** refresh token이 살아있는지 (access token 발급이 되는지) 확인 */
export async function checkBloggerAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getAccessToken()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 글 발행. 성공 시 글 URL 반환. isDraft면 초안으로 저장(검수용). */
export async function publishToBlogger(input: {
  title: string
  contentHtml: string
  labels: string[]
  isDraft: boolean
}): Promise<string> {
  const { bloggerBlogId } = getSettings()
  if (!bloggerBlogId) throw new Error('Blogger 블로그 ID가 설정돼 있지 않습니다.')

  const token = await getAccessToken()
  let url = `https://www.googleapis.com/blogger/v3/blogs/${bloggerBlogId}/posts/`
  if (input.isDraft) url += '?isDraft=true'

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'blogger#post',
      title: input.title,
      content: input.contentHtml,
      labels: input.labels.slice(0, 6) // Blogger 라벨은 6개까지가 무난
    })
  })

  const text = await r.text()
  if (!r.ok) throw new Error(`Blogger 발행 실패 (status=${r.status}): ${text.slice(0, 300)}`)
  const data = JSON.parse(text) as { url?: string; id?: string }
  return data.url ?? (data.id ? `blogger post ${data.id}` : '발행됨(URL 없음)')
}
