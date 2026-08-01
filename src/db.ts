import type { ChatMessage } from './api/hermes'

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  time: string
  updatedAt: number
}

export interface SyncMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

const dbName = 'jarvis-console'
const storeName = 'messages'
const dbVersion = 1

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatTime(value?: string | number) {
  if (value === undefined) return timeFormatter.format(new Date())
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? timeFormatter.format(new Date()) : timeFormatter.format(date)
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
  return records
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((record) => ({
      id: record.id,
      role: record.role,
      content: record.content,
      time: record.time,
      updatedAt: record.updatedAt,
    }))
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
    createdAt: new Date(message.updatedAt).toISOString(),
  }))
}

export function mergeMessages(local: StoredMessage[], server: SyncMessage[]): StoredMessage[] {
  const merged = new Map<string, StoredMessage>()

  for (const message of server) {
    const updatedAt = Date.parse(message.createdAt)
    merged.set(message.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      time: formatTime(message.createdAt),
      updatedAt: Number.isNaN(updatedAt) ? Date.now() : updatedAt,
    })
  }

  for (const message of local) {
    if (merged.has(message.id)) continue
    merged.set(message.id, message)
  }

  return Array.from(merged.values()).sort((left, right) => left.updatedAt - right.updatedAt)
}

export async function syncFromServer(
  fetchHistory: () => Promise<SyncMessage[]>,
  limit = 200,
): Promise<StoredMessage[]> {
  const local = await getMessages()
  try {
    const server = await fetchHistory()
    const merged = mergeMessages(local, server).slice(-limit)
    await clearMessages()
    for (const message of merged) {
      await addMessage(message)
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

export function createStoredMessage(role: 'user' | 'assistant', content: string): StoredMessage {
  const updatedAt = Date.now()
  return {
    id: crypto.randomUUID(),
    role,
    content,
    time: formatTime(updatedAt),
    updatedAt,
  }
}

export function toChatHistory(messages: StoredMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }))
}
