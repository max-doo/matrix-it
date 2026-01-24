## 页面结构与样式修改指南

### 1. 整体布局与背景 (Layout & Global Background)

* **布局模式**：采用左侧侧边栏 + 右侧主内容区的结构。
* **全局背景颜色**：除表格卡片外，所有区域（包括侧边栏、顶部导航、背景底色）统一使用**淡灰色
* **简约设计原则**：移除不必要的边框线，通过色块区分功能区。

### 2. 左侧侧边栏 (Sidebar - 集合树显示区域)

* **功能**：展示 Zotero 集合树状结构。
* **样式**：
* 背景色与全局一致（淡灰色）。
* 左上角为产品 **LOGO**。
* 右上角排列 **刷新/同步按钮** 和 **设置图标**。
* 底部边缘放置 **连接状态说明** 和使用说明按钮，点击之后用系统默认浏览器打开外部链接。


### 3. 右侧主工作区 (Main Content Area)

* **视图切换 (Tabs)**：
* 位于顶部左侧，采用标签页形式切换“zotero文献”和“文献矩阵”。采用指示条样式：

```
import React from 'react';
import { Segmented, Tabs } from 'antd';
import type { TabsProps } from 'antd';

const onChange = (key: string) => {
  console.log(key);
};

const items: TabsProps['items'] = [
  { key: '1', label: 'Tab 1', children: 'Content of Tab Pane 1' },
  { key: '2', label: 'Tab 2', children: 'Content of Tab Pane 2' },
  { key: '3', label: 'Tab 3', children: 'Content of Tab Pane 3' },
];

type Align = 'start' | 'center' | 'end';

const App: React.FC = () => {
  const [alignValue, setAlignValue] = React.useState<Align>('center');
  return (
    <>
      <Segmented
        value={alignValue}
        style={{ marginBottom: 8 }}
        onChange={setAlignValue}
        options={['start', 'center', 'end']}
      />
      <Tabs
        defaultActiveKey="1"
        items={items}
        onChange={onChange}
        indicator={{ size: (origin) => origin - 20, align: alignValue }}
      />
    </>
  );
};

export default App;
```

* **操作工具栏 (Action Bar)**：
* 位于顶部右侧，包含“已选择 x 条”的提示文字和一组操作按钮。


* **核心表格卡片 (The White Card - 表格区域)**：
* **视觉重点**：这是页面中**唯一**的纯白色 (`#FFFFFF`) 区域。
* **容器样式**：设置圆角，并添加**极轻微的投影**（box-shadow），使其在淡灰色背景上产生“悬浮卡片”的视觉效果，达成突出显示的目的。
* **内部构成**：
* **数据表**：占据卡片中心。
* **表格页脚 (Footer)**：位于卡片底部，用于分页或汇总。页脚背景应保持白色，与表格主体连为一体。固定在底部，不随滚动而移动。