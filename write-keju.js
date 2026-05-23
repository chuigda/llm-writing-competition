const fs = require('fs');
const path = require('path');

// ============================================================
// LLM 科举比赛 — 阶段一：策论
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
    max_tokens: 8192
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60 * 1000) // 5 分钟超时
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 [${response.status}]: ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// —— 阶段一：策论 ——

async function phaseWriting(config, filterNames) {
  console.log('\n' + '='.repeat(60));
  console.log('📝 阶段一：策论');
  console.log('='.repeat(60));

  const systemPrompt = loadPrompt('keju-system.xml');
  const userPrompt = loadPrompt('keju-user.txt');
  const writingDir = path.join(OUTPUT_DIR, 'essays');
  ensureDir(writingDir);

  const essays = {};

  // 如果指定了模型名称，只运行匹配的模型
  const models = filterNames.length > 0
    ? config.models.filter(m => filterNames.some(f => m.name.toLowerCase().includes(f.toLowerCase())))
    : config.models;

  if (filterNames.length > 0 && models.length === 0) {
    console.error(`❌ 未找到匹配的模型。可用模型: ${config.models.map(m => m.name).join(', ')}`);
    process.exit(1);
  }

  for (const model of models) {
    const vendor = config.vendors[model.vendor];
    if (!vendor) {
      console.error(`⚠️  模型 ${model.name} 的 vendor "${model.vendor}" 未在配置中找到，跳过。`);
      continue;
    }

    console.log(`\n🤖 ${model.name} 正在作策论...`);

    try {
      const essay = await callLLM(vendor, model.id, systemPrompt, userPrompt);
      essays[model.id] = essay;

      const filePath = path.join(writingDir, `${sanitizeName(model.name)}.txt`);
      fs.writeFileSync(filePath, essay, 'utf-8');
      console.log(`   ✅ 完成，已保存至 ${filePath}`);
    } catch (err) {
      console.error(`   ❌ 失败: ${err.message}`);
    }

    await sleep(1000);
  }

  return essays;
}

// —— 主流程 ——

async function main() {
  const filterNames = process.argv.slice(2);

  console.log('🎯 LLM 科举比赛 — 策论阶段');
  console.log('题目：论庄\n');

  if (filterNames.length > 0) {
    console.log(`🔄 重新运行指定模型: ${filterNames.join(', ')}`);
  }

  const config = loadConfig();
  console.log(`📋 应试模型: ${config.models.map(m => m.name).join(', ')}`);

  const essays = await phaseWriting(config, filterNames);

  if (Object.keys(essays).length === 0) {
    console.error('\n❌ 没有任何模型成功完成策论，科举终止。');
    process.exit(1);
  }

  console.log('\n✨ 策论阶段结束！所有文章已保存至 output/essays/ 目录。');
}

main().catch(err => {
  console.error('💥 脚本执行出错:', err);
  process.exit(1);
});
