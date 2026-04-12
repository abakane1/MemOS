// Skill Optimizer UI JavaScript
// 需要添加到 html.ts 的 <script> 标签中

// ==================== State ====================
let optimizerScanId = null;
let optimizerScanInterval = null;
let currentOptimizerTab = 'pending';
let pendingPairs = [];

// ==================== Initialization ====================
function initOptimizer() {
  loadOptimizerStats();
  loadOptimizerPending();
}

// ==================== Stats ====================
async function loadOptimizerStats() {
  try {
    const res = await fetch('/api/skill-optimizer/stats');
    const stats = await res.json();
    
    document.getElementById('statTotalPairs').textContent = stats.totalPairs;
    document.getElementById('statPending').textContent = stats.pending;
    document.getElementById('statExecuted').textContent = stats.executed;
    document.getElementById('statIgnored').textContent = stats.ignored;
    
    document.getElementById('pendingBadge').textContent = stats.pending;
  } catch (err) {
    console.error('Failed to load optimizer stats:', err);
  }
}

// ==================== Scan ====================
async function startOptimizerScan() {
  try {
    const res = await fetch('/api/skill-optimizer/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minScore: 0.7, maxCandidates: 50 })
    });
    
    const data = await res.json();
    optimizerScanId = data.scanId;
    
    // Show progress card
    document.getElementById('scanProgressCard').style.display = 'block';
    
    // Start polling
    optimizerScanInterval = setInterval(pollScanProgress, 1000);
  } catch (err) {
    alert('扫描启动失败: ' + err.message);
  }
}

