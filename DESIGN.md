# DESIGN.md - 云鹿音乐设计规范

> 本文档为云鹿音乐（yun-music）跨界面的唯一视觉与交互真实信源（Single Source of Truth）。
> 所有页面、组件、样式修改与后续特性开发必须严格遵循本文档所声明的角色与取值范围。

## 1. 核心设计方向 (Direction)

- **概念叙述**：**温润唱片盒与现代数字声景（Warm Lacquer & Crisp Soundscape）**。
- **设计性格**：
  - **艺术品先行**：界面作为沉静的画布，让专辑封面与歌词自身成为视觉焦点。
  - **精密排印**：严格的等宽数字对齐、歌曲与歌手清晰分级、极细发丝分隔线。
  - **克制呼吸感**：杜绝厚重卡片多层嵌套，以留白、轴线与自然间距组织信息层级。
  - **动作确定性**：无冗余的同义反复提示文案，无四处漂浮的割裂小浮条。
- **项目绝对禁忌 (Prohibitions)**：
  - 严禁出现 AI 风格全大写追踪字符眉标（No uppercase tracked-caps eyebrows，如 `ACCOUNT`、`DASHBOARD`）。
  - 严禁复读标题的空状态废话（No redundant label paraphrases）。
  - 严禁滥用多层卡片包裹与夸张的弥散光晕阴影。
  - 严禁无意义的毛玻璃（保持稳定内容平面纯净高对比度，仅在模态遮罩与沉浸歌词层使用受控模糊）。

---

## 2. 字体与排印系统 (Typography)

### 字体栈 (Font Families)
- **西文/通用**：`Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **中文**：`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
- **等宽数据（时长、时间戳、文件大小、比特率）**：`ui-monospace, "SF Mono", Menlo, Consolas, monospace`

### 封闭字阶表 (Closed Type Scale)
| 角色 (Role) | 像素 (Size) | 相对大小 | 行高 (Line Height) | 字重 (Weight) | 用途 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **display** | 28px | 1.75rem | 1.25 | 700 | 专辑/歌手详情大标题、歌词核心高光行 |
| **title-lg** | 20px | 1.25rem | 1.3 | 650 | 页面主标题（如设置、榜单） |
| **title-md** | 16px | 1.0rem | 1.4 | 600 | 模块标题、歌单名称、弹窗标题 |
| **body** | 14px | 0.875rem | 1.45 | 400 / 500 | 歌曲名称、表格内容、表单输入 |
| **caption** | 12px | 0.75rem | 1.4 | 400 | 歌手名称、专辑次要信息、元数据 |
| **micro** | 11px | 0.6875rem | 1.3 | 600 | 音质徽章 (SQ / Hi-Res / 128K)、角标 |
| **mono** | 12px | 0.75rem | 1.0 | 500 | 播放进度时长、表格时间列、存储大小 |

---

## 3. 色彩系统与语义角色 (Color Roles)

### 浅色模式 (Light - Warm Lacquer)
- `--app-bg`: `#faf9f7` —— 温润天然纸质米白底色，消除纯白荧光反光
- `--app-bg-raised`: `#f2f0ea` —— 凸起或次级平面底色
- `--app-sidebar`: `#f4f1eb` —— 侧边栏背景
- `--app-surface`: `rgba(255, 255, 255, 0.94)` —— 内容板层表面
- `--app-surface-solid`: `#ffffff` —— 纯白不透明表面（用于弹窗、悬浮层）
- `--app-surface-soft`: `#f0ede6` —— 浅灰底、输入框背景、次级按钮
- `--app-border`: `rgba(45, 38, 32, 0.08)` —— 1px 极细发丝分割线
- `--app-border-strong`: `rgba(45, 38, 32, 0.16)` —— 强调边框、表单控件边缘
- `--app-text`: `#181615` —— 主文字（深暖碳黑，对比度 > 12:1）
- `--app-text-muted`: `#66615c` —— 次要文字（中暖灰，对比度 > 4.8:1）
- `--app-text-dim`: `#948e87` —— 占位符、次要图标
- `--app-accent`: `#fa243c` —— 经典鹿血朱红品牌色（工程契约保持一致）
- `--app-accent-soft`: `rgba(250, 36, 60, 0.12)` —— 强调色浅底衬
- `--app-on-accent`: `#ffffff` —— 强调色上的反白文字

