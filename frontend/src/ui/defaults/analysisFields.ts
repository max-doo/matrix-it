/**
 * 模块名称: 默认分析字段配置
 * 功能描述: 定义系统默认的文献分析字段列表及其属性（如类型、规则、描述）。
 *           这些配置用于初始化应用设置，或在用户重置配置时作为恢复基准。
 */
export type DefaultAnalysisFieldRow = {
  key: string
  name: string
  rule: 'A' | 'B'
  type: 'string' | 'number' | 'select' | 'multi_select' | 'file'
  description: string
}

export const DEFAULT_ANALYSIS_ORDER: string[] = [
  'tldr',
  'key_word',
  'bib_type',
  'research_question',
  'methods',
  'logic',
  'key_findings',
  'contribution',
  'highlights',
  'inspiration',
  'limitations',
]

export const DEFAULT_ANALYSIS_FIELDS: DefaultAnalysisFieldRow[] = [
  {
    key: 'tldr',
    name: 'TLDR',
    rule: 'A',
    type: 'string',
    description: '高度准确概括文献的主要内容',
  },
  {
    key: 'key_word',
    name: '关键词',
    rule: 'A',
    type: 'multi_select',
    description: '提取论文的关键词（如为英文须翻译成中文，专用缩写除外），用逗号隔开',
  },
  {
    key: 'bib_type',
    name: '文献类型',
    rule: 'A',
    type: 'multi_select',
    description: '根据文献的内容判断文献的类型，如：研究论文、方法论论文、综述论文、案例研究、研究报告、行业指南等',
  },
  {
    key: 'research_question',
    name: '研究问题',
    rule: 'A',
    type: 'string',
    description: '这篇文章试图回答的核心问题是什么？或要实现的主要目标是什么？(引用必须紧跟在每个要点之后)',
  },
  {
    key: 'methods',
    name: '研究方法',
    rule: 'A',
    type: 'string',
    description: '简明扼要地描述研究范式、对象、工具和分析方法(引用必须紧跟在每个要点之后)',
  },
  {
    key: 'logic',
    name: '论证逻辑',
    rule: 'A',
    type: 'string',
    description: '文章用怎样的逻辑来论证其论点？(引用必须紧跟在每个要点之后)',
  },
  {
    key: 'key_findings',
    name: '关键发现',
    rule: 'A',
    type: 'string',
    description: '较详细地说明其最核心的理论/方法论/发现。(引用必须紧跟在每个要点之后)',
  },
  {
    key: 'contribution',
    name: '贡献',
    rule: 'A',
    type: 'string',
    description: '本文对该领域最重要的理论、方法或实践贡献是什么？(引用必须紧跟在每个要点之后)',
  },
  {
    key: 'highlights',
    name: '亮点',
    rule: 'B',
    type: 'string',
    description: '论文的优点和创新之处（以资深领域专家的口吻）',
  },
  {
    key: 'inspiration',
    name: '启发',
    rule: 'B',
    type: 'string',
    description: '以独立视角分析这篇文章在理论、方法、选题等方面可能带来的具体启发，并设想未来可能的研究方向',
  },
  {
    key: 'limitations',
    name: '局限',
    rule: 'B',
    type: 'string',
    description: '作为顶级的同行评审专家，不仅要总结作者自己承认的局限（需引用原文），还必须独立找出原文中未提及的深层问题',
  },
]
