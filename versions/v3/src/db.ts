import type { ChatMessage } from './api/hermes'
import { isMessageContent, type MessageContent } from './types/messages'

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: MessageContent
  createdAt: string
}

export interface SyncMessage {
  id: string
  role: 'user' | 'assistant'
  content: MessageContent
  createdAt: string
}

const dbName = 'jarvis-console'
const storeName = 'messages'
const dbVersion = 1

function isIsoTimestamp(value: string) {
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed)
}

function migrateCreatedAt(record: Record<string, unknown>, index: number, total: number): string {
  if (typeof record.createdAt === 'string' && record.createdAt.length > 0 && isIsoTimestamp(record.createdAt)) {
    return record.createdAt
  }
  if (typeof record.created_at === 'string' && record.created_at.length > 0 && isIsoTimestamp(record.created_at)) {
    return record.created_at
  }
  if (typeof record.updatedAt === 'number' && !Number.isNaN(record.updatedAt)) {
    return new Date(record.updatedAt).toISOString()
  }
  const timeRaw = record.time
  if (typeof timeRaw === 'string' && timeRaw.length > 0 && isIsoTimestamp(timeRaw)) {
    return new Date(Date.parse(timeRaw)).toISOString()
  }
  return new Date(Date.now() - (total - index) * 1000).toISOString()
}

function migrateStoredRecord(record: Record<string, unknown>, index: number, total: number): StoredMessage | null {
  const role = record.role
  const content = record.content
  if (role !== 'user' && role !== 'assistant') return null
  if (!isMessageContent(content)) return null

  const idRaw = record.id
  const id = typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : `local-${index}`

  return {
    id,
    role,
    content,
    createdAt: migrateCreatedAt(record, index, total),
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    const request = run(store)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    request.onsuccess = () => resolve(request.result)
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

export async function getMessages(): Promise<StoredMessage[]> {
  const records = await withStore('readonly', (store) => store.getAll())
  const total = records.length
  return records
    .map((record, index) => migrateStoredRecord(record as Record<string, unknown>, index, total))
    .filter((message): message is StoredMessage => message !== null)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
}

export async function addMessage(message: StoredMessage): Promise<void> {
  await withStore('readwrite', (store) => store.put(message))
}

export async function clearMessages(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}

export function toSyncMessages(messages: StoredMessage[]): SyncMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }))
}

function messageContentKey(message: { role: string; content: MessageContent; createdAt: string }) {
  const contentKey = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content)
  return `${message.role}\u0000${contentKey}\u0000${message.createdAt}`
}

export function mergeMessages(local: StoredMessage[], server: SyncMessage[]): StoredMessage[] {
  const merged = new Map<string, StoredMessage>()
  const contentKeys = new Set<string>()

  for (const message of server) {
    contentKeys.add(messageContentKey(message))
    merged.set(message.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })
  }

  for (const message of local) {
    if (merged.has(message.id)) continue
    const key = messageContentKey(message)
    if (contentKeys.has(key)) continue
    contentKeys.add(key)
    merged.set(message.id, message)
  }

  return Array.from(merged.values()).sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  )
}

export async function syncFromServer(
  fetchHistory: () => Promise<SyncMessage[]>,
  limit = 200,
  pushHistory?: (payload: SyncMessage[]) => Promise<void>,
): Promise<StoredMessage[]> {
  const local = await getMessages()
  try {
    const server = await fetchHistory()
    const merged = mergeMessages(local, server).slice(-limit)
    await clearMessages()
    for (const message of merged) {
      await addMessage(message)
    }
    if (server.length === 0 && merged.length > 0 && pushHistory) {
      try {
        await pushHistory(toSyncMessages(merged))
      } catch {
        // Offline cache remains; server push can retry on next message.
      }
    }
    return merged
  } catch {
    return local.slice(-limit)
  }
}

export async function syncToServer(
  messages: StoredMessage[],
  pushHistory: (payload: SyncMessage[]) => Promise<void>,
): Promise<void> {
  try {
    await pushHistory(toSyncMessages(messages))
  } catch {
    // Keep local cache even when sync fails.
  }
}

export function createStoredMessage(role: 'user' | 'assistant', content: MessageContent): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  }
}

export function toChatHistory(messages: StoredMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }))
}
