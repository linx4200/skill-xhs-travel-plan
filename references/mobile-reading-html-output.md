# 移动端阅读 HTML 输出规范

本规范用于把旅游攻略输出为适合手机阅读的两级静态 HTML。视觉语言沿用 `reading-first-design-spec.md` 和 `reading-first.css`：阅读优先、结构清楚、中性色、无阴影、无渐变、无装饰性图标。

生成 HTML 攻略时必须读取本文件。若本文件与 `SKILL.md` 的内容结构要求冲突，以本文件的 HTML 页面结构为准；资料来源、信息整合和禁止事项仍以 `SKILL.md` 为准。

## 输出文件

在用户指定的输出目录保存完整静态文件；如果用户未指定输出目录，默认保存在当前目录。输出目录中生成一组静态文件：

- `index.html`：首页总览。
- `day-01.html`, `day-02.html`, ...：每天一个详情页。
- `city-01.html`, `city-02.html`, ...：每个通过“独立增量价值”判断的城市一个详情页。
- `reading-first.css`：所有页面共同外链的样式文件。
- `assets/photos/景点名/`：从输入材料文件夹复制而来的本地景点照片；没有照片时不创建空目录。

所有页面都使用外链 CSS：

```html
<link rel="stylesheet" href="reading-first.css">
```

每个 HTML 文件的 `<head>` 必须包含：

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

不要引入 JavaScript、外部字体、图标库、地图 iframe 或远程资源。图片只能使用用户输入材料文件夹中的本地照片，不能联网补图或引用远程图片链接。

## 页面层级

本产物是“两级页面结构”：

- 一级：`index.html`，只负责整体总览和跨天汇总。
- 二级：`day-XX.html` 与 `city-XX.html`，承载具体详情。

首页不要展开长篇景点详情。原“景点汇总”必须按天拆分到对应的 `day-XX.html`，不再作为首页集中章节。

## 首页结构

`index.html` 按以下顺序输出：

1. `h1`：攻略标题。
2. 每日行程安排。
3. 城市汇总。
4. 整体注意事情。
5. 出行前确认清单。
6. 生成时间说明。

建议骨架：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>攻略标题</title>
  <link rel="stylesheet" href="reading-first.css">
</head>
<body>
  <h1>攻略标题</h1>

  <section>
    <details open>
      <summary><h2>每日行程安排</h2></summary>
      <ol class="timeline">
        <li>
          <a href="day-01.html"><strong>Day 1｜日期｜城市</strong></a>
          <p>当天路线顺序和一句关键摘要，不写景点长详情，也不放补充列表。</p>
        </li>
      </ol>
    </details>
  </section>

  <section>
    <details open>
      <summary><h2>城市汇总</h2></summary>
      <ul>
        <li><a href="city-01.html">城市名</a>：1 句话说明它在本次行程里的作用和最重要的城市级信息。</li>
      </ul>
    </details>
  </section>

  <section>
    <details open>
      <summary><h2>整体注意事情</h2></summary>
      <h3>交通与住宿</h3>
      <ul>
        <li>跨天共用的执行提醒。</li>
      </ul>
    </details>
  </section>

  <section>
    <details open>
      <summary><h2>出行前确认清单</h2></summary>
      <ul>
        <li>真正需要用户在出发前确认或预约的事项。</li>
      </ul>
    </details>
  </section>

  <p class="meta">生成时间：YYYY-MM-DD HH:mm</p>