### 深色模式 (Dark - Obsidian Soundscape)
- `--app-bg`: `#121214` —— 曜石深冷黑底
- `--app-bg-raised`: `#1a1a1d` —— 次级背景
- `--app-sidebar`: `#161619` —— 侧边栏背景
- `--app-surface`: `rgba(28, 28, 32, 0.92)` —— 内容板层表面
- `--app-surface-solid`: `#202024` —— 纯色深黑弹窗与卡片
- `--app-surface-soft`: `#28282d` —— 输入框、次级按钮底色
- `--app-border`: `rgba(255, 255, 255, 0.08)` —— 发丝深色分割线
- `--app-border-strong`: `rgba(255, 255, 255, 0.16)`
- `--app-text`: `#f4f4f6` —— 主文字（高对比暖白）
- `--app-text-muted`: `#a4a4ac` —— 次要文字（银灰）
- `--app-text-dim`: `#707078` —— 深灰文字与占位
- `--app-accent`: `#fa243c`
- `--app-accent-soft`: `rgba(250, 36, 60, 0.20)`
- `--app-on-accent`: `#ffffff`

---

## 4. 空间几何与组件标尺 (Geometry & Spacing)

### 间距尺度 (Spacing Scale)
- `space-1`: 4px (0.25rem) —— 微距、标签内间距
- `space-2`: 8px (0.5rem) —— 控件内图标与文字间距
- `space-3`: 12px (0.75rem) —— 表单项间距、紧凑列表间距
- `space-4`: 16px (1.0rem) —— 标准组件外边距、网格行间距
- `space-6`: 24px (1.5rem) —— 模块段落间距
- `space-8`: 32px (2.0rem) —— 页面分区大留白

### 圆角标尺 (Radii)
- `--app-radius-sm`: 0.375rem (6px) —— 音质徽章、小标签
- `--app-radius-md`: 0.625rem (10px) —— 按钮、输入框、专辑小图、菜单项
- `--app-radius-lg`: 0.875rem (14px) —— 歌单卡片、弹窗面板、浮动抽屉
- `--app-radius-xl`: 1.125rem (18px) —— 全局大面板
- `pill`: 9999px —— 胶囊搜索框、切换开关、浮动胶囊条

### 组件几何 (Component Heights & Sizes)
- **桌面侧边栏**：宽度 `clamp(15rem, 16vw, 18rem)`
- **桌面顶栏**：高度 `3.5rem` (56px)
- **标准控制项高度**：`2.5rem` (40px)
- **紧凑控制项高度**：`2.0rem` (32px)
- **底栏播放器高度**：`4.5rem` (72px)
- **歌曲行高 (Song Row)**：`3.25rem` (52px)，封面 `2.5rem` (40px)

---

## 5. 动效与交互准则 (Motion & Interaction)

- **微动效时长**：`--app-motion-fast: 140ms` —— 悬浮、点击、颜色切换、透明度变化。
- **布局/弹窗时长**：`--app-motion: 220ms` —— 抽屉滑入滑出、模态淡入淡出、视图过渡。
- **缓动曲线**：`cubic-bezier(0.2, 0, 0, 1)`（加速启动，平滑减速入位）。
- **无障碍降级**：当 `prefers-reduced-motion: reduce` 生效时，强制将所有过渡时间置为 `0ms`，消除跳动与位移动画。

---

## 6. 文案与信息呈现规范 (Voice & Tone)

- **直接准确**：操作按钮直接说明动作（“搜索音乐”、“创建歌单”、“进入播放器”）。
- **零冗余原则**：禁止出现“喜欢的歌曲会显示在这里”之类同义反复说明；有内容直接展示，无内容仅提示“暂无记录”。
- **严禁英文眉标装饰**：中文项目使用自然的标题层级组织，禁止使用英文标签充当虚假视觉高级感。

