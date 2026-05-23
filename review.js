const fs = require('fs');
const path = require('path');

// ============================================================
// LLM 写作比赛 — 阶段二：互评
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
    temperature: 0.7,
    max_tokens: 4096
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
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
      essays[model.id] = fs.readFileSync(filePath, 'utf-8');
    } else {
      console.warn(`⚠️  未找到 ${model.name} 的作品文件，跳过。`);
    }
  }

  return essays;
}

// —— 阶段二：评阅 ——

async function phaseJudging(config, essays, filterNames) {
  console.log('\n' + '='.repeat(60));
  console.log('⚖️  阶段二：互评');
  console.log('='.repeat(60));

  const systemPrompt = loadPrompt('judging-system.xml');
  const userTemplate = loadPrompt('judging-user.xml');
  const judgingDir = path.join(OUTPUT_DIR, 'judgments');
  ensureDir(judgingDir);

  const scores = {};

  // 如果指定了模型名称，只运行匹配的评委
  const judges = filterNames.length > 0
    ? config.models.filter(m => filterNames.some(f => m.name.toLowerCase().includes(f.toLowerCase())))
    : config.models;

  if (filterNames.length > 0 && judges.length === 0) {
    console.error(`❌ 未找到匹配的模型。可用模型: ${config.models.map(m => m.name).join(', ')}`);
    process.exit(1);
  }

  for (const judge of judges) {
    const vendor = config.vendors[judge.vendor];
    if (!vendor) continue;

    scores[judge.id] = {};
    console.log(`\n👨‍⚖️ ${judge.name} 正在评阅...`);

    for (const [essayId, essayContent] of Object.entries(essays)) {
      const essayModel = config.models.find(m => m.id === essayId);
      const essayName = essayModel ? sanitizeName(essayModel.name) : essayId;
      const userPrompt = userTemplate.replace('{{ESSAY_CONTENT}}', essayContent);

      try {
        const evaluation = await callLLM(vendor, judge.id, systemPrompt, userPrompt);
        scores[judge.id][essayId] = evaluation;

        const filePath = path.join(judgingDir, `${sanitizeName(judge.name)}_reviews_${essayName}.txt`);
        fs.writeFileSync(filePath, evaluation, 'utf-8');
        console.log(`   ✅ ${judge.name} → 作品 ${essayName} 评阅完成`);
      } catch (err) {
        console.error(`   ❌ ${judge.name} → 作品 ${essayId} 评阅失败: ${err.message}`);
      }

      await sleep(1000);
    }
  }

  return scores;
}

// —— 主流程 ——

async function main() {
  const filterNames = process.argv.slice(2);

  console.log('🎯 LLM 写作比赛 — 评阅阶段');
  console.log('主题：庄子哲学\n');

  if (filterNames.length > 0) {
    console.log(`🔄 重新运行指定评委: ${filterNames.join(', ')}`);
  }

  const config = loadConfig();
  console.log(`📋 参赛模型: ${config.models.map(m => m.name).join(', ')}`);

  // 从文件加载写作阶段的作品
  const essays = loadEssays(config);

  if (Object.keys(essays).length === 0) {
    console.error('\n❌ 没有找到任何作品，请先运行 write.js 完成写作阶段。');
    process.exit(1);
  }

  console.log(`📄 已加载 ${Object.keys(essays).length} 篇作品`);

  await phaseJudging(config, essays, filterNames);

  console.log('\n✨ 评阅阶段结束！所有评阅结果已保存至 output/judgments/ 目录。');
}

main().catch(err => {
  console.error('💥 脚本执行出错:', err);
  process.exit(1);
});
