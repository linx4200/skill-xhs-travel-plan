# 阅读优先 · 极简网页样式设计文档（Reading-First Minimal Web Style）

> 用途：把这套「阅读优先」极简设计 **100% 还原**到其他网页。
> 唯一设计原则：**阅读体验 > 简洁 > 无装饰**。所有视觉元素只服务于「快速定位 + 看清结构」，不引入任何无实际作用的装饰（无阴影、无渐变、无彩色块、无图标堆砌）。
> 配套文件：`reading-first.css`（复制即用；本文档描述其设计原则、结构契约和关键样式）。

---

## 1. 设计令牌（Design Tokens）

| 令牌 | 值 | 作用 |
|------|----|------|
| `--text` | `#1f1f1f` | 正文主色（非纯黑，降低长时间阅读疲劳） |
| `--muted` | `#555` | 次要文字（预留，可用于引言/注释，当前未强制使用） |
| `--heading` | `#141414` | 所有标题颜色 |
| `--border` | `#e6e6e6` | 分隔线、层级缩进线 |
| `--line` | `#d8d8d6` | timeline 主线 |
| `--marker` | `#747474` | timeline 节点 |
| `--soft` | `#f6f6f5` | 折叠标题悬停底色（可点击提示） |
| `--page` | `#f3f3f2` | 正文栏外的页面底色（衬托白色阅读栏） |
| `--measure` | `680px` | 移动端优先的正文最大宽度 |

配色全部为中性灰白。链接蓝色只用于可点击文本；折叠箭头、timeline 主线和节点都只表示结构或交互状态，不用于装饰。

---

## 2. 字体（Font Stack）

跨平台中文优先，无需引入外部字体文件：

```
-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
"Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif
```

- 基准字号 `16px`，行高 `1.85`，字间距 `0.01em`。
- 行高 1.85 是中文长文舒适阅读的关键值，不要低于 1.7。

---

## 3. 排版尺度（Type Scale）

| 元素 | 字号 | 字重 | 颜色 | 外边距 |
|------|------|------|------|--------|
| `h1`（页面主标题） | `1.7rem` | 700 | `--heading` | `0 0 14px` + 底部 `1px` 分隔线 + `padding-bottom:14px` |
| `h2`（一级分区标题，在 summary 内） | `1.32rem` | 700 | `--heading` | `0`（由 summary 控制） |
| `h3`（二级项标题 / 正文内小节标题） | `1.06rem` | 700 | `--heading` | `18px 0 8px`（在 summary 内为 `0`） |
| `h4`（内容小标题，如「看点」「提醒」） | `1rem` | 700 | `--heading` | `16px 0 6px` |
| `body` 正文 | `16px` | 400 | `--text` | — |
| `p` 段落 | — | — | `--text` | `10px 0` |
| `ul` 列表 | — | — | — | `10px 0`，`padding-left:1.4em` |
| `li` 列表项 | — | — | — | `6px 0` |

层级靠「字号递减 + 加粗 + 间距」拉开，不靠颜色或背景区分。

---

## 4. 布局规则

- 页面底色 `html { background: var(--page) }`。
- 阅读栏：`body { max-width:680px; margin:0 auto; padding:28px 20px 72px; background:#fff }`，较宽屏幕可增加内边距。
- 白色阅读栏居中，栏外为浅灰页面底色，天然形成「专注阅读区」，无需边框/阴影。
- `<head>` 必须包含 `<meta name="viewport" content="width=device-width, initial-scale=1.0">`，保证移动端正常阅读。

---

## 5. HTML 结构契约（必须遵循才能 100% 还原）

这套样式**强依赖**如下结构。只要你的新网页套用相同结构，视觉即完全一致。

### 5.1 一级分区（如「每日行程安排」「城市汇总」）
```html
<section>
  <details open>
    <summary><h2>一级分区标题</h2></summary>
    <!-- 内容：可直接放 h3/h4/p/ul，或嵌套二级项（见 5.2） -->
  </details>
</section>
```
- `open` 属性：存在则默认展开，省略则默认收起。
- 一级分区的 `<summary>` 顶部自动出现 `1px` 分隔线，与其他分区隔开。

