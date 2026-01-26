import { useCallback } from 'react'
import { message } from 'antd'
import type { LiteratureItem } from '../../types'
import { updateItem as updateItemRpc } from '../../lib/backend'

export function useItemUpdater<T extends { items: LiteratureItem[] }>(setLibrary: React.Dispatch<React.SetStateAction<T>>) {
  const saveMatrixPatch = useCallback(
    async (key: string, patch: Record<string, unknown>) => {
      try {
        await updateItemRpc(key, patch)
        setLibrary((prev) => ({
          ...prev,
          items: prev.items.map((it) => (it.item_key === key ? { ...it, ...patch } : it)),
        }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : '保存失败'
        message.error(msg)
        throw e instanceof Error ? e : new Error(msg)
      }
    },
    [setLibrary]
  )

  return { saveMatrixPatch }
}

