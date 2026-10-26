// Test: cloud fallback order on the quota path (owner request 2026-10-26).
// OpenRouter (GPT-6 Luna) must be attempted BEFORE DeepSeek V4.1 Flash, the
// local Ollama path must remain the last resort, and the key must come from
// secrets_discord.php ($openrouter_api_key) or OPENROUTER_API_KEY — never git.
//
// Offline: reads the source, no Discord login. Run inside the container:
//   docker exec librarian-bot node tests/test_openrouter_fallback_order.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ragSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'rag.js'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  \u2713 ${name}`); passed++; }
    catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++; }
}

test('config declares the OpenRouter route with GPT-6 Luna as the model', () => {
    assert.ok(cfgSrc.includes("'https://openrouter.ai/api/v1/chat/completions'"));
    assert.ok(cfgSrc.includes("'openai/gpt-6-luna'"));
    assert.ok(/\$openrouter_api_key/.test(cfgSrc), 'key read from secrets_discord.php');
    assert.ok(cfgSrc.includes('process.env.OPENROUTER_API_KEY'), 'env fallback');
});

test('no OpenRouter key literal is committed', () => {
    assert.ok(!/sk-or-v1-[0-9a-f]{20,}/.test(cfgSrc + ragSrc));
});

test('rag.js tries OpenRouter before DeepSeek, and local Ollama last', () => {
    const or = ragSrc.indexOf('Calling OpenRouter (quota path');
    const ds = ragSrc.indexOf('Calling DeepSeek API (quota path');
    const ol = ragSrc.indexOf('Attempting local Ollama query');
    assert.ok(or > 0 && ds > 0 && ol > 0, 'all three attempts present');
    assert.ok(or < ds, 'OpenRouter before DeepSeek');
    assert.ok(ds < ol, 'DeepSeek before local Ollama');
});

test('DeepSeek is skipped once OpenRouter answered', () => {
    assert.ok(ragSrc.includes('if (deepseekSuccess) {\n                // OpenRouter already answered.\n            } else if (deepseekApiKey) {'));
});

test('config.js loads and exports the OpenRouter fields', () => {
    process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test_token';
    const cfg = require('../src/config');
    assert.strictEqual(cfg.OPENROUTER_MODEL, 'openai/gpt-6-luna');
    assert.strictEqual(typeof cfg.openrouterApiKey, 'string');
    assert.ok(cfg.OPENROUTER_TIMEOUT_MS > 0 && cfg.OPENROUTER_MAX_TOKENS > 0);
});

console.log(`\n=== ${passed}/${passed + failed} passed ===`);
process.exit(failed === 0 ? 0 : 1);