### 5.2 二级项（如「Day 1」「兴文石海」「毕节」）
```html
<section>
  <details open>   <!-- 或省略 open 以默认收起 -->
    <summary><h3>二级项标题</h3></summary>
    <p>说明文字</p>
    <h4>小标题</h4>
    <ul>
      <li>清单项</li>
    </ul>
  </details>
</section>
```
- 二级项自动获得**左侧细线 + 缩进**，清晰表达从属关系。
- 可无限嵌套（再套一层 `details details details` 会继续缩进）。

### 5.3 纯内容分区（无嵌套，如「整体准备与风险提醒」）
一级 `details` 内直接写 `h3` / `h4` / `p` / `ul` 即可，`h3` 在此作为小节标题（非 summary 内），享受 `18px 0 8px` 间距。

### 5.4 Timeline（用于每日行程安排）
```html
<ol class="timeline">
  <li>
    <strong>上午｜景点 A</strong>
    <p>到达方式、游玩重点、关键提醒。</p>
    <ul>
      <li>可扫描的补充信息。</li>
    </ul>
  </li>
</ol>
```
- `timeline` 只用于表达顺序：每天、时间段、路线停留点。
- 节点和竖线是功能性结构标记，不是装饰。
- 不要把景点长详情、城市概览或整体注意事项放进 timeline。

### 5.5 页面导航
```html
<nav class="page-nav" aria-label="页面导航">
  <a href="index.html">返回首页</a>
  <a href="day-02.html">下一天</a>
</nav>
```
- `page-nav` 用于静态 HTML 页面互链。
- 链接保持普通文本样式，不做按钮、不加图标。

### 5.6 元信息小字
```html
<p class="meta">生成时间：YYYY-MM-DD HH:mm</p>
```
- `.meta` 用于页面末尾的轻量元信息，例如首页 HTML 生成时间。
- 元信息只做说明，不承载攻略正文、来源说明或生成过程说明。

### 5.7 照片（用于景点详情）
```html
<figure class="photo">
  <img src="assets/photos/五尺道景区/01-入口.jpg" alt="五尺道景区入口" loading="lazy">
  <figcaption>五尺道景区入口。</figcaption>
</figure>
```
- 照片只用于帮助识别景点、入口、路线、观景点等实际信息。
- 照片放在对应景点详情中，不放首页 timeline。
- 没有照片时直接跳过，不生成空照片位。
- 图片必须使用 `figure.photo > img` 结构，`reading-first.css` 会让图片按正文栏宽度响应式缩放，避免在移动端撑破阅读栏。
- 多张照片可用 `.photo-grid` 包裹多个 `figure.photo`；`.photo-grid` 只提供竖向间距，不做轮播、瀑布流或多列相册组件。
- `alt` 必须说明照片内容，不能只写“图片”或“照片”。

### 5.8 关键约束
- 标题必须放在 `<summary>` 内（h2/h3），否则不会获得折叠箭头与悬停态。
- `summary` 内只放一个标题元素（h2 或 h3），不要塞段落。
- 基础阅读结构不要为了样式额外加 `class` 或 `id`。仅允许使用 `.timeline`、`.page-nav`、`.meta`、`.photo`、`.photo-grid` 这类有明确语义和功能的 class。

---

## 6. 折叠导航行为

- `summary` 为 `flex` 布局，最左侧是 svg 箭头 `::before`，其后紧跟标题。
- 箭头在 `details[open]` 时旋转 `90°`，明确指示展开/收起状态（功能性，非装饰）。
- 鼠标悬停 `summary` 出现浅灰底 `--soft`，提示「可点击」。
- 已隐藏浏览器默认三角标记（`list-style:none` + `::-webkit-details-marker{display:none}`），跨浏览器一致。

---

## 7. 完整 CSS（复制即用）

> 与 `reading-first.css` 的核心样式保持一致。生成旅游攻略时优先使用 `<link rel="stylesheet" href="reading-first.css">` 外链引入。

