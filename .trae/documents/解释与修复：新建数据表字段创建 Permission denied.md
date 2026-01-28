## 需求理解
- 目前同步到飞书时，元数据字段 `type`（Zotero itemType，如 journalArticle / conferencePaper）会直接写入飞书。
- 目标：写入飞书时把该值映射为中文名称（与前端展示一致），例如 journalArticle → 期刊文章。

## 现状定位
- Zotero 抽取时 `type` 就是 `item_type`（英文代码）。[zotero.py](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L261-L281)
- 同步写飞书的值转换发生在 [map_item](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L384-L455)，当前不会对 `type` 做中文映射。
- 前端已有映射表 `LITERATURE_TYPE_MAP`（英文代码→中文 label）。[ui-formatters.tsx](file:///d:/Project/matrix-it/frontend/src/ui/utils/ui-formatters.tsx#L31-L57)

## 实施方案
### 1) 后端新增“文献类型中文映射表”
- 在 `backend/matrixit_backend/feishu.py` 增加一个常量 dict（与前端 `LITERATURE_TYPE_MAP` 对齐）。
- 提供一个小函数：输入 `type` 字符串 → 输出中文 label（未知则原样返回）。

### 2) 在写飞书前做映射
- 在 `map_item` 中检测 `jk == "type"` 且 `val` 为字符串时，将 `val` 替换为中文 label。
- 由于飞书该字段类型是单选（fields.json 中 meta_fields.type），写入中文后：
  - 若选项不存在，飞书会自动创建该选项（符合飞书记录写入行为）。

### 3) 兼容与回滚策略
- 未覆盖到的 itemType：保持原值（避免同步失败）。
- 不影响其他字段与分析字段 `bib_type`（它本身通常已是中文或业务自定义）。

## 验证方式
- 本地进行一次同步：确认飞书“类型”列写入为中文（期刊文章/会议论文等）。
- 对已有英文值条目进行“重新同步”：确认可覆盖为中文。
- 运行最小检查：Python `py_compile`、前端 lint、Rust `cargo check`（只要你希望我一并跑）。

## 交付物
- 后端：飞书同步时 `type` 字段值按中文映射输出。
- 文档/说明：补充一行说明该字段会做中文映射（可选）。