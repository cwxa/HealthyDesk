/**
 * 极简 Markdown 渲染：仅支持大模型常见输出的标题(##)、列表(-)、粗体(**)、段落。
 * 不引入额外依赖，避免为一个小面板增加体积。
 */
import type { ReactNode } from 'react'

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-b${i}`}>{part.slice(2, -2)}</strong>
    }
    return <span key={`${keyPrefix}-t${i}`}>{part}</span>
  })
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let listBuffer: string[] = []

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return
    blocks.push(
      <ul key={key} style={{ margin: '6px 0', paddingLeft: 20, lineHeight: 1.9 }}>
        {listBuffer.map((item, i) => (
          <li key={i} style={{ fontSize: 13, color: '#444' }}>
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </ul>,
    )
    listBuffer = []
  }

  lines.forEach((raw, idx) => {
    const line = raw.trim()
    if (!line) {
      flushList(`list-${idx}`)
      return
    }
    if (line.startsWith('### ')) {
      flushList(`list-${idx}`)
      blocks.push(
        <h4 key={`h4-${idx}`} style={{ fontSize: 14, fontWeight: 700, color: '#333', margin: '14px 0 6px' }}>
          {renderInline(line.slice(4), `h4-${idx}`)}
        </h4>,
      )
    } else if (line.startsWith('## ')) {
      flushList(`list-${idx}`)
      blocks.push(
        <h3 key={`h3-${idx}`} style={{
          fontSize: 15, fontWeight: 700, color: 'var(--primary-dark, #2E7D32)',
          margin: '16px 0 6px', paddingBottom: 4, borderBottom: '1px solid #EEEEEE',
        }}>
          {renderInline(line.slice(3), `h3-${idx}`)}
        </h3>,
      )
    } else if (/^[-*]\s+/.test(line)) {
      listBuffer.push(line.replace(/^[-*]\s+/, ''))
    } else if (/^\d+\.\s+/.test(line)) {
      listBuffer.push(line.replace(/^\d+\.\s+/, ''))
    } else {
      flushList(`list-${idx}`)
      blocks.push(
        <p key={`p-${idx}`} style={{ fontSize: 13, color: '#444', lineHeight: 1.9, margin: '6px 0' }}>
          {renderInline(line, `p-${idx}`)}
        </p>,
      )
    }
  })
  flushList('list-end')

  return <div>{blocks}</div>
}
