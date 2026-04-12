# Optimizer UI 集成指南

## 需要修改的文件

### 1. src/viewer/html.ts

#### A. 添加 CSS 样式
在 `<style>` 标签内（约第 12 行之后）添加：

```typescript
// 读取 optimizer-ui.css 文件内容并插入
// 或者直接将 optimizer-ui.css 的内容复制粘贴到 <style> 中
```

#### B. 添加 Tab 按钮
在 nav-tabs 中（约第 800 行附近）添加 Optimizer tab：

```html
<button class="tab" data-view="optimizer" onclick="switchView('optimizer')">🎯 Optimizer</button>
```

#### C. 添加 View 容器
在 skills-view 之后（约第 922 行之后）添加：

```html
<!-- Optimizer View -->
<div class="optimizer-view" id="optimizerView">
  <!-- 复制 optimizer-ui.html 的内容到这里 -->
</div>
```

#### D. 添加 JavaScript
在 `<script>` 标签内（文件末尾）添加：

```javascript
// 复制 optimizer-ui.js 的内容到这里
```

#### E. 修改 switchView 函数
在 switchView 函数中添加 optimizer 分支：

```javascript
function switchView(view) {
  // ... 现有代码 ...
  
  // 隐藏所有 view
  document.querySelectorAll('.feed-wrap, .tasks-view, .skills-view, .optimizer-view').forEach(el => {
    el.classList.remove('show');
  });
  
  // 显示选中的 view
  if (view === 'optimizer') {
    document.getElementById('optimizerView').classList.add('show');
    onOptimizerViewShow();
  }
  // ... 其他分支 ...
}
```

---

## 快速集成脚本

运行以下命令自动集成：

```bash
cd /Users/zuliangzhao/Projects/skill-library/memos-local-dev

# 备份原文件
cp src/viewer/html.ts src/viewer/html.ts.backup

# 使用 Node.js 脚本自动集成
node scripts/integrate-optimizer-ui.js
```

---

## 手动集成步骤

### Step 1: 准备 CSS

```bash
# 将 CSS 内容读取为变量
css_content=$(cat src/skill-optimizer/optimizer-ui.css)

# 将 CSS 插入到 html.ts 的 <style> 标签中
# 在 line 72 (body{...}) 之前插入
```

### Step 2: 添加 HTML

在 skills-view 闭合标签 `</div>` 之后，添加 optimizer-view 的 HTML。

### Step 3: 添加 JS

在 `</script>` 结束标签之前，添加 optimizer-ui.js 的内容。

### Step 4: 修改 switchView

找到 `switchView` 函数，添加 optimizer 的处理逻辑。

---

## 验证集成

集成完成后，访问 Memory Viewer (http://127.0.0.1:18799)，应该能看到：

1. 顶部导航栏有 "🎯 Optimizer" Tab
2. 点击后显示 Optimizer 界面
3. 统计卡片显示正确
4. 点击"开始扫描"能正常工作

---

## 快速 Patch 文件

为了简化集成，我创建了一个完整的 patch 文件：

```bash
# 应用 patch
cd /Users/zuliangzhao/Projects/skill-library/memos-local-dev
git apply src/skill-optimizer/html-optimizer.patch
```

如果没有 git，可以手动应用 `html-optimizer.patch` 中的更改。
