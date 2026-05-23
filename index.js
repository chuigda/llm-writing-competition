const fs = require('fs');
const path = require('path');

// ============================================================
// LLM 写作比赛自动驱动脚本
// 阶段一：写作  阶段二：互评
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

// —— 阶段一：写作 ——

async function phaseWriting(config) {
  console.log('\n' + '='.repeat(60));
  console.log('📝 阶段一：写作');
  console.log('='.repeat(60));

  const systemPrompt = loadPrompt('writing-system.xml');
  const userPrompt = loadPrompt('writing-user.txt');
  const writingDir = path.join(OUTPUT_DIR, 'essays');
  ensureDir(writingDir);

  const essays = {};

  for (const model of config.models) {
    const vendor = config.vendors[model.vendor];
    if (!vendor) {
      console.error(`⚠️  模型 ${model.name} 的 vendor "${model.vendor}" 未在配置中找到，跳过。`);
      continue;
    }

    console.log(`\n🤖 ${model.name} 正在写作...`);

    try {
      const essay = await callLLM(vendor, model.modelName, systemPrompt, userPrompt);
      essays[model.id] = essay;

      // 保存到文件
      const filePath = path.join(writingDir, `${model.id}.txt`);
      fs.writeFileSync(filePath, essay, 'utf-8');
      console.log(`   ✅ 完成，已保存至 ${filePath}`);
    } catch (err) {
      console.error(`   ❌ 失败: ${err.message}`);
    }

    // 请求间隔，避免限流
    await sleep(1000);
  }

  return essays;
}

// —— 阶段二：评阅 ——

async function phaseJudging(config, essays) {
  console.log('\n' + '='.repeat(60));
  console.log('⚖️  阶段二：互评');
  console.log('='.repeat(60));

  const systemPrompt = loadPrompt('judging-system.xml');
  const userTemplate = loadPrompt('judging-user.xml');
  const judgingDir = path.join(OUTPUT_DIR, 'judgments');
  ensureDir(judgingDir);

  // scores[judge_id][essay_id] = { dimensions, total }
  const scores = {};

  for (const judge of config.models) {
    const vendor = config.vendors[judge.vendor];
    if (!vendor) continue;

    scores[judge.id] = {};
    console.log(`\n👨‍⚖️ ${judge.name} 正在评阅...`);

    for (const [essayId, essayContent] of Object.entries(essays)) {
      // 盲评：不透露作者信息
      const userPrompt = userTemplate.replace('{{ESSAY_CONTENT}}', essayContent);

      try {
        const evaluation = await callLLM(vendor, judge.modelName, systemPrompt, userPrompt);
        scores[judge.id][essayId] = evaluation;

        // 保存评阅结果
        const filePath = path.join(judgingDir, `${judge.id}_reviews_${essayId}.txt`);
        fs.writeFileSync(filePath, evaluation, 'utf-8');
        console.log(`   ✅ ${judge.name} → 作品 ${essayId} 评阅完成`);
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
  console.log('🎯 LLM 写作比赛 — 自动驱动脚本');
  console.log('主题：庄子哲学\n');

  const config = loadConfig();
  console.log(`📋 参赛模型: ${config.models.map(m => m.name).join(', ')}`);

  // 阶段一：写作
  const essays = await phaseWriting(config);

  if (Object.keys(essays).length === 0) {
    console.error('\n❌ 没有任何模型成功完成写作，比赛终止。');
    process.exit(1);
  }

  // 阶段二：评阅
  await phaseJudging(config, essays);

  console.log('\n✨ 比赛结束！所有评阅结果已保存至 output/judgments/ 目录。');
}

main().catch(err => {
  console.error('💥 脚本执行出错:', err);
  process.exit(1);
});