</body>
</html>
```

首页不输出独立的 `nav.page-nav`。首页“每日行程安排”应使用 `ol.timeline`。每个 `li` 是一天，必须在标题处链接到对应 `day-XX.html`，且只包含链接标题和一句摘要；不要在首页 Day 节点里输出 `ul` 详情列表。

首页最后必须输出一行小字说明 HTML 生成时间，使用 `<p class="meta">生成时间：YYYY-MM-DD HH:mm</p>`。时间填写生成 HTML 时的本地时间；只在 `index.html` 输出，不需要在 `day-XX.html` 或 `city-XX.html` 重复。

## 每日详情页结构

每个 `day-XX.html` 按以下顺序输出：

1. `h1`：`Day X｜日期｜城市/区域`。
2. 顶部导航：返回首页、上一天、下一天。
3. 当日行程安排。
4. 当日景点详细信息。
5. 当日注意事项/确认事项。
6. 底部导航：返回首页、上一天、下一天。

建议骨架：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Day 1｜日期｜城市</title>
  <link rel="stylesheet" href="reading-first.css">
</head>
<body>
  <h1>Day 1｜日期｜城市</h1>

  <nav class="page-nav" aria-label="页面导航">
    <a href="index.html">返回首页</a>
    <a href="day-02.html">下一天</a>
  </nav>

  <section>
    <details open>
      <summary><h2>当日行程安排</h2></summary>
      <ol class="timeline">
        <li>
          <strong>上午｜地点 A</strong>
          <p>游玩顺序、到达方式、停留重点和当天执行提醒。</p>
        </li>
        <li>
          <strong>下午｜地点 B</strong>
          <p>继续当天路线。</p>
        </li>
      </ol>
    </details>
  </section>

  <section>
    <details open>
      <summary><h2>当日景点详细信息</h2></summary>
      <section>
        <details open>
          <summary><h3>景点名称</h3></summary>
          <p>一句话定位。</p>
          <h4>看点</h4>
          <ul>
            <li>值得去的理由。</li>
          </ul>
          <!-- 仅当该景点有对应本地照片时输出照片块；无照片时整块省略。 -->
          <h4>照片</h4>
          <figure class="photo">
            <img src="assets/photos/景点名称/01-入口.jpg" alt="景点名称入口" loading="lazy">
            <figcaption>景点名称入口。</figcaption>
          </figure>
          <h4>交通与实用信息</h4>
          <ul>
            <li>入口、停车、购票、排队等。</li>
          </ul>
          <h4>注意事项</h4>
          <ul>
            <li>安全、天气、体力、预约等。</li>
          </ul>
        </details>
      </section>
    </details>
  </section>

  <section>
    <details open>
      <summary><h2>当日注意事项/确认事项</h2></summary>
      <ul>
        <li>只写当天特有、需要执行的提醒。</li>
      </ul>
    </details>
  </section>

  <nav class="page-nav" aria-label="页面导航">
    <a href="index.html">返回首页</a>
    <a href="day-02.html">下一天</a>
  </nav>
</body>
</html>
```

若同一景点跨多天出现，景点详情放在首次实际游玩的 `day-XX.html`。后续页面只写一句交叉引用，例如“详情见 Day 2｜景点名称”，除非后续当天有不同玩法、不同入口、不同路线或新的执行风险。

每日详情页中的照片只放在“当日景点详细信息”的对应景点下面。首页不放照片，城市详情页不复制每日景点照片。

## 城市详情页结构

只有通过 [info-rules.md](info-rules.md) 和 [structured-generation-workflow.md](structured-generation-workflow.md) 中“独立增量价值”判断的城市才生成 `city-XX.html`。首页城市汇总只放城市列表和一句话摘要，具体内容放到城市详情页。

每个 `city-XX.html` 按以下顺序输出：

1. `h1`：城市名。
2. 顶部导航：返回首页。
3. 城市概览。
4. 备选景点库。
5. 美食。
6. 住宿建议。
7. 城市交通。
8. 购物或伴手礼。
9. 城市级注意事项。

上述小节没有实质材料时直接删除，不要保留空标题。

建议骨架：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>城市名</title>
  <link rel="stylesheet" href="reading-first.css">
</head>
<body>
<h1>城市名</h1>
<nav class="page-nav" aria-label="页面导航">
  <a href="index.html">返回首页</a>
</nav>

<section>
  <details open>
    <summary><h2>城市概览</h2></summary>
    <p>1-3 句话说明这个城市在本次行程中的角色。</p>
  </details>
</section>

<section>
  <details open>
    <summary><h2>备选景点库</h2></summary>
    <section>
      <details>
        <summary><h3>景点名称</h3></summary>
        <p>只介绍景点本身，不评价它是否应该加入当天行程。</p>
      </details>
    </section>
  </details>
</section>
</body>
</html>
```

城市详情页不要重复已经在每日景点详情中完整写过的景点。确实需要提到时，使用短句交叉引用，不复制全文。

## 照片规则

照片是每日景点详情的辅助信息，不是首页视觉内容。

### 来源

只使用用户提供的本地照片。推荐用户在输入材料文件夹中按景点组织：

```text
输入材料文件夹/
  photos/
    五尺道景区/
      01-入口.jpg
      02-栈道.jpg
    兴文石海/
      01-主景观.jpg
```

不要联网搜索图片，不要使用远程图片链接，不要从其他景点借图，不要使用占位图。

### 输出目录

生成 HTML 时，把会用到的照片复制到输出目录：

```text
输出目录/
  index.html
  day-01.html
  day-02.html
  city-01.html
  reading-first.css
  assets/photos/
    五尺道景区/
      01-入口.jpg
      02-栈道.jpg
```

输出目录中的照片按景点名组织，不按 Day 组织。景点是素材归属，Day 只是本次路线编排。

### 展示位置

- 首页不展示照片。
- 城市详情页不复制每日景点照片。
- 每日详情页中，照片只放在“当日景点详细信息”的对应景点下面。
- 入口、停车场、观景点、路线提示等执行型照片，也放在对应景点下。

### 数量与跳过

- 每个景点默认展示 1-3 张相关照片。
- 如果某个景点没有对应照片，直接跳过照片区域。
- 不要生成“照片”“图片”“材料未提供照片”等空标题或说明。

### HTML 结构

单张照片：

```html
<figure class="photo">
  <img src="assets/photos/五尺道景区/01-入口.jpg" alt="五尺道景区入口" loading="lazy">
  <figcaption>五尺道景区入口。</figcaption>
