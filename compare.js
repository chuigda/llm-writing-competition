const fs = require('fs');
const path = require('path');

// ============================================================
// LLM 写作比赛 — 阶段三：两两对比评阅
// ============================================================

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_DIR = path.join(__dirname, 'output');

// —— 工具函数 ——

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ 未找到 config.json，请复制 config.example.json 并填入实际配置。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadPrompt(filename) {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), 'utf-8').trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeName(name) {
  return name.replace(/[<>:"\/|?*]/g, '').replace(/\s+/g, '_').trim();
}

// —— API 调用 ——

async function callLLM(vendor, modelName, systemPrompt, userPrompt) {
  const { endpoint, apiKey } = vendor;
  const url = `${endpoint}/chat/completions`;

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.05,
    max_tokens: 4096
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 [${response.status}]: ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// —— 加载已有作品 ——

function loadEssays(config) {
  const essaysDir = path.join(OUTPUT_DIR, 'essays');
  if (!fs.existsSync(essaysDir)) {
    console.error('❌ 未找到 output/essays/ 目录，请先运行 write.js 完成写作阶段。');
    process.exit(1);
  }

  const essays = {};

  for (const model of config.models) {
    const filePath = path.join(essaysDir, `${sanitizeName(model.name)}.txt`);
    if (fs.existsSync(filePath)) {
      essays[model.id] = { name: model.name, content: fs.readFileSync(filePath, 'utf-8') };
    } else {
      console.warn(`⚠️  未找到 ${model.name} 的作品文件，跳过。`);
    }
  }

  return essays;
}

// —— 生成所有配对 ——

function generatePairs(essayIds) {
  const pairs = [];
  for (let i = 0; i < essayIds.length; i++) {
    for (let j = i + 1; j < essayIds.length; j++) {
      pairs.push([essayIds[i], essayIds[j]]);
    }
  }
  return pairs;
}

// —— 解析评分与胜者 ——

function parseScores(response) {
  // 解析两篇文章的总分
  const totalScoreRegex = /总分:\s*(\d+)/g;
  const totals = [];
  let match;
  while ((match = totalScoreRegex.exec(response)) !== null) {
    totals.push(parseInt(match[1]));
  }

  const score1 = totals.length >= 1 ? totals[0] : null;
  const score2 = totals.length >= 2 ? totals[1] : null;

  // 解析 WINNER 标记
  const winnerMatch = response.match(/WINNER:\s*([12])/i);
  let winner = winnerMatch ? parseInt(winnerMatch[1]) : null;

  // 如果没有明确 WINNER 标记，根据总分判定
  if (!winner && score1 !== null && score2 !== null) {
    if (score1 > score2) winner = 1;
    else if (score2 > score1) winner = 2;
  }

  return { score1, score2, winner };
}

// —— 两两对比评阅 ——

async function phaseCompare(config, essays, filterNames) {
  console.log('\n' + '='.repeat(60));
  console.log('🆚 两两对比评阅');
  console.log('='.repeat(60));

  const systemPrompt = loadPrompt('compare-system.xml');
  const userTemplate = loadPrompt('compare-user.xml');
  const compareDir = path.join(OUTPUT_DIR, 'comparisons');
  ensureDir(compareDir);

  const essayIds = Object.keys(essays);
  const pairs = generatePairs(essayIds);
  console.log(`📊 共 ${pairs.length} 组对比`);

  // 如果指定了模型名称，只运行匹配的评委
  const judges = filterNames.length > 0
    ? config.models.filter(m => filterNames.some(f => m.name.toLowerCase().includes(f.toLowerCase())))
    : config.models;

  if (filterNames.length > 0 && judges.length === 0) {
    console.error(`❌ 未找到匹配的模型。可用模型: ${config.models.map(m => m.name).join(', ')}`);
    process.exit(1);
  }

  // wins[essayId] = 总胜场数, totalScores[essayId] = 累计得分
  const wins = {};
  const totalScores = {};
  const matchCount = {};
  for (const id of essayIds) {
    wins[id] = 0;
    totalScores[id] = 0;
    matchCount[id] = 0;
  }

  for (const judge of judges) {
    const vendor = config.vendors[judge.vendor];
    if (!vendor) continue;

    const judgeName = sanitizeName(judge.name);
    console.log(`\n👨‍⚖️ ${judge.name} 正在对比评阅...`);

    for (const [id1, id2] of pairs) {
      const name1 = sanitizeName(essays[id1].name);
      const name2 = sanitizeName(essays[id2].name);

      const userPrompt = userTemplate
        .replace('{{ESSAY_1}}', essays[id1].content)
        .replace('{{ESSAY_2}}', essays[id2].content);

      try {
        const evaluation = await callLLM(vendor, judge.id, systemPrompt, userPrompt);
        const { score1, score2, winner } = parseScores(evaluation);

        if (winner === 1) {
          wins[id1]++;
        } else if (winner === 2) {
          wins[id2]++;
        }

        if (score1 !== null) { totalScores[id1] += score1; matchCount[id1]++; }
        if (score2 !== null) { totalScores[id2] += score2; matchCount[id2]++; }

        const filePath = path.join(compareDir, `${judgeName}_${name1}_vs_${name2}.txt`);
        fs.writeFileSync(filePath, evaluation, 'utf-8');

        const winnerName = winner === 1 ? name1 : winner === 2 ? name2 : '平局';
        const scoreStr = score1 !== null && score2 !== null ? ` (${score1} vs ${score2})` : '';
        console.log(`   ✅ ${name1} vs ${name2}${scoreStr} → 胜者: ${winnerName}`);
      } catch (err) {
        console.error(`   ❌ ${name1} vs ${name2} 对比失败: ${err.message}`);
      }

      await sleep(1000);
    }
  }

  return { wins, totalScores, matchCount };
}

// —— 输出排行榜 ——

function printLeaderboard(essays, { wins, totalScores, matchCount }) {
  console.log('\n' + '='.repeat(60));
  console.log('🏆 对比评阅排行榜');
  console.log('='.repeat(60));

  const ranking = Object.entries(wins)
    .map(([id, w]) => ({
      name: essays[id].name,
      wins: w,
      avgScore: matchCount[id] > 0 ? (totalScores[id] / matchCount[id]).toFixed(1) : '—'
    }))
    .sort((a, b) => b.wins - a.wins);

  console.log(`   ${'排名'.padEnd(4)} ${'模型'.padEnd(14)} ${'胜场'.padEnd(6)} 场均分`);
  console.log('   ' + '-'.repeat(40));
  ranking.forEach((entry, idx) => {
    console.log(`   ${String(idx + 1).padStart(2)}. ${entry.name.padEnd(14)} ${String(entry.wins).padStart(3)} 胜    ${entry.avgScore}`);
  });

  // 保存排行榜到文件
  const leaderboardPath = path.join(OUTPUT_DIR, 'comparisons', 'leaderboard.txt');
  const content = ranking.map((e, i) => `${i + 1}. ${e.name} — ${e.wins} 胜 — 场均 ${e.avgScore} 分`).join('\n');
  fs.writeFileSync(leaderboardPath, content, 'utf-8');
}

// —— 主流程 ——

async function main() {
  const filterNames = process.argv.slice(2);

  console.log('🎯 LLM 写作比赛 — 两两对比评阅');
  console.log('主题：庄子哲学\n');

  if (filterNames.length > 0) {
    console.log(`🔄 重新运行指定评委: ${filterNames.join(', ')}`);
  }

  const config = loadConfig();
  console.log(`📋 参赛模型: ${config.models.map(m => m.name).join(', ')}`);

  const essays = loadEssays(config);

  if (Object.keys(essays).length < 2) {
    console.error('\n❌ 至少需要 2 篇作品才能进行对比评阅。');
    process.exit(1);
  }

  console.log(`📄 已加载 ${Object.keys(essays).length} 篇作品`);

  const results = await phaseCompare(config, essays, filterNames);
  printLeaderboard(essays, results);

  console.log('\n✨ 对比评阅结束！结果已保存至 output/comparisons/ 目录。');
}

main().catch(err => {
  console.error('💥 脚本执行出错:', err);
  process.exit(1);
});
