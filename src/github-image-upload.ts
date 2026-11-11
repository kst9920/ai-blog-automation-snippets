/**
 * GitHub public 저장소를 이미지 호스팅으로 쓴다.
 *
 * Blogger는 본문에 <img src="URL">만 받는다(바이너리 업로드 없음). 그래서 썸네일 PNG를
 * 공개 URL로 만들어야 하는데, GitHub public 저장소가 무료 CDN 역할을 한다.
 *
 * 기존 파이썬(blogger-post.yml)은 git clone → commit → push를 썼지만, 데스크톱 앱에서는
 * git 설치를 강제하고 싶지 않아 Contents API(PUT)로 파일 하나만 올린다.
 */
import { getSecret } from '../secrets'
import { getSettings } from '../settings'

/**
 * PNG를 저장소에 올리고 raw 다운로드 URL을 반환한다.
 * 같은 경로가 이미 있으면 sha를 넣어 덮어쓴다(재발행 대비).
 */
export async function uploadImageToGitHub(png: Buffer, path: string): Promise<string> {
  const token = getSecret('githubToken')
  const repo = getSettings().githubAssetsRepo.trim()
  if (!token) throw new Error('GitHub 토큰이 없습니다. 설정에서 등록하세요.')
  if (!repo || !repo.includes('/')) throw new Error('GitHub 저장소가 "owner/repo" 형식이 아닙니다.')

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'autoBlog',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  // 이미 있는 파일이면 sha가 있어야 덮어쓸 수 있다 (없으면 404 → 신규)
  let sha: string | undefined
  const head = await fetch(apiUrl, { headers })
  if (head.ok) {
    const data = (await head.json()) as { sha?: string }
    sha = data.sha
  }

  const put = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `thumb ${path}`,
      content: png.toString('base64'),
      sha
    })
  })

  const text = await put.text()
  if (!put.ok) throw new Error(`GitHub 업로드 실패 (status=${put.status}): ${text.slice(0, 200)}`)

  const data = JSON.parse(text) as { content?: { download_url?: string } }
  const url = data.content?.download_url
  if (!url) throw new Error(`GitHub 응답에 download_url이 없습니다: ${text.slice(0, 200)}`)
  return url
}