</figure>
```

多张照片：

```html
<div class="photo-grid">
  <figure class="photo">
    <img src="assets/photos/五尺道景区/01-入口.jpg" alt="五尺道景区入口" loading="lazy">
    <figcaption>五尺道景区入口。</figcaption>
  </figure>
  <figure class="photo">
    <img src="assets/photos/五尺道景区/02-栈道.jpg" alt="五尺道景区栈道" loading="lazy">
    <figcaption>五尺道景区栈道。</figcaption>
  </figure>
</div>
```

`alt` 必须说明照片内容，不能只写“图片”或“照片”。`figcaption` 保持简短；没有必要说明的照片可省略 `figcaption`，但不要省略 `alt`。

照片样式由 `reading-first.css` 统一处理：`figure.photo img` 必须按正文栏宽度响应式缩放，不允许使用内联宽高或额外 class 临时修正；`.photo-grid` 只用于多张照片之间的竖向间距，不做轮播、瀑布流、多列画廊或复杂交互。

## 折叠状态

- 首页所有一级 section 默认 `open`。
- 首页城市汇总中的列表不使用嵌套长详情，只链接到城市详情页。
- 每日详情页的“当日行程安排”“当日景点详细信息”“当日注意事项/确认事项”默认 `open`。
- 景点详情默认 `open`，除非当天景点过多、页面过长；过长时可以让次要景点默认收起。
- 城市详情页一级 section 默认 `open`，城市内的备选景点可默认收起。

## Timeline 规则

使用 `ol.timeline` 表达顺序，适用于：

- 首页的每日行程安排：一个节点代表一天。
- 每日详情页的当日行程安排：一个节点代表一个时间段或一个路线停留点。

Timeline 内容必须是行程执行信息，不要把城市概览、景点长详情、整体注意事项塞进 timeline。

Timeline 节点建议结构：

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

不要在 timeline 中安排早餐、午餐、晚餐、用餐时间或餐厅停留点，除非用户明确要求安排餐饮。

## 页面互链

- 首页不输出独立的 `nav.page-nav`。
- 首页必须在“每日行程安排”的 Day 标题处链接到每个 `day-XX.html`。
- 首页必须在“城市汇总”列表中链接到每个已生成的 `city-XX.html`。
- 每日详情页顶部和底部都必须有 `返回首页` 链接。
- 每日详情页应尽量提供 `上一天` / `下一天` 链接；第一天没有上一天，最后一天没有下一天。
- 城市详情页必须有 `返回首页` 链接。

链接文字要短、清楚，不要写成按钮，不要加图标。

## 内容去重

- 首页只写摘要和内容内链接，不写独立页面导航，不写景点详情。
- 首页每日行程 timeline 的每个 Day 节点只写链接标题和一句摘要，不放 `ul` 详情列表。
- 首页不放照片。
- 首页末尾保留一行生成时间小字，除此之外不输出资料来源说明或生成过程说明。
- 每日详情页写当天景点详情，不写城市级完整汇总。
- 城市详情页写城市级增量信息，不复制每日景点详情。
- 城市详情页不复制每日景点照片。
- 跨天通用准备事项放首页“整体注意事情”或“出行前确认清单”；当天特有事项放对应 `day-XX.html`。
- 同一条材料信息只出现在最适合执行的位置。需要跨页引用时用短链接或短句，不复制整段内容。

## 质量检查

输出前检查：

- 是否生成了 `index.html` 和每一天对应的 `day-XX.html`。
- 是否只为通过“独立增量价值”判断的城市生成 `city-XX.html`。
- 首页是否没有集中“景点汇总”长章节。
- 原景点汇总是否已按天拆入每日详情页。
- 首页是否没有独立的 `nav.page-nav`。
- 首页末尾是否有一行 `生成时间：YYYY-MM-DD HH:mm` 小字。
- 首页每日行程安排和每日详情页当日行程安排是否使用 `ol.timeline`；首页 Day 节点是否没有 `ul` 详情列表。
- 照片是否只来自用户输入材料文件夹，并复制到 `assets/photos/景点名/`。
- 有照片的景点是否在对应每日详情页展示；无照片的景点是否没有生成空照片位。
- 所有页面是否都引入 `reading-first.css`。
- 页面互链是否完整，文件名是否一致。
- 移动端阅读是否不依赖多栏、悬浮控件、JS 或远程资源。
