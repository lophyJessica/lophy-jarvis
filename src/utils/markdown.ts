import DOMPurify from 'dompurify'
import { marked, Renderer } from 'marked'

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const renderer = new Renderer()
renderer.code = ({ text, lang }) => {
  const language = lang ?? ''
  const label = language || 'code'
  const encoded = encodeURIComponent(text)

  return `<div class="code-block"><div class="code-block-header"><span>${escapeHtml(label)}</span><button type="button" class="code-copy-btn" data-copy="${encoded}">复制</button></div><pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`
}

marked.use({
  renderer,
  gfm: true,
  breaks: true,
})

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return DOMPurify.sanitize(typeof html === 'string' ? html : '', {
    ADD_ATTR: ['data-copy'],
  })
}