```css
:root{
  --text:#1f1f1f;
  --muted:#555;
  --heading:#141414;
  --border:#e6e6e6;
  --line:#d8d8d6;
  --marker:#747474;
  --soft:#f6f6f5;
  --page:#f3f3f2;
  --measure:680px;
}
*{box-sizing:border-box}
html{background:var(--page);-webkit-text-size-adjust:100%}
body{
  max-width:var(--measure);
  margin:0 auto;
  padding:28px 20px 72px;
  background:#fff;
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
  font-size:16px;
  line-height:1.85;
  letter-spacing:.01em;
}
h1{font-size:1.7rem;line-height:1.35;font-weight:700;color:var(--heading);margin:0 0 14px;padding-bottom:14px;border-bottom:1px solid var(--border)}
h2{font-size:1.32rem;font-weight:700;color:var(--heading);margin:0}
h3{font-size:1.06rem;font-weight:700;color:var(--heading);margin:18px 0 8px}
h4{font-size:1rem;font-weight:700;color:var(--heading);margin:16px 0 6px}
p{margin:10px 0;color:var(--text)}
ul{margin:10px 0;padding-left:1.4em}
li{margin:6px 0}
a{color:#1a5fb4}
.meta{margin:8px 0 14px;color:var(--muted);font-size:.94rem;line-height:1.65}
.page-nav{display:flex;flex-wrap:wrap;gap:8px 14px;margin:12px 0 22px;font-size:.96rem;line-height:1.55}
.page-nav a{color:#1a5fb4;text-decoration-thickness:1px;text-underline-offset:3px}
summary{
  list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;
  padding:9px 8px;margin:0 -8px;border-radius:6px;
}
summary::-webkit-details-marker{display:none}
summary::before{
  content:"";flex:0 0 auto;width:11px;height:11px;
  background:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='12'%20height='12'%20viewBox='0%200%2012%2012'%3E%3Cpath%20d='M4.5%202.5L8%206l-3.5%203.5'%20fill='none'%20stroke='%23666'%20stroke-width='1.8'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center/contain;
  transition:transform .15s ease;
}
details[open]>summary::before{transform:rotate(90deg)}
summary:hover{background:var(--soft)}
summary h2,summary h3{margin:0}
body>section{margin-top:30px}
body>section>details>summary{border-top:1px solid var(--border);margin-top:8px;padding-top:20px}
details details{margin:2px 0 2px 3px;padding-left:14px;border-left:2px solid var(--border)}
.timeline{list-style:none;margin:14px 0 4px;padding:0 0 0 18px;border-left:2px solid var(--line)}
.timeline>li{position:relative;margin:0 0 18px;padding:0 0 0 16px}
.timeline>li:last-child{margin-bottom:4px}
.timeline>li::before{content:"";position:absolute;left:-24px;top:.55em;width:10px;height:10px;border:2px solid var(--marker);border-radius:50%;background:#fff}
.timeline strong{display:block;color:var(--heading);font-weight:700;line-height:1.55}
.timeline p{margin:6px 0 0}
.timeline ul{margin:6px 0 0}
.photo{margin:12px 0}
.photo img{display:block;width:100%;max-width:100%;height:auto}
.photo figcaption{margin-top:6px;color:var(--muted);font-size:.92rem;line-height:1.55}
.photo-grid{display:grid;gap:14px}
h4+p,h4+ul{margin-top:4px}
h3+p{margin-top:6px}
@media (min-width:720px){body{padding:36px 28px 84px}}
```

---

## 8. 应用步骤（还原到任意网页）

1. 在目标 HTML 的 `<head>` 中加入视口标签：
   `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
2. 引入样式：`<link rel="stylesheet" href="reading-first.css">`，或直接把第 7 节 CSS 内联进 `<style>`。
3. 按第 5 节「结构契约」组织 HTML（一级分区用 `section>details>summary>h2`，二级项用 `section>details>summary>h3`）。
4. 用 `open` 属性控制默认展开/收起；**无需改动任何正文内容**。

---

## 9. 允许自定义的点（不影响「无装饰」原则）

- `--measure`：阅读宽度，建议 `680–780px`，窄屏勿低于 `640px`。
- `font-size` / `line-height`：调整体密度，行高不要低于 `1.7`。
- 颜色：全部中性灰白；箭头 `#666` 可改为其他中性灰，但不要用高饱和色。

## 10. 注意事项

- 本设计**依赖 `<details>/<summary>` 折叠结构**。若目标网页不用此结构：标题/正文/列表的基础排版可照常还原；但「折叠箭头」与「层级缩进」需要对应的 `details` 嵌套结构才生效。
- 坚守原则：不要加入阴影、渐变、彩色色块或装饰性图标——那会破坏「阅读优先、极简、无装饰」的统一性。
