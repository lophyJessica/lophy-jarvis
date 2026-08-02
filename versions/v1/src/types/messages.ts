export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type MessageContent = string | ContentPart[]

export function isMessageContent(value: unknown): value is MessageContent {
  if (typeof value === 'string') return true
  if (!Array.isArray(value)) return false

  return value.every((part) => {
    if (!part || typeof part !== 'object') return false
    const record = part as Record<string, unknown>
    if (record.type === 'text') return typeof record.text === 'string'
    if (record.type !== 'image_url' || !record.image_url || typeof record.image_url !== 'object') {
      return false
    }
    return typeof (record.image_url as Record<string, unknown>).url === 'string'
  })
}

export function getMessageText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function getMessageImageUrls(content: MessageContent): string[] {
  if (typeof content === 'string') return []
  return content
    .filter((part): part is Extract<ContentPart, { type: 'image_url' }> => part.type === 'image_url')
    .map((part) => part.image_url.url)
}
