/**
 * 模块名称: Mock 数据工具
 * 功能描述: 提供前端开发和测试使用的模拟数据，用于在非 Tauri 环境下模拟后端返回的文献库数据。
 */
import type { CollectionNode, LiteratureItem } from '../types'

/**
 * 加载模拟的文献库数据
 * 包含文件夹结构（collections）和文献列表（items）
 */
export async function loadLibraryMock(): Promise<{ collections: CollectionNode[]; items: LiteratureItem[] }> {
  const collections: CollectionNode[] = [
    {
      key: 'root',
      name: '全部文献',
      children: [
        { key: 'c1', name: '方法论', children: [] },
        { key: 'c2', name: '案例研究', children: [] }
      ]
    }
  ]

  const items: LiteratureItem[] = [
    {
      item_key: 'A1',
      title: 'Sample Paper: A Minimal Pipeline for Literature Matrix',
      author: '张三, 李四',
      year: '2024',
      processed_status: 'unprocessed',
      sync_status: 'unsynced',
      collections: [{ id: 1, name: '方法论', path: '方法论', key: 'c1', pathKeyChain: ['root', 'c1'] }]
    },
    {
      item_key: 'B2',
      title: 'Sample Paper: Feishu Bitable as Research Knowledge Base',
      author: '王五',
      year: '2023',
      processed_status: 'done',
      sync_status: 'synced',
      collections: [{ id: 2, name: '案例研究', path: '案例研究', key: 'c2', pathKeyChain: ['root', 'c2'] }]
    }
  ]

  await new Promise((r) => setTimeout(r, 250))
  return { collections, items }
}