async function pollScanProgress() {
  if (!optimizerScanId) return;
  
  try {
    const res = await fetch(`/api/skill-optimizer/scan/${optimizerScanId}/progress`);
    const progress = await res.json();
    
    const percent = progress.total > 0 
      ? Math.round((progress.processed / progress.total) * 100) 
      : 0;
    
    document.getElementById('scanPercent').textContent = percent + '%';
    document.getElementById('scanProgressFill').style.width = percent + '%';
    document.getElementById('scanProgressDetail').textContent = 
      `处理中: ${progress.processed}/${progress.total || '?'} 对`;
    
    if (progress.status === 'completed' || progress.status === 'error') {
      clearInterval(optimizerScanInterval);
      optimizerScanInterval = null;
      
      setTimeout(() => {
        document.getElementById('scanProgressCard').style.display = 'none';
        loadOptimizerStats();
        loadOptimizerPending();
      }, 1500);
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// ==================== Pending Pairs ====================
async function loadOptimizerPending() {
  try {
    const res = await fetch('/api/skill-optimizer/pending');
    const data = await res.json();
    pendingPairs = data.pairs || [];
    
    renderPendingPairs(pendingPairs);
  } catch (err) {
    console.error('Failed to load pending pairs:', err);
  }
}

function renderPendingPairs(pairs) {
  const container = document.getElementById('optimizerPendingList');
  
  if (!pairs || pairs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>暂无待处理的相似技能对</p>
        <button class="btn btn-primary" onclick="startOptimizerScan()">开始扫描</button>
      </div>
    `;
    return;
  }
  
  // Apply filters
  const decisionFilter = document.getElementById('decisionFilter')?.value;
  const scoreFilter = document.getElementById('scoreFilter')?.value;
  
  let filtered = pairs;
  if (decisionFilter) {
    filtered = filtered.filter(p => p.decision?.type === decisionFilter);
  }
  if (scoreFilter) {
    filtered = filtered.filter(p => p.combinedScore >= parseFloat(scoreFilter));
  }
  
  container.innerHTML = filtered.map(pair => `
    <div class="optimizer-pair-card" data-id="${pair.id}">
      <div class="pair-header">
        <div class="pair-similarity">
          <span>相似度</span>
          <span class="similarity-score ${getSimilarityClass(pair.combinedScore)}">
            ${Math.round(pair.combinedScore * 100)}%
          </span>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="showComparisonDetail('${pair.id}')">
          查看详情
        </button>
      </div>
      
      <div class="pair-skills">
        <div class="skill-card-small">
          <div class="skill-name">${escapeHtml(pair.skillA.name)}</div>
          <div class="skill-meta">${escapeHtml(pair.skillA.description?.slice(0, 60) || '')}...</div>
          <div class="skill-quality">
            <span>质量: ${pair.skillA.qualityScore || 'N/A'}</span>
            <span>v${pair.skillA.version}</span>
          </div>
        </div>
        <div class="pair-arrow">⇄</div>
        <div class="skill-card-small">
          <div class="skill-name">${escapeHtml(pair.skillB.name)}</div>
          <div class="skill-meta">${escapeHtml(pair.skillB.description?.slice(0, 60) || '')}...</div>
          <div class="skill-quality">
            <span>质量: ${pair.skillB.qualityScore || 'N/A'}</span>
            <span>v${pair.skillB.version}</span>
          </div>
        </div>
      </div>
      
      ${pair.decision ? `
        <div class="pair-decision">
          <span class="decision-icon">${getDecisionIcon(pair.decision.type)}</span>
          <div class="decision-content">
            <div class="decision-type">${getDecisionLabel(pair.decision.type)} (置信度 ${Math.round(pair.decision.confidence * 100)}%)</div>
            <div class="decision-reason">${escapeHtml(pair.decision.reason)}</div>
          </div>
        </div>
      ` : ''}
      
      <div class="pair-actions">
        ${pair.decision?.type === 'MERGE' ? `
          <button class="btn btn-primary" onclick="executeDecision('${pair.id}')">执行合并</button>
        ` : pair.decision?.type === 'UPGRADE' ? `
          <button class="btn btn-primary" onclick="executeDecision('${pair.id}')">执行升级</button>
        ` : pair.decision?.type === 'DISCARD' ? `
          <button class="btn btn-danger" onclick="executeDecision('${pair.id}')">执行删除</button>
        ` : ''}
        <button class="btn btn-ghost" onclick="ignoreSuggestion('${pair.id}')">忽略</button>
      </div>
    </div>
  `).join('');
}

function filterPendingPairs() {
  renderPendingPairs(pendingPairs);
}

function getSimilarityClass(score) {
  if (score >= 0.9) return 'high';
  if (score >= 0.8) return 'medium';
  return 'low';
}

function getDecisionIcon(type) {
  const icons = {
    'MERGE': '🔀',
    'UPGRADE': '⬆️',
    'DISCARD': '🗑️',
    'KEEP_BOTH': '✓'
  };
  return icons[type] || '💡';
}

function getDecisionLabel(type) {
  const labels = {
    'MERGE': '建议合并',
    'UPGRADE': '建议升级',
    'DISCARD': '建议删除',
    'KEEP_BOTH': '建议保留两者'
  };
  return labels[type] || type;
}

// ==================== Actions ====================
async function executeDecision(similarityId) {
  if (!confirm('确定要执行此操作吗？此操作不可撤销。')) return;
  
  try {
    const res = await fetch('/api/skill-optimizer/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ similarityId })
    });
    
    const result = await res.json();
    
    if (result.success) {
      alert('操作成功: ' + result.result);
      loadOptimizerStats();
      loadOptimizerPending();
    } else {
      alert('操作失败: ' + result.error);
    }
  } catch (err) {
    alert('请求失败: ' + err.message);
  }
}

async function ignoreSuggestion(similarityId) {
  if (!confirm('确定要忽略此建议吗？')) return;
  
  try {
    await fetch('/api/skill-optimizer/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ similarityId })
    });
    
    loadOptimizerStats();
    loadOptimizerPending();
  } catch (err) {
    console.error('Ignore failed:', err);
  }
}

// ==================== Comparison Detail Modal ====================
function showComparisonDetail(pairId) {
  const pair = pendingPairs.find(p => p.id === pairId);
  if (!pair) return;
  
  const modalBody = document.getElementById('comparisonModalBody');
  const modalFooter = document.getElementById('comparisonModalFooter');
  
  modalBody.innerHTML = `
    <div class="comparison-detail">
      <div class="comparison-skills">
        <div class="comparison-skill">
          <h4>${escapeHtml(pair.skillA.name)}</h4>
          <p>${escapeHtml(pair.skillA.description || '')}</p>
          <div class="skill-meta-tags">
            <span class="tag">质量: ${pair.skillA.qualityScore || 'N/A'}</span>
            <span class="tag">版本: v${pair.skillA.version}</span>
            <span class="tag">状态: ${pair.skillA.status}</span>
          </div>
        </div>
        <div class="comparison-vs">VS</div>
        <div class="comparison-skill">
          <h4>${escapeHtml(pair.skillB.name)}</h4>
          <p>${escapeHtml(pair.skillB.description || '')}</p>
          <div class="skill-meta-tags">
            <span class="tag">质量: ${pair.skillB.qualityScore || 'N/A'}</span>
            <span class="tag">版本: v${pair.skillB.version}</span>
            <span class="tag">状态: ${pair.skillB.status}</span>
          </div>
        </div>
      </div>
      
      ${pair.decision ? `
        <div class="comparison-decision-detail">
          <h4>💡 AI 建议: ${getDecisionLabel(pair.decision.type)}</h4>
          <p><strong>置信度:</strong> ${Math.round(pair.decision.confidence * 100)}%</p>
          <p><strong>理由:</strong> ${escapeHtml(pair.decision.reason)}</p>
          ${pair.decision.strategy ? `<p><strong>策略:</strong> ${escapeHtml(pair.decision.strategy)}</p>` : ''}
        </div>
      ` : ''}
      
      <div class="comparison-scores">
        <h4>相似度分析</h4>
        <div class="score-bar">
          <span>向量相似度</span>
          <div class="progress-bar"><div class="progress-fill" style="width:${pair.vectorScore * 100}%"></div></div>
          <span>${Math.round(pair.vectorScore * 100)}%</span>
        </div>
        <div class="score-bar">
          <span>文本匹配度</span>
          <div class="progress-bar"><div class="progress-fill" style="width:${pair.ftsScore * 100}%"></div></div>
          <span>${Math.round(pair.ftsScore * 100)}%</span>
        </div>
        <div class="score-bar">
          <span>综合得分</span>
          <div class="progress-bar"><div class="progress-fill primary" style="width:${pair.combinedScore * 100}%"></div></div>
          <span>${Math.round(pair.combinedScore * 100)}%</span>
        </div>
      </div>
    </div>
  `;
  
  modalFooter.innerHTML = `
    ${pair.decision?.type === 'MERGE' ? `
      <button class="btn btn-primary" onclick="executeDecision('${pair.id}'); closeComparisonModal();">执行合并</button>
    ` : pair.decision?.type === 'UPGRADE' ? `
      <button class="btn btn-primary" onclick="executeDecision('${pair.id}'); closeComparisonModal();">执行升级</button>
    ` : pair.decision?.type === 'DISCARD' ? `
      <button class="btn btn-danger" onclick="executeDecision('${pair.id}'); closeComparisonModal();">执行删除</button>
    ` : ''}
    <button class="btn btn-ghost" onclick="ignoreSuggestion('${pair.id}'); closeComparisonModal();">忽略</button>
    <button class="btn btn-secondary" onclick="closeComparisonModal()">关闭</button>
  `;
  
  document.getElementById('comparisonModal').classList.add('show');
}

function closeComparisonModal(event) {
  if (event && event.target !== document.getElementById('comparisonModal')) return;
  document.getElementById('comparisonModal').classList.remove('show');
}

// ==================== Tab Switching ====================
function switchOptimizerTab(tab) {
  currentOptimizerTab = tab;
  
  // Update tab buttons
  document.querySelectorAll('.optimizer-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  
  // Update tab content
  document.querySelectorAll('.optimizer-tab-content').forEach(el => {
    el.classList.toggle('active', el.id === tab + 'Tab');
  });
  
  // Load content
  if (tab === 'pending') {
    loadOptimizerPending();
  } else if (tab === 'cross-agent') {
    loadCrossAgentStats();
  } else if (tab === 'logs') {
    loadOptimizerLogs();
  }
}

// ==================== Cross Agent ====================
async function loadCrossAgentStats() {
  try {
    const res = await fetch('/api/skill-optimizer/cross-agent-stats');
    const data = await res.json();
    
    const container = document.getElementById('crossAgentStats');
    const totalDup = data.agents.reduce((sum, a) => sum + a.duplicatesWithCurrent, 0);
    document.getElementById('crossAgentBadge').textContent = totalDup;
    
    container.innerHTML = data.agents.map(agent => `
      <div class="agent-stat-card">
        <span class="agent-icon">🤖</span>
        <div class="agent-info">
          <div class="agent-name">${agent.name}</div>
          <div class="agent-count">${agent.skillCount} public skills · ${agent.duplicatesWithCurrent} 重复</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load cross-agent stats:', err);
  }
}

async function scanCrossAgent() {
  try {
    const res = await fetch('/api/skill-optimizer/cross-agent-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: ['main', 'kimi', 'kimi-coding'] })
    });
    
    const data = await res.json();
    renderCrossAgentDuplicates(data.duplicates);
  } catch (err) {
    alert('跨 Agent 扫描失败: ' + err.message);
  }
}

function renderCrossAgentDuplicates(duplicates) {
  const container = document.getElementById('crossAgentList');
  
  if (!duplicates || duplicates.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌐</div>
        <p>未发现跨 Agent 重复技能</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = duplicates.map(dup => `
    <div class="optimizer-pair-card">
      <div class="pair-header">
        <div class="pair-similarity">
          <span>相似度</span>
          <span class="similarity-score ${getSimilarityClass(dup.similarityScore)}">
            ${Math.round(dup.similarityScore * 100)}%
          </span>
        </div>
        <span class="agent-badge">${dup.remoteAgent}</span>
      </div>
      <div class="pair-skills">
        <div class="skill-card-small">
          <div class="skill-name">${escapeHtml(dup.localSkillName)}</div>
          <div class="skill-meta">当前 Agent</div>
        </div>
        <div class="pair-arrow">⇄</div>
        <div class="skill-card-small">
          <div class="skill-name">${escapeHtml(dup.remoteSkillName)}</div>
          <div class="skill-meta">${dup.remoteAgent} Agent</div>
        </div>
      </div>
    </div>
  `).join('');
}

// ==================== Logs ====================
async function loadOptimizerLogs() {
  try {
    const res = await fetch('/api/skill-optimizer/logs?limit=20');
    const data = await res.json();
    
    const container = document.getElementById('optimizerLogsList');
    
    if (!data.logs || data.logs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>暂无操作记录</p>
        </div>
      `;
      return;
    }
    
    container.innerHTML = data.logs.map(log => `
      <div class="log-item">
        <div class="log-header">
          <span class="log-action ${log.action}">${getActionLabel(log.action)}</span>
          <span class="log-time">${new Date(log.createdAt).toLocaleString()}</span>
        </div>
        <div class="log-skills">${log.skillNames?.join(', ') || ''}</div>
        ${log.result ? `<div class="log-result">${escapeHtml(log.result)}</div>` : ''}
        ${log.error ? `<div class="log-error">${escapeHtml(log.error)}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

function getActionLabel(action) {
  const labels = {
    'merge': '合并',
    'upgrade': '升级',
    'discard': '删除',
    'ignore': '忽略'
  };
  return labels[action] || action;
}

// ==================== Utilities ====================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize when view is shown
function onOptimizerViewShow() {
  initOptimizer();
}
